/**
 * Copyright 2026 InOrbit, Inc.
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
 * Unit tests for IntrinsicModule (behavior tree execution, scene, perception).
 */
import mongoUnit from 'mongo-unit';
import { assert } from 'chai';
// ORO modules
import { COLLECTIONS, PERCEPTION_RESULTS_KEPT } from '../src/shared/constants';
import { IntrinsicModule } from '../src/server/modules';
import MongoManager from '../src/mongo';
import MqttMock from './mocks/mqtt';

const mongo = new MongoManager();
const ROBOT_ID = 'cell-1';
const NODES = [
  { id: 'root', name: 'grab', type: 'sequence' },
  { id: 'move', name: 'Move to view', type: 'move', parentId: 'root' },
  { id: 'capture', name: 'Capture', type: 'perception', parentId: 'root' },
];

describe('IntrinsicModule', () => {
  let mqtt;
  let intrinsic;
  let encode;

  beforeEach(async () => {
    await mongoUnit.drop();
    mqtt = new MqttMock();
    intrinsic = new IntrinsicModule(mqtt).load();
    encode = (typeName, msg) => {
      const type = mqtt.lookupType(typeName);
      return type.encode(type.create(msg)).finish();
    };
  });

  describe('nextExecution', () => {
    const msg = (ts, states, extra = {}) => ({
      ts, cycleId: 'c1', nodes: [], status: 'running', ...extra,
      nodeStates: Object.entries(states).map(([nodeId, state]) => ({ nodeId, state })),
    });

    it('records a step when a running leaf finishes, with the time it started', () => {
      const first = IntrinsicModule.nextExecution(null, msg(1000, { root: 'running', move: 'running' }, { nodes: NODES }));
      assert.deepEqual(first.steps, []);
      assert.deepEqual(first.doc.runningSince, [{ nodeId: 'root', ts: 1000 }, { nodeId: 'move', ts: 1000 }]);

      const second = IntrinsicModule.nextExecution(first.doc, msg(2500, { root: 'running', move: 'succeeded', capture: 'running' }));
      assert.deepEqual(second.steps, [{
        cycleId: 'c1', nodeId: 'move', name: 'Move to view', type: 'move', startTs: 1000, endTs: 2500, result: 'succeeded',
      }]);
      // The tree is kept when a message does not resend it
      assert.lengthOf(second.doc.nodes, 3);
      assert.deepEqual(second.doc.runningSince, [{ nodeId: 'root', ts: 1000 }, { nodeId: 'capture', ts: 2500 }]);
    });

    it('does not record parent nodes, nor nodes running in a previous cycle', () => {
      const first = IntrinsicModule.nextExecution(null, msg(1000, { root: 'running', move: 'running' }, { nodes: NODES }));
      const done = IntrinsicModule.nextExecution(first.doc, msg(2000, { root: 'failed', move: 'failed' }));
      assert.deepEqual(done.steps.map(s => s.nodeId), ['move']);

      const otherCycle = IntrinsicModule.nextExecution(first.doc, msg(2000, { move: 'succeeded' }, { cycleId: 'c2' }));
      assert.deepEqual(otherCycle.steps, []);
    });
  });

  it('stores the execution and its finished steps', async () => {
    const execution = (ts, states) => encode('oro.ExecutionStateMessage', {
      ts, cycleId: 'c1', treeName: 'grab', status: 'running', nodes: NODES,
      nodeStates: Object.entries(states).map(([nodeId, state]) => ({ nodeId, state })),
    });
    await intrinsic.onExecution(ROBOT_ID, execution(1000, { root: 'running', move: 'running' }));
    await intrinsic.onExecution(ROBOT_ID, execution(1800, { root: 'running', move: 'succeeded' }));

    const doc = await mongo.getCollection(COLLECTIONS.EXECUTIONS).findOne({ _id: ROBOT_ID });
    assert.equal(doc.treeName, 'grab');
    assert.equal(doc.ts, 1800);
    const steps = await mongo.getCollection(COLLECTIONS.EXECUTION_STEPS).find({}).toArray();
    assert.lengthOf(steps, 1);
    assert.include(steps[0], { robotId: ROBOT_ID, nodeId: 'move', startTs: 1000, endTs: 1800 });
  });

  it('processes execution messages of a robot in order, deriving each step once', async () => {
    const execution = (ts, states) => encode('oro.ExecutionStateMessage', {
      ts, cycleId: 'c1', status: 'running', nodes: NODES,
      nodeStates: Object.entries(states).map(([nodeId, state]) => ({ nodeId, state })),
    });
    await intrinsic.onExecution(ROBOT_ID, execution(1000, { root: 'running', move: 'running' }));
    // Back to back, as an agent publishes them: not awaited one by one
    await Promise.all([
      intrinsic.onExecution(ROBOT_ID, execution(1800, { root: 'running', move: 'succeeded' })),
      intrinsic.onExecution(ROBOT_ID, execution(1801, { root: 'running', move: 'succeeded', capture: 'running' })),
      intrinsic.onExecution(ROBOT_ID, execution(2500, { root: 'running', move: 'succeeded', capture: 'succeeded' })),
    ]);

    const steps = await mongo.getCollection(COLLECTIONS.EXECUTION_STEPS).find({}).sort({ endTs: 1 }).toArray();
    assert.deepEqual(steps.map(s => [s.nodeId, s.startTs, s.endTs]), [['move', 1000, 1800], ['capture', 1801, 2500]]);
    const doc = await mongo.getCollection(COLLECTIONS.EXECUTIONS).findOne({ _id: ROBOT_ID });
    assert.equal(doc.ts, 2500);
  });

  it('stores the scene, with identity quaternions for unset orientations', async () => {
    await intrinsic.onScene(ROBOT_ID, encode('oro.SceneMessage', {
      ts: 5,
      objects: [{ id: 'cart', shape: 'box', size: [0.3, 0.2, 0.1], pose: { x: 1, z: 0.05 } }],
      frames: [{ id: 'grasp', pose: { x: 1, qz: 1 } }],
      attached: [{ objectId: 'piece', link: 'tool', pose: { z: 0.1 } }],
      plannedPath: [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }],
    }));
    const doc = await mongo.getCollection(COLLECTIONS.SCENES).findOne({ _id: ROBOT_ID });
    assert.deepEqual(doc.objects[0].pose, { position: [1, 0, 0.05], quaternion: [0, 0, 0, 1] });
    assert.deepEqual(doc.frames[0].pose.quaternion, [0, 0, 1, 0]);
    assert.deepEqual(doc.attached, [{ objectId: 'piece', link: 'tool', pose: { position: [0, 0, 0.1], quaternion: [0, 0, 0, 1] } }]);
    assert.deepEqual(doc.plannedPath, [[0, 0, 1], [1, 0, 1]]);
  });

  it('stores perception results with their image, keeping the latest ones', async () => {
    const perception = ts => encode('oro.PerceptionResultMessage', {
      ts, cameraId: 'wrist', image: Buffer.from('jpeg'), imageMime: 'image/jpeg', width: 640, height: 480,
      detections: [{ label: 'piece', score: 0.9, x: 10, y: 20, width: 30, height: 40 }],
      poses: [{ objectId: 'piece', confidence: 0.8, axisOrigin: { u: 25, v: 40 }, axisX: { u: 40, v: 40 } }],
      success: true,
    });
    for (let i = 0; i < PERCEPTION_RESULTS_KEPT + 2; i += 1) {
      await intrinsic.onPerception(ROBOT_ID, perception(1000 + i));
    }
    const coll = mongo.getCollection(COLLECTIONS.PERCEPTION_RESULTS);
    assert.equal(await coll.countDocuments({ robotId: ROBOT_ID }), PERCEPTION_RESULTS_KEPT);
    const latest = await coll.find({}).sort({ ts: -1 }).limit(1).next();
    assert.equal(latest.ts, 1000 + PERCEPTION_RESULTS_KEPT + 1);
    assert.deepEqual(latest.image, { mime: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') });
    assert.deepEqual(latest.detections, [{ label: 'piece', score: latest.detections[0].score, bbox: [10, 20, 30, 40] }]);
    assert.deepEqual(latest.poses[0].axes.origin, [25, 40]);
  });
});
