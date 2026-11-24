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
 * Ingest-side implementation of skill-based cells (e.g. Intrinsic Core): behavior tree execution,
 * scene and perception, for the Execution, Cycle Timeline, Perception and 3D Model widgets.
 * See docs/intrinsic-core-widgets.md.
 *
 * - intrinsic/execution (ExecutionStateMessage): latest state per robot in `executions`. Steps
 *   (leaf nodes going from running to a final state) are derived here and appended to
 *   `execution_steps`, so the agent only has to report node states.
 * - intrinsic/scene (SceneMessage): latest scene per robot in `scenes`.
 * - intrinsic/perception (PerceptionResultMessage): appended to `perception_results`, keeping the
 *   last PERCEPTION_RESULTS_KEPT per robot (they carry the image).
 */
import MongoManager from '../../mongo';
import {
  COLLECTIONS, INTRINSIC_SUBTOPICS, PERCEPTION_RESULTS_KEPT,
} from '../../shared/constants';

const FINAL_STATES = ['succeeded', 'failed', 'cancelled'];

const toMs = ts => (ts && typeof ts === 'object' ? ts.toNumber() : Number(ts)) || Date.now();

/** Pose3D -> { position: [x, y, z], quaternion: [x, y, z, w] } (all-zero quaternion = identity) */
const poseDoc = (pose) => {
  const { x = 0, y = 0, z = 0, qx = 0, qy = 0, qz = 0, qw = 0 } = pose || {};
  const identity = !qx && !qy && !qz && !qw;
  return { position: [x, y, z], quaternion: identity ? [0, 0, 0, 1] : [qx, qy, qz, qw] };
};

const point2 = p => (p ? [p.u || 0, p.v || 0] : null);

export default class IntrinsicModule {
  constructor(mqtt) {
    this.mqtt = mqtt;
    // robotId -> promise of the execution message being processed (see onExecution)
    this._executionQueues = new Map();
  }

  load = () => {
    const mongo = new MongoManager();
    this._executions = mongo.getCollection(COLLECTIONS.EXECUTIONS);
    this._steps = mongo.getCollection(COLLECTIONS.EXECUTION_STEPS);
    this._scenes = mongo.getCollection(COLLECTIONS.SCENES);
    this._perception = mongo.getCollection(COLLECTIONS.PERCEPTION_RESULTS);
    this.ExecutionStateMessage = this.mqtt.lookupType('oro.ExecutionStateMessage');
    this.SceneMessage = this.mqtt.lookupType('oro.SceneMessage');
    this.PerceptionResultMessage = this.mqtt.lookupType('oro.PerceptionResultMessage');
    this.mqtt.registerListener(INTRINSIC_SUBTOPICS.EXECUTION, this.onExecution);
    this.mqtt.registerListener(INTRINSIC_SUBTOPICS.SCENE, this.onScene);
    this.mqtt.registerListener(INTRINSIC_SUBTOPICS.PERCEPTION, this.onPerception);
    return this;
  };

  /**
   * Messages are handled concurrently, but each execution state is computed from the previous
   * one: process them one at a time per robot, in arrival order, so a step is not derived twice.
   */
  onExecution = (robotId, msg) => {
    const previous = this._executionQueues.get(robotId) || Promise.resolve();
    const current = previous.then(() => this.processExecution(robotId, msg));
    this._executionQueues.set(robotId, current);
    return current.finally(() => {
      if (this._executionQueues.get(robotId) === current) this._executionQueues.delete(robotId);
    });
  };

  processExecution = async (robotId, msg) => {
    try {
      const decoded = this.ExecutionStateMessage.decode(msg);
      const prev = await this._executions.findOne({ _id: robotId });
      const { doc, steps } = IntrinsicModule.nextExecution(prev, decoded);
      await this._executions.replaceOne({ _id: robotId }, doc, { upsert: true });
      if (steps.length) {
        const createdAt = new Date();
        await this._steps.insertMany(steps.map(s => ({ ...s, robotId, createdAt })));
      }
    } catch (e) {
      console.error(`Error processing execution state from ${robotId}`, e);
    }
  };

  onScene = async (robotId, msg) => {
    try {
      const doc = IntrinsicModule.sceneDoc(this.SceneMessage.decode(msg));
      await this._scenes.replaceOne({ _id: robotId }, doc, { upsert: true });
    } catch (e) {
      console.error(`Error processing scene from ${robotId}`, e);
    }
  };

  onPerception = async (robotId, msg) => {
    try {
      const doc = IntrinsicModule.perceptionDoc(this.PerceptionResultMessage.decode(msg));
      await this._perception.insertOne({ ...doc, robotId, createdAt: new Date() });
      // Keep only the latest ones: they carry the image
      const old = await this._perception.find({ robotId }, { projection: { _id: 1 } })
        .sort({ ts: -1 }).skip(PERCEPTION_RESULTS_KEPT).toArray();
      if (old.length) {
        await this._perception.deleteMany({ _id: { $in: old.map(d => d._id) } });
      }
    } catch (e) {
      console.error(`Error processing perception result from ${robotId}`, e);
    }
  };

  /**
   * Previous `executions` doc + decoded ExecutionStateMessage -> { doc, steps }: the new doc, and
   * the steps that finished with this message (leaf nodes that were running and now are in a
   * final state). `runningSince` in the doc remembers when each running node started.
   */
  static nextExecution = (prev, msg) => {
    const ts = toMs(msg.ts);
    const cycleId = msg.cycleId || '';
    const sameCycle = prev && prev.cycleId === cycleId;
    const nodes = msg.nodes?.length
      ? msg.nodes.map(({ id, name, type, parentId }) => ({ id, name, type: type || 'other', parentId: parentId || '' }))
      : (prev?.nodes || []);
    const parents = new Set(nodes.map(n => n.parentId).filter(Boolean));
    const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
    const nodeStates = (msg.nodeStates || []).map(({ nodeId, state }) => ({ nodeId, state }));

    const prevStates = sameCycle ? Object.fromEntries(prev.nodeStates.map(s => [s.nodeId, s.state])) : {};
    const prevSince = sameCycle ? Object.fromEntries((prev.runningSince || []).map(r => [r.nodeId, r.ts])) : {};
    const steps = [];
    const runningSince = [];
    nodeStates.forEach(({ nodeId, state }) => {
      if (state === 'running') {
        runningSince.push({ nodeId, ts: prevSince[nodeId] ?? ts });
      } else if (FINAL_STATES.includes(state) && prevStates[nodeId] === 'running' && !parents.has(nodeId)) {
        const node = nodeById[nodeId] || { name: nodeId, type: 'other' };
        steps.push({
          cycleId,
          nodeId,
          name: node.name,
          type: node.type,
          startTs: prevSince[nodeId] ?? prev.ts,
          endTs: ts,
          result: state,
        });
      }
    });

    return {
      doc: {
        treeId: msg.treeId || '',
        treeName: msg.treeName || '',
        nodes,
        nodeStates,
        runningSince,
        status: msg.status || 'idle',
        currentNodeId: msg.currentNodeId || '',
        error: msg.error || '',
        cycleId,
        cycleStartTs: toMs(msg.cycleStartTs) || ts,
        ts,
      },
      steps,
    };
  };

  static sceneDoc = msg => ({
    objects: (msg.objects || []).map(o => ({
      id: o.id,
      name: o.name || o.id,
      shape: o.shape || 'box',
      size: o.size || [],
      pose: poseDoc(o.pose),
      color: o.color || '',
    })),
    frames: (msg.frames || []).map(f => ({ id: f.id, name: f.name || f.id, pose: poseDoc(f.pose) })),
    attached: (msg.attached || []).map(a => ({ objectId: a.objectId, link: a.link, pose: poseDoc(a.pose) })),
    plannedPath: (msg.plannedPath || []).map(p => [p.x || 0, p.y || 0, p.z || 0]),
    ts: toMs(msg.ts),
  });

  static perceptionDoc = msg => ({
    ts: toMs(msg.ts),
    cameraId: msg.cameraId || '',
    cycleId: msg.cycleId || '',
    image: msg.image?.length
      ? { mime: msg.imageMime || 'image/jpeg', data: Buffer.from(msg.image).toString('base64') }
      : null,
    width: msg.width || 0,
    height: msg.height || 0,
    detections: (msg.detections || []).map(d => ({
      label: d.label, score: d.score, bbox: [d.x, d.y, d.width, d.height],
    })),
    poses: (msg.poses || []).map(p => ({
      objectId: p.objectId,
      pose: poseDoc(p.pose),
      confidence: p.confidence,
      axes: p.axisOrigin
        ? { origin: point2(p.axisOrigin), x: point2(p.axisX), y: point2(p.axisY), z: point2(p.axisZ) }
        : null,
    })),
    success: !!msg.success,
    error: msg.error || '',
  });
}
