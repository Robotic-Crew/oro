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
 * Ingest entry of oro-plugin-intrinsic: behavior tree executions, their steps
 * and perception results.
 */
import mongoUnit from 'mongo-unit';
import { assert } from 'chai';
// ORO modules
import MongoManager from '../../src/mongo';
import { loadIngestPlugins, startIngestPlugins } from '../../src/plugins';
import makeMqtt from '../mocks/pluginMqtt';

const ROBOT_ID = 'cell-1';
const PERCEPTION_RESULTS_KEPT = 50;
const NODES = [
  { id: 'root', name: 'grab', type: 'sequence' },
  { id: 'move', name: 'Move to view', type: 'move', parentId: 'root' },
  { id: 'capture', name: 'Capture', type: 'perception', parentId: 'root' },
];
const mongo = new MongoManager();
const coll = (name) => mongo.getCollection(`plugin_intrinsic_${name}`);

describe('oro-plugin-intrinsic (ingest)', () => {
  let mqtt;
  let runtime;
  let send;
  const encode = (type, msg) => {
    const t = mqtt.lookupType(`oro.intrinsic.${type}`);
    return t.encode(t.create(msg)).finish();
  };
  const execution = (ts, states, extra = {}) => encode('ExecutionStateMessage', {
    ts,
    cycleId: 'c1',
    status: 'running',
    nodes: NODES,
    ...extra,
    nodeStates: Object.entries(states).map(([nodeId, state]) => ({ nodeId, state })),
  });

  beforeEach(async () => {
    await mongoUnit.drop();
    mqtt = makeMqtt();
    const settings = { plugins: { enabled: ['intrinsic'], config: {} } };
    const registry = loadIngestPlugins({ settings, addProtoSource: mqtt.addProtoSource });
    runtime = await startIngestPlugins(registry, { mqtt, mongo, settings });
    send = (subtopic, msg) => mqtt.listeners[subtopic](ROBOT_ID, msg);
  });

  afterEach(() => runtime.stop());

  it('stores the execution and its finished steps', async () => {
    await send('intrinsic/execution', execution(1000, { root: 'running', move: 'running' }, { treeName: 'grab' }));
    await send('intrinsic/execution', execution(1800, { root: 'running', move: 'succeeded' }, { treeName: 'grab' }));

    const doc = await coll('executions').findOne({ _id: ROBOT_ID });
    assert.equal(doc.treeName, 'grab');
    assert.equal(doc.ts, 1800);
    const steps = await coll('execution_steps').find({}).toArray();
    assert.lengthOf(steps, 1);
    assert.include(steps[0], { robotId: ROBOT_ID, nodeId: 'move', startTs: 1000, endTs: 1800 });
    assert.instanceOf(steps[0].createdAt, Date);
  });

  it('processes execution messages of a robot in order, deriving each step once', async () => {
    await send('intrinsic/execution', execution(1000, { root: 'running', move: 'running' }));
    // Back to back, as an agent publishes them: not awaited one by one
    await Promise.all([
      send('intrinsic/execution', execution(1800, { root: 'running', move: 'succeeded' })),
      send('intrinsic/execution', execution(1801, { root: 'running', move: 'succeeded', capture: 'running' })),
      send('intrinsic/execution', execution(2500, { root: 'running', move: 'succeeded', capture: 'succeeded' })),
    ]);
    const steps = await coll('execution_steps').find({}).sort({ endTs: 1 }).toArray();
    assert.deepEqual(steps.map((s) => [s.nodeId, s.startTs, s.endTs]), [['move', 1000, 1800], ['capture', 1801, 2500]]);
    assert.equal((await coll('executions').findOne({ _id: ROBOT_ID })).ts, 2500);
  });

  it('keeps the tree and writes only the changed fields when a message omits the nodes', async () => {
    await send('intrinsic/execution', execution(1000, { root: 'running', move: 'running' }, { treeName: 'grab' }));
    // Changed behind ingest's back: not read again, since the latest state is kept in memory
    await coll('executions').updateOne({ _id: ROBOT_ID }, { $set: { marker: 1, treeName: 'other' } });
    await send('intrinsic/execution', execution(1800, { root: 'running', move: 'succeeded' }, { nodes: [], treeName: 'grab' }));

    const doc = await coll('executions').findOne({ _id: ROBOT_ID });
    assert.equal(doc.marker, 1);
    // treeName did not change between the two messages: not written
    assert.equal(doc.treeName, 'other');
    assert.lengthOf(doc.nodes, 3);
    assert.equal(doc.ts, 1800);
    assert.lengthOf(await coll('execution_steps').find({}).toArray(), 1);
  });

  it('reads the previous execution from Mongo on the first message of a robot', async () => {
    await coll('executions').insertOne({
      _id: ROBOT_ID,
      cycleId: 'c1',
      ts: 1000,
      nodes: NODES.map((n) => ({ parentId: '', ...n })),
      nodeStates: [{ nodeId: 'root', state: 'running' }, { nodeId: 'move', state: 'running' }],
      runningSince: [{ nodeId: 'root', ts: 1000 }, { nodeId: 'move', ts: 900 }],
    });
    await send('intrinsic/execution', execution(1800, { root: 'running', move: 'succeeded' }, { nodes: [] }));
    const steps = await coll('execution_steps').find({}).toArray();
    assert.deepEqual(steps.map((s) => [s.nodeId, s.startTs, s.endTs]), [['move', 900, 1800]]);
  });

  it('drops execution messages of a robot beyond 100 pending', async () => {
    await Promise.all(Array.from({ length: 150 }, (_, i) => (
      send('intrinsic/execution', execution(1000 + i, { root: 'running' }))
    )));
    assert.equal((await coll('executions').findOne({ _id: ROBOT_ID })).ts, 1099);
    // Accepted again once the queue drains
    await send('intrinsic/execution', execution(5000, { root: 'running' }));
    assert.equal((await coll('executions').findOne({ _id: ROBOT_ID })).ts, 5000);
  });

  it('creates the steps and perception indexes, with TTLs', async () => {
    const steps = await coll('execution_steps').indexes();
    assert.deepInclude(steps.map((ix) => ix.key), { robotId: 1, endTs: -1 });
    assert.equal(steps.find((ix) => ix.key.createdAt === 1).expireAfterSeconds, 14 * 24 * 3600);
    const perception = await coll('perception_results').indexes();
    assert.deepInclude(perception.map((ix) => ix.key), { robotId: 1, createdAt: -1 });
    const ttl = perception.find((ix) => ix.key.createdAt === 1 && !ix.key.robotId);
    assert.equal(ttl.expireAfterSeconds, 14 * 24 * 3600);
  });

  it('stores perception results with their image, keeping the latest ones', async () => {
    const perception = (ts) => encode('PerceptionResultMessage', {
      ts,
      cameraId: 'wrist',
      image: Buffer.from('jpeg'),
      imageMime: 'image/jpeg',
      width: 640,
      height: 480,
      detections: [{ label: 'piece', score: 0.9, x: 10, y: 20, width: 30, height: 40 }],
      poses: [{ objectId: 'piece', confidence: 0.8, axisOrigin: { u: 25, v: 40 }, axisX: { u: 40, v: 40 } }],
      success: true,
    });
    for (let i = 0; i < PERCEPTION_RESULTS_KEPT + 2; i += 1) {
      await send('intrinsic/perception', perception(1000 + i));
    }
    const results = coll('perception_results');
    assert.equal(await results.countDocuments({ robotId: ROBOT_ID }), PERCEPTION_RESULTS_KEPT);
    const latest = await results.find({}).sort({ ts: -1 }).limit(1).next();
    assert.equal(latest.ts, 1000 + PERCEPTION_RESULTS_KEPT + 1);
    assert.typeOf(latest._id, 'string');
    assert.deepEqual(latest.image, { mime: 'image/jpeg', size: 4, data: Buffer.from('jpeg').toString('base64') });
    assert.deepEqual(latest.detections, [{ label: 'piece', score: latest.detections[0].score, bbox: [10, 20, 30, 40] }]);
    assert.deepEqual(latest.poses[0].axes.origin, [25, 40]);
  });

  it('keeps the latest perception results by arrival, not by robot clock', async () => {
    const perception = (ts) => encode('PerceptionResultMessage', { ts, success: true });
    // A robot whose clock went back: its newest results must not be the ones trimmed
    for (let i = 0; i < PERCEPTION_RESULTS_KEPT + 5; i += 1) {
      await send('intrinsic/perception', perception(1_000_000 - i));
    }
    const kept = await coll('perception_results').find({}).toArray();
    assert.lengthOf(kept, PERCEPTION_RESULTS_KEPT);
    assert.include(kept.map((r) => r.ts), 1_000_000 - PERCEPTION_RESULTS_KEPT - 4);
  });

  it('replaces robot timestamps in the future by the server time', async () => {
    const before = Date.now();
    await send('intrinsic/perception', encode('PerceptionResultMessage', { ts: before + 3600e3 }));
    const { ts } = await coll('perception_results').findOne({});
    assert.isAtLeast(ts, before);
    assert.isAtMost(ts, Date.now());
  });

  it('drops images over 2 MiB, and messages over 3 MiB', async () => {
    const MiB = 1024 * 1024;
    await send('intrinsic/perception', encode('PerceptionResultMessage', {
      ts: 1000, image: Buffer.alloc(2 * MiB + 1), imageMime: 'image/png', success: true,
    }));
    const doc = await coll('perception_results').findOne({});
    assert.include(doc, { image: null, imageDropped: true, success: true });

    await send('intrinsic/perception', encode('PerceptionResultMessage', { ts: 2000, image: Buffer.alloc(3 * MiB + 1) }));
    assert.equal(await coll('perception_results').countDocuments({}), 1);
  });

  it('stores only whitelisted image mime types', async () => {
    await send('intrinsic/perception', encode('PerceptionResultMessage', {
      ts: 1000, image: Buffer.from('<svg/>'), imageMime: 'image/svg+xml',
    }));
    assert.equal((await coll('perception_results').findOne({})).image.mime, 'image/jpeg');
  });
});
