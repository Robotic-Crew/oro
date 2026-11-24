/**
 * Copyright 2026 Robotic Crew
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

/**
 * Ingest entry of the robotmodel plugin.
 *
 * - ros/joint_states (JointStatesMessage): agents publish at their own rate
 *   (often 30-100 Hz) and live clients read MQTT directly, so ingest only looks
 *   at one message per robot every `persistIntervalMs`. From those it keeps:
 *   - the latest snapshot in plugin_robotmodel_joint_states, written at most
 *     every `snapshotIntervalMs` and only when the pose changed;
 *   - a time series point with one `robotmodel_joint_<name>` field per joint
 *     (unless `timeseriesEnabled` is false), for replay, skipped while no joint
 *     moves more than `jointDeadband`, except one every `keepaliveMs`.
 *   At most 64 joints per message, with names matching JOINT_NAME_RE.
 * - robotmodel/scene (SceneMessage): latest scene per robot in
 *   plugin_robotmodel_scenes, at most every SCENE_INTERVAL_MS (the latest one
 *   wins) and only when it changed.
 *
 * Settings (`plugins.config.robotmodel`): { persistIntervalMs = 200,
 *   snapshotIntervalMs = 1000, jointDeadband = 0.001, keepaliveMs = 10000,
 *   timeseriesEnabled = true }
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { definePlugin } = require('oro-plugin-sdk');
const {
  PLUGIN_ID, VERSION, SDK_RANGE, PROTO_NAME, COLLECTIONS, SUBTOPICS, TYPES,
  DEFAULT_PERSIST_INTERVAL_MS, MIN_PERSIST_INTERVAL_MS, DEFAULT_SNAPSHOT_INTERVAL_MS,
  DEFAULT_JOINT_DEADBAND, DEFAULT_KEEPALIVE_MS, SCENE_INTERVAL_MS, JOINT_STATES_MAX_BYTES,
  SCENE_MAX_BYTES, jointFieldName, parseJointStates, sceneDoc,
} = require('../shared');
const {
  makeExpiringMap, makeRateLimiter, makeJointSampler, makeThrottle, numberSetting,
} = require('./sampling');

const protoSource = fs.readFileSync(path.join(__dirname, '..', 'proto', PROTO_NAME), 'utf8');

const sceneHash = ({ ts, ...content }) => crypto.createHash('sha1').update(JSON.stringify(content)).digest('base64');

module.exports = definePlugin({
  id: PLUGIN_ID,
  version: VERSION,
  sdkRange: SDK_RANGE,
  register(ctx) {
    ctx.registerProto({ name: PROTO_NAME, source: protoSource });
  },
  async start({ mqtt, db, timeseries, settings, log }) {
    const persistIntervalMs = numberSetting(
      settings, 'persistIntervalMs', DEFAULT_PERSIST_INTERVAL_MS, MIN_PERSIST_INTERVAL_MS, log,
    );
    const snapshotIntervalMs = numberSetting(
      settings, 'snapshotIntervalMs', DEFAULT_SNAPSHOT_INTERVAL_MS, MIN_PERSIST_INTERVAL_MS, log,
    );
    const deadband = numberSetting(settings, 'jointDeadband', DEFAULT_JOINT_DEADBAND, 0, log);
    const keepaliveMs = numberSetting(settings, 'keepaliveMs', DEFAULT_KEEPALIVE_MS, 1000, log);
    const timeseriesEnabled = settings.timeseriesEnabled !== false;

    const accepts = makeRateLimiter(persistIntervalMs);
    const sampler = makeJointSampler({ deadband, keepaliveMs, snapshotIntervalMs });
    // Robots whose skipped joints were already reported
    const warned = makeExpiringMap();
    const JointStatesMessage = mqtt.lookupType(TYPES.JOINT_STATES);
    const SceneMessage = mqtt.lookupType(TYPES.SCENE);
    const jointStates = db.collection(COLLECTIONS.JOINT_STATES);
    const scenes = db.collection(COLLECTIONS.SCENES);

    mqtt.registerListener(SUBTOPICS.JOINT_STATES, async (robotId, msg) => {
      if (!accepts(robotId)) return;
      const parsed = parseJointStates(JointStatesMessage.decode(msg));
      if (!parsed) {
        log.warn(`ignoring malformed joint states from ${robotId}`);
        return;
      }
      const { names, positions, ts, skipped } = parsed;
      if (skipped && !warned.get(robotId)) {
        warned.set(robotId, true);
        log.warn(`${robotId}: skipped ${skipped} joints (invalid or duplicate names, non-finite positions, or over 64 joints)`);
      }
      const write = sampler(robotId, parsed);
      if (write.snapshot) {
        await jointStates.updateOne(
          { _id: robotId }, { $set: { names, positions, ts } }, { upsert: true },
        );
      }
      if (timeseriesEnabled && write.timeseries) {
        const fields = {};
        names.forEach((name, ix) => { fields[jointFieldName(name)] = positions[ix]; });
        await timeseries.write({ robotId, ts, fields });
      }
    }, { maxBytes: JOINT_STATES_MAX_BYTES });

    const lastScene = makeExpiringMap();
    const storeScene = makeThrottle(SCENE_INTERVAL_MS, async (robotId, doc) => {
      const hash = sceneHash(doc);
      if (lastScene.get(robotId) === hash) return;
      await scenes.replaceOne({ _id: robotId }, doc, { upsert: true });
      lastScene.set(robotId, hash);
    }, { onError: (err, robotId) => log.error(`failed to store scene of ${robotId}: ${err.message}`) });

    mqtt.registerListener(SUBTOPICS.SCENE, async (robotId, msg) => {
      await storeScene(robotId, sceneDoc(SceneMessage.decode(msg)));
    }, { maxBytes: SCENE_MAX_BYTES });

    log.info(`started: persistIntervalMs=${persistIntervalMs} snapshotIntervalMs=${snapshotIntervalMs}`
      + ` jointDeadband=${deadband} keepaliveMs=${keepaliveMs} timeseriesEnabled=${timeseriesEnabled}`);
  },
});
