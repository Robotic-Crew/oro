# oro-plugin-robotmodel

ORO plugin that adds a **3D Model** dashboard widget (`robotmodel:viewer`). The widget shows a
robot's URDF model moving with its live joint states, replays them over the dashboard's time
range, and draws the cell scene around the robot (objects, frames, attached objects, planned
path) when the robot reports one.

The plugin covers the app (widget, ConfigAPI kinds, publications) and ingest (joint states and
scene persistence).

## Install

```bash
# app/ and ingest/
npm install oro-plugin-robotmodel     # or file:../plugins/oro-plugin-robotmodel in this repo
```

1. Add it to `app/imports/client/plugins/installed.js`, `app/imports/server/plugins/installed.js`
   and `ingest/src/plugins/installed.js`.
2. Enable it in the app and ingest settings:

```json
{ "plugins": { "enabled": ["robotmodel"], "config": { "robotmodel": {} } } }
```

The app must provide `three` (^0.187) and `urdf-loader` (^0.13) as dependencies. They are peer
dependencies, so a single copy of three.js ends up in the bundle. The app's `postinstall` copies
`public/` to `app/public/plugins/robotmodel/`, which serves it at `/plugins/robotmodel/...`.

## Configuration

```yaml
apiVersion: v0.1
kind: RobotModel              # one per robot type
metadata: { id: demo-arm }
spec:
  label: Demo arm
  urdf: /plugins/robotmodel/demo-arm/demo_arm.urdf   # a path on the app origin (see allowedAssetOrigins)
  # packages: { ur_description: /robot-assets/ur_description }  # resolves package://
  # jointMap: { joint_1: shoulder_pan }               # published name -> URDF name
---
apiVersion: v0.1
kind: RobotModelAssignment    # one per robot; metadata.id is the robot id
metadata: { id: arm-1 }
spec:
  model: demo-arm
  # Optional static pose, e.g. for ghost robots without a live feed
  joints: { shoulder_pan: 0.6, shoulder_lift: -0.4, elbow: 1.2 }
```

Then add a widget with `type: robotmodel:viewer` to a robot dashboard.

- To remove a robot's model, clear its `RobotModelAssignment`.
- A `RobotModel` can't be cleared while an assignment still references it.
- Both kinds need fleet configuration permissions (`access: 'fleet.configure'`, enforced by core).
- Joint names (`jointMap` keys and values, `joints` keys) must match `^[A-Za-z0-9_\-/:]{1,128}$`:
  no `.` or `$`, at most 128 characters.

### Asset URLs

`urdf` and `packages` URLs are loaded by the browser. By default only paths on the app's own origin
are accepted (`/plugins/robotmodel/...`, `/robot-assets/...`); `//host/...` and absolute URLs are
rejected. To load models from a CDN, list its origins in the app settings:

```json
{ "plugins": { "config": { "robotmodel": { "allowedAssetOrigins": ["https://cdn.example.com"] } } } }
```

Absolute `http(s)` URLs are then accepted when their origin (scheme, host and port) is in the list.
Invalid entries are ignored with a warning. The list is read when the app starts, and only applies to
new `apply`s: models stored before keep their URLs.

### Ingest settings

`plugins.config.robotmodel` in the ingest settings:

| Setting | Default | |
|---|---|---|
| `persistIntervalMs` | `200` | Ingest looks at one joint states message per robot per interval (5 Hz). Minimum `50`; invalid values fall back to the default with a warning. |
| `snapshotIntervalMs` | `1000` | Minimum interval between writes of a robot's joint states snapshot; it is only written when the pose changed. |
| `jointDeadband` | `0.001` | A time series point is skipped while no joint moved more than this (rad or m) since the last point... |
| `keepaliveMs` | `10000` | ...except for one point every `keepaliveMs` (minimum `1000`). |
| `timeseriesEnabled` | `true` | Also write one time series field per joint, which is what replay reads. |

## Protocol

Types are defined in `proto/robotmodel.proto`, package `oro.robotmodel`.

| Subtopic (`r/<robotId>/...`) | Message | |
|---|---|---|
| `ros/joint_states` | `JointStatesMessage` (`ts`, `names[]`, `positions[]`) | At the robot's own rate. The browser also subscribes to it directly for live view. |
| `robotmodel/scene` | `SceneMessage` | The full scene each time; replaces the previous one. |

Ingest keeps:

- the latest joint state snapshot (`plugin_robotmodel_joint_states`), written at most every
  `snapshotIntervalMs` and only when it changed;
- the latest scene (`plugin_robotmodel_scenes`), at most twice a second per robot (the latest
  message of a burst wins) and only when its content changed;
- with `timeseriesEnabled`, one time series field per joint, `robotmodel_joint_<name>`, sanitized
  to `[A-Za-z0-9_]`, skipping idle samples (see `jointDeadband`).

Limits:

- Joint states: messages up to 64 KiB; the first 64 joints with a valid name (see Configuration)
  and a finite position are kept, the rest are skipped (logged once per robot). A name whose
  sanitized field collides with an earlier one (`a/b` and `a_b`) is skipped too.
- Scene: messages up to 1 MiB; `objects`, `frames`, `attached` and `plannedPath` are capped at
  1000 entries, strings at 128 characters (colors at 32), unknown shapes become boxes and
  non-finite numbers 0.
- Robot timestamps more than 60 s in the future are replaced by the time of arrival.

## Demo

```bash
cd ingest
node --preserve-symlinks --preserve-symlinks-main \
  node_modules/oro-plugin-robotmodel/scripts/publishJointStates.js arm-1 --hz 30
```

The script publishes a motion loop for the demo arm, using the ingest MQTT credentials from
`settings.json`.

## Real models

```bash
pip install trimesh pycollada        # gltfpack is optional, for meshopt compression
python tools/urdf_optimize.py robot.urdf --out <dir> --package pkg=DIR
```

The output is the original URDF, without `<collision>` elements, plus one compressed GLB per mesh.
Serve it from the app's `public/` directory, or from a CDN listed in `allowedAssetOrigins`, and point
`urdf` at it.

## How it works

- **Live view:** joint states arrive over MQTT straight into a ring buffer. They are interpolated
  on each animation frame and written to the joint nodes, bypassing Minimongo and React state.
- **Ghost robots:** a ghost has no MQTT credential, so the widget animates it from the ingest
  snapshot instead (1 Hz by default, interpolated). Widgets only subscribe to the snapshot while
  MQTT is silent.
- **Shared renderer:** a single offscreen `WebGLRenderer` serves the page. Each widget copies its
  image into its own 2D canvas, which avoids the WebGL context limit.
- **On-demand rendering:** the widget renders only when data arrives or the camera moves, and
  pauses when off screen.
- **Model cache:** models are cached per robot type, and three.js loads lazily as its own chunk.
- **Cell scene:** updated in place; object meshes are rebuilt only when their shape, size or color
  change.
- **Replay:** the `plugin.robotmodel.jointHistory` method returns up to 24 h and 20k points of the
  dashboard's time range. The slider covers only the part that has data.

## Endpoints

All endpoints require that the caller can view the robot.

| Name | Kind | Params |
|---|---|---|
| `plugin.robotmodel.assignment` | publication | `{ robotId }` |
| `plugin.robotmodel.model` | publication | `{ robotId, modelId }`; published only while `modelId` is the robot's model |
| `plugin.robotmodel.jointStates` | publication | `{ robotId }` |
| `plugin.robotmodel.scene` | publication | `{ robotId }` |
| `plugin.robotmodel.jointHistory` | method | `{ robotId, names, startTs, endTs }` → `{ names, values: [[ts, ...]], truncated }`; 1-64 valid joint names |

## Tests

```bash
npm test                      # this package (node:test)
```

The app and ingest suites in this repo cover the plugin end to end:
`app/imports/server/test/plugins/robotmodel.test.js` and `ingest/test/plugins/robotmodel.test.js`.
