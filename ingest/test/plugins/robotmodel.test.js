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
 * Ingest entry of oro-plugin-robotmodel: joint states (snapshot + time series,
 * downsampled) and the cell scene.
 */
import mongoUnit from 'mongo-unit';
import { assert } from 'chai';
// ORO modules
import MongoManager from '../../src/mongo';
import { loadIngestPlugins, startIngestPlugins } from '../../src/plugins';
import { COLLECTIONS } from '../../src/shared/constants';
import makeMqtt from '../mocks/pluginMqtt';

const ROBOT_ID = 'arm-1';
const mongo = new MongoManager();
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('oro-plugin-robotmodel (ingest)', () => {
  const jointStates = () => mongo.getCollection('plugin_robotmodel_joint_states');
  const scenes = () => mongo.getCollection('plugin_robotmodel_scenes');
  const timeseries = () => mongo.getCollection(COLLECTIONS.TIMESERIES);
  let runtime;

  const start = async (config = {}) => {
    const mqtt = makeMqtt();
    const settings = { plugins: { enabled: ['robotmodel'], config: { robotmodel: config } } };
    const registry = loadIngestPlugins({ settings, addProtoSource: mqtt.addProtoSource });
    runtime = await startIngestPlugins(registry, { mqtt, mongo, settings });
    const encode = (type, msg) => {
      const t = mqtt.lookupType(`oro.robotmodel.${type}`);
      return t.encode(t.create(msg)).finish();
    };
    const send = (subtopic, type, msg) => mqtt.listeners[subtopic](ROBOT_ID, encode(type, msg));
    return { mqtt, send };
  };
  const points = async () => {
    await runtime.flushTimeseries();
    return timeseries().find({}).sort({ time: 1 }).toArray();
  };

  beforeEach(async () => {
    await mongoUnit.drop();
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  it('stores the latest snapshot and a time series point per joint', async () => {
    const { send } = await start({ persistIntervalMs: 1000 });
    const ts = Date.now();
    await send('ros/joint_states', 'JointStatesMessage', {
      ts, names: ['shoulder', 'arm/elbow'], positions: [0.5, -1.25],
    });
    assert.deepEqual(await jointStates().findOne({ _id: ROBOT_ID }), {
      _id: ROBOT_ID, names: ['shoulder', 'arm/elbow'], positions: [0.5, -1.25], ts,
    });
    const stored = await points();
    assert.lengthOf(stored, 1);
    assert.deepEqual(stored[0].meta, { robotId: ROBOT_ID, src: 'robotmodel' });
    assert.equal(stored[0].time.getTime(), ts);
    assert.equal(stored[0].robotmodel_joint_shoulder, 0.5);
    assert.equal(stored[0].robotmodel_joint_arm_elbow, -1.25);
  });

  it('downsamples: messages within persistIntervalMs are dropped', async () => {
    const { send } = await start({ persistIntervalMs: 1000 });
    const ts = Date.now();
    await send('ros/joint_states', 'JointStatesMessage', { ts, names: ['j'], positions: [1] });
    await send('ros/joint_states', 'JointStatesMessage', { ts: ts + 10, names: ['j'], positions: [2] });
    assert.deepEqual((await jointStates().findOne({ _id: ROBOT_ID })).positions, [1]);
    assert.lengthOf(await points(), 1);
  });

  it('skips idle samples (deadband) and writes the snapshot only at its interval', async () => {
    const { send } = await start({ persistIntervalMs: 50, snapshotIntervalMs: 1000 });
    const ts = Date.now();
    const sendJ = async (position, dt) => {
      await send('ros/joint_states', 'JointStatesMessage', { ts: ts + dt, names: ['j'], positions: [position] });
      await wait(60);
    };
    await sendJ(1, 0);
    await sendJ(1.0001, 60); // below the deadband: no point, no snapshot
    await sendJ(1.5, 120); // moved: a point, but the snapshot waits for its interval
    const stored = await points();
    assert.deepEqual(stored.map((p) => p.robotmodel_joint_j), [1, 1.5]);
    assert.deepEqual(await jointStates().findOne({ _id: ROBOT_ID }), {
      _id: ROBOT_ID, names: ['j'], positions: [1], ts,
    });
  });

  it('treats a bad persistIntervalMs as the default', async () => {
    const { send } = await start({ persistIntervalMs: 'fast' });
    const ts = Date.now();
    await send('ros/joint_states', 'JointStatesMessage', { ts, names: ['j'], positions: [1] });
    await send('ros/joint_states', 'JointStatesMessage', { ts: ts + 10, names: ['j'], positions: [2] });
    assert.lengthOf(await points(), 1);
  });

  it('skips the time series when timeseriesEnabled is false', async () => {
    const { send } = await start({ timeseriesEnabled: false });
    await send('ros/joint_states', 'JointStatesMessage', { ts: Date.now(), names: ['j'], positions: [1] });
    assert.isNotNull(await jointStates().findOne({ _id: ROBOT_ID }));
    assert.lengthOf(await points(), 0);
  });

  it('ignores malformed messages', async () => {
    const { send } = await start();
    await send('ros/joint_states', 'JointStatesMessage', { names: ['a', 'b'], positions: [1] });
    assert.isNull(await jointStates().findOne({ _id: ROBOT_ID }));
  });

  it('keeps only valid joint names, at most 64 joints', async () => {
    const { send } = await start();
    const names = ['$bad', 'a.b', '__proto__', 'x'.repeat(129), ...Array.from({ length: 70 }, (_, ix) => `j${ix}`)];
    await send('ros/joint_states', 'JointStatesMessage', {
      ts: Date.now(), names, positions: names.map(() => 0.5),
    });
    const doc = await jointStates().findOne({ _id: ROBOT_ID });
    assert.lengthOf(doc.names, 64);
    assert.equal(doc.names[0], 'j0');
    const [point] = await points();
    const fields = Object.keys(point).filter((k) => k.startsWith('robotmodel_'));
    assert.lengthOf(fields, 64);
    assert.isUndefined(point.robotmodel_joint___proto__);
  });

  it('clamps future timestamps of the snapshot', async () => {
    const { send } = await start();
    const before = Date.now();
    await send('ros/joint_states', 'JointStatesMessage', { ts: before + 3600_000, names: ['j'], positions: [1] });
    const { ts } = await jointStates().findOne({ _id: ROBOT_ID });
    assert.isAtLeast(ts, before);
    assert.isAtMost(ts, Date.now());
  });

  it('stores the scene, with identity quaternions for unset orientations', async () => {
    const { send } = await start();
    await send('robotmodel/scene', 'SceneMessage', {
      ts: 5,
      objects: [{ id: 'cart', shape: 'box', size: [0.3, 0.2, 0.1], pose: { x: 1, z: 0.05 } }],
      frames: [{ id: 'grasp', pose: { x: 1, qz: 1 } }],
      attached: [{ objectId: 'piece', link: 'tool', pose: { z: 0.1 } }],
      plannedPath: [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }],
    });
    const doc = await scenes().findOne({ _id: ROBOT_ID });
    assert.deepEqual(doc.objects[0].pose, { position: [1, 0, 0.05], quaternion: [0, 0, 0, 1] });
    assert.deepEqual(doc.frames[0].pose.quaternion, [0, 0, 1, 0]);
    assert.deepEqual(doc.attached, [{ objectId: 'piece', link: 'tool', pose: { position: [0, 0, 0.1], quaternion: [0, 0, 0, 1] } }]);
    assert.deepEqual(doc.plannedPath, [[0, 0, 1], [1, 0, 1]]);
    assert.equal(doc.ts, 5);
  });

  it('throttles scenes (the latest wins) and skips unchanged ones', async () => {
    const { send } = await start();
    const scene = (x, ts) => send('robotmodel/scene', 'SceneMessage', { ts, objects: [{ id: 'cart', pose: { x } }] });
    await scene(1, 5);
    await scene(2, 6);
    await scene(3, 7);
    // Only the first one so far; the last one is stored when the interval ends
    assert.equal((await scenes().findOne({ _id: ROBOT_ID })).ts, 5);
    await wait(600);
    const doc = await scenes().findOne({ _id: ROBOT_ID });
    assert.equal(doc.ts, 7);
    assert.deepEqual(doc.objects[0].pose.position, [3, 0, 0]);
    // Same content, newer ts: not rewritten
    await wait(600);
    await scene(3, 8);
    assert.equal((await scenes().findOne({ _id: ROBOT_ID })).ts, 7);
  });
});
