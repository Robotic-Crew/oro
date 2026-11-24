# oro-plugin-intrinsic

ORO plugin for skill-based robot cells such as [Intrinsic Core](https://github.com/intrinsic-ai/intrinsic-core).
It adds three robot dashboard widgets:

| Widget | Type | Shows |
|---|---|---|
| **Execution** | `intrinsic:execution` | The behavior tree being executed, the state of each node, the cycle status and the error |
| **Cycle Timeline** | `intrinsic:cycleTimeline` | A Gantt of the latest cycles, one color per step, with each cycle's result |
| **Perception** | `intrinsic:perception` | The latest capture with overlays (bounding boxes, pose axes), confidence, and a history of captures |

The cell scene in 3D (objects, frames, attached objects, planned path) belongs to
[oro-plugin-robotmodel](../oro-plugin-robotmodel); install both for a full cell dashboard.

## Install

```bash
# app/ and ingest/
npm install oro-plugin-intrinsic     # or file:../plugins/oro-plugin-intrinsic in this repo
```

1. Add it to `app/imports/client/plugins/installed.js`, `app/imports/server/plugins/installed.js`
   and `ingest/src/plugins/installed.js`.
2. Enable it in the app and ingest settings:

```json
{ "plugins": { "enabled": ["intrinsic"] } }
```

It has no configuration. The widgets use the app's React, MUI and moment (peer dependencies).

## Protocol

An agent or connector on the cell publishes protobuf messages (`proto/intrinsic.proto`,
package `oro.intrinsic`) on the robot's MQTT topics:

| Topic (`r/<robotId>/...`) | Message | Stored in |
|---|---|---|
| `intrinsic/execution` | `ExecutionStateMessage`: tree, state per node, cycle, error | `plugin_intrinsic_executions` (latest per robot), `plugin_intrinsic_execution_steps` (one doc per finished step, kept 14 days) |
| `intrinsic/perception` | `PerceptionResultMessage`: image, detections, 2D/3D pose, confidence | `plugin_intrinsic_perception_results` (latest 50 per robot by arrival, kept 14 days) |

Ingest derives the cycle steps from consecutive execution states: a leaf node that was running
and is no longer becomes a step with its start and end times. A message may omit `nodes` after
the first one of a tree; the last tree is kept. Messages of a robot are processed in order; if
more than 100 are waiting (a robot flooding them), the excess is dropped with a warning. Ingest
keeps each robot's latest state in memory and writes only the fields that changed.

### Limits

Robot data is not trusted. Ingest and the server enforce:

| What | Limit |
|---|---|
| Perception message | 3 MiB; bigger messages are dropped before decoding |
| Perception image | 2 MiB; a bigger image is dropped (`image: null`, `imageDropped: true`) and the rest of the result kept |
| Image type (`image_mime`) | `image/jpeg`, `image/png` or `image/webp`; anything else is stored as `image/jpeg` |
| Detections, poses | 100 each per result |
| Execution message | 1 MiB (core default); at most 1000 nodes and 1000 node states, nodes without `id` dropped |
| Strings | ids, names, labels, states: 256 characters; errors: 2000 |
| Timestamps (`ts`, `cycle_start_ts`) | more than 60 s in the future → the server time; 0 → the server time |

## Demo

`scripts/demoIntrinsicCell.js` simulates a pick-and-place cell: a ghost arm picking pieces from
two lanes onto a drop station, failing a grasp or a detection now and then. It needs the app and
ingest running with the `intrinsic` and `robotmodel` plugins enabled. It is not part of the
published package: run it from this repo (`ingest/node_modules/oro-plugin-intrinsic` is a symlink
to this directory with the `file:` dependency):

```bash
cd ingest
./import.sh
node --preserve-symlinks --preserve-symlinks-main \
  node_modules/oro-plugin-intrinsic/scripts/demoIntrinsicCell.js --robot cell-1
```

It applies (idempotently, with the app's peer key from `../app/settings.json`) the `demo-arm`
RobotModel, the ghost robot `cell-1` with its RobotModelAssignment and the **Intrinsic Cell**
dashboard, then publishes joint states, the scene, executions, perception results and a custom
data summary until stopped. Options: `--app`, `--settings` (ingest settings, for the broker),
`--app-settings`. Since it sends the peer key, `--app` must be `https://`, or `http://` to
localhost.

## Endpoints

All take `{ robotId, ... }` and require the user to be able to view the robot.

| Name | Kind | Params |
|---|---|---|
| `plugin.intrinsic.execution` | publication | `{ robotId }` |
| `plugin.intrinsic.steps` | publication | `{ robotId, limit }`; newest first, up to 500 |
| `plugin.intrinsic.perception` | publication | `{ robotId, limit }`; newest first (by arrival), up to 20. Without the image data: `image` is `{ mime, size }` or null |
| `plugin.intrinsic.perceptionImage` | method | `{ robotId, resultId }`; returns `{ mime, data }` (base64) of a result of that robot, or null |

The Perception widget fetches the images of the results it shows with `perceptionImage`, keeps
them as object URLs in a small per-widget cache and draws them with `<img>`.

## Tests

```bash
npm test                                            # this package (shared helpers)
cd ../../ingest && npm test                         # ingest: test/plugins/intrinsic.test.js
cd ../app && TEST_PORT=3199 npm test                # app: imports/server/test/plugins/intrinsic.test.js
```
