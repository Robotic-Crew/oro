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
 * Constants and pure helpers shared by every runtime entry of the intrinsic
 * plugin. CommonJS on purpose: ingest and the plugin tests load it with plain Node.
 */
const { version } = require('../package.json');

exports.PLUGIN_ID = 'intrinsic';
exports.VERSION = version;
exports.SDK_RANGE = '^0.3.0';
exports.PROTO_NAME = 'intrinsic.proto';

exports.WIDGETS = Object.freeze({
  EXECUTION: 'intrinsic:execution',
  CYCLE_TIMELINE: 'intrinsic:cycleTimeline',
  PERCEPTION: 'intrinsic:perception',
});

// Collections (plugin_intrinsic_<name>)
const COLLECTIONS = Object.freeze({
  // Latest behavior tree execution per robot (_id: robotId)
  EXECUTIONS: 'executions',
  // One doc per finished step (leaf node):
  //   { robotId, cycleId, nodeId, name, type, startTs, endTs, result, createdAt }
  EXECUTION_STEPS: 'execution_steps',
  // Latest perception attempts per robot (_id: string), with their image
  PERCEPTION_RESULTS: 'perception_results',
});
exports.COLLECTIONS = COLLECTIONS;

// Publications and methods (plugin.intrinsic.<name>)
exports.ENDPOINTS = Object.freeze({
  EXECUTION: 'execution',
  STEPS: 'steps',
  PERCEPTION: 'perception',
  // Method: the image of one perception result (the publication leaves it out)
  PERCEPTION_IMAGE: 'perceptionImage',
});

// MQTT subtopics (r/<robotId>/<subtopic>)
exports.SUBTOPICS = Object.freeze({
  EXECUTION: 'intrinsic/execution',
  PERCEPTION: 'intrinsic/perception',
});

exports.TYPES = Object.freeze({
  EXECUTION: 'oro.intrinsic.ExecutionStateMessage',
  PERCEPTION: 'oro.intrinsic.PerceptionResultMessage',
});

exports.MAX_STEPS = 500;
exports.MAX_PERCEPTION_RESULTS = 20;
// Perception results (they carry the image) kept per robot
exports.PERCEPTION_RESULTS_KEPT = 50;
// Steps and perception results expire after two weeks
const STEPS_TTL_S = 14 * 24 * 3600;
const PERCEPTION_TTL_S = 14 * 24 * 3600;
exports.STEPS_TTL_S = STEPS_TTL_S;
exports.PERCEPTION_TTL_S = PERCEPTION_TTL_S;

// Limits on what a robot can send (bigger or longer parts are dropped or cut)
const MiB = 1024 * 1024;
exports.LIMITS = Object.freeze({
  // Perception messages bigger than this are dropped by core before decoding
  PERCEPTION_MESSAGE_BYTES: 3 * MiB,
  // Images bigger than this are dropped (the rest of the result is kept)
  PERCEPTION_IMAGE_BYTES: 2 * MiB,
  DETECTIONS: 100,
  POSES: 100,
  // Behavior tree nodes, and node states, per message
  NODES: 1000,
  // ids, names, labels, states...
  ID_LENGTH: 256,
  // errors
  TEXT_LENGTH: 2000,
  // Robot timestamps further in the future than this are replaced by the server time
  FUTURE_TS_MS: 60 * 1000,
  // Depth of the behavior tree the Execution widget draws
  TREE_DEPTH: 64,
});
const { LIMITS } = exports;

// Image types a perception result can carry; anything else is stored as IMAGE_MIME_DEFAULT
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp)$/;
const IMAGE_MIME_DEFAULT = 'image/jpeg';
exports.IMAGE_MIME_RE = IMAGE_MIME_RE;
exports.IMAGE_MIME_DEFAULT = IMAGE_MIME_DEFAULT;
/** Whitelisted image mime type: one of image/jpeg|png|webp, else image/jpeg. */
const imageMime = (mime) => (typeof mime === 'string' && IMAGE_MIME_RE.test(mime) ? mime : IMAGE_MIME_DEFAULT);
exports.imageMime = imageMime;

// Perception result ids (ingest makes them with crypto.randomUUID())
exports.RESULT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Indexes of the plugin collections, as [collection, key, options]. Both ingest
 * and the server ensure them on start, so they must agree.
 */
exports.INDEXES = Object.freeze([
  [COLLECTIONS.EXECUTION_STEPS, { robotId: 1, endTs: -1 }, {}],
  [COLLECTIONS.EXECUTION_STEPS, { createdAt: 1 }, { expireAfterSeconds: STEPS_TTL_S }],
  [COLLECTIONS.PERCEPTION_RESULTS, { robotId: 1, createdAt: -1 }, {}],
  [COLLECTIONS.PERCEPTION_RESULTS, { createdAt: 1 }, { expireAfterSeconds: PERCEPTION_TTL_S }],
]);

const FINAL_STATES = ['succeeded', 'failed', 'cancelled'];

/** protobufjs int64 (number or Long) -> ms; 0 or missing -> 0 */
const rawMs = (ts) => (ts && typeof ts === 'object' ? ts.toNumber() : Number(ts)) || 0;

/**
 * Robot timestamp -> ms, not trusted: 0 or missing -> now, and further than
 * LIMITS.FUTURE_TS_MS in the future -> now.
 */
const toMs = (ts, now = Date.now()) => {
  const ms = rawMs(ts);
  return !ms || ms > now + LIMITS.FUTURE_TS_MS ? now : ms;
};
exports.toMs = toMs;

/** String from the robot, cut to `max` characters ('' when not a string) */
const str = (value, max = LIMITS.ID_LENGTH) => (typeof value === 'string' ? value.slice(0, max) : '');
exports.str = str;

/** Pose3D -> { position: [x, y, z], quaternion: [x, y, z, w] } (all-zero quaternion = identity) */
const poseDoc = (pose) => {
  const { x = 0, y = 0, z = 0, qx = 0, qy = 0, qz = 0, qw = 0 } = pose || {};
  const identity = !qx && !qy && !qz && !qw;
  return { position: [x, y, z], quaternion: identity ? [0, 0, 0, 1] : [qx, qy, qz, qw] };
};
exports.poseDoc = poseDoc;

const point2 = (p) => (p ? [p.u || 0, p.v || 0] : null);

/**
 * Behavior tree nodes of a message -> stored nodes: nodes without an id (the
 * proto3 default) and repeated ids dropped, at most LIMITS.NODES, strings cut.
 */
const treeNodes = (nodes) => {
  const seen = new Set();
  const result = [];
  (nodes || []).some((node) => {
    const id = str(node.id);
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push({
        id, name: str(node.name), type: str(node.type) || 'other', parentId: str(node.parentId),
      });
    }
    return result.length >= LIMITS.NODES;
  });
  return result;
};

/**
 * Previous execution doc + decoded ExecutionStateMessage -> { doc, steps, nodesChanged }:
 * the new doc, the steps that finished with this message (leaf nodes that were
 * running and now are in a final state), and whether the message carried the
 * tree. `runningSince` in the doc remembers when each running node started.
 */
exports.nextExecution = (prev, msg, now = Date.now()) => {
  const ts = toMs(msg.ts, now);
  const cycleId = str(msg.cycleId);
  const sameCycle = prev && prev.cycleId === cycleId;
  const msgNodes = treeNodes(msg.nodes);
  const nodesChanged = msgNodes.length > 0;
  const nodes = nodesChanged ? msgNodes : ((prev && prev.nodes) || []);
  const parents = new Set(nodes.map((n) => n.parentId).filter(Boolean));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const nodeStates = (msg.nodeStates || []).slice(0, LIMITS.NODES)
    .map(({ nodeId, state }) => ({ nodeId: str(nodeId), state: str(state) }))
    .filter((s) => s.nodeId);

  const prevStates = sameCycle
    ? new Map((prev.nodeStates || []).map((s) => [s.nodeId, s.state])) : new Map();
  const prevSince = sameCycle
    ? new Map((prev.runningSince || []).map((r) => [r.nodeId, r.ts])) : new Map();
  const steps = [];
  const runningSince = [];
  nodeStates.forEach(({ nodeId, state }) => {
    if (state === 'running') {
      runningSince.push({ nodeId, ts: prevSince.get(nodeId) ?? ts });
    } else if (FINAL_STATES.includes(state) && prevStates.get(nodeId) === 'running' && !parents.has(nodeId)) {
      const node = nodeById.get(nodeId) || { name: nodeId, type: 'other' };
      steps.push({
        cycleId,
        nodeId,
        name: node.name,
        type: node.type,
        startTs: prevSince.get(nodeId) ?? prev.ts,
        endTs: ts,
        result: state,
      });
    }
  });

  return {
    doc: {
      treeId: str(msg.treeId),
      treeName: str(msg.treeName),
      nodes,
      nodeStates,
      runningSince,
      status: str(msg.status) || 'idle',
      currentNodeId: str(msg.currentNodeId),
      error: str(msg.error, LIMITS.TEXT_LENGTH),
      cycleId,
      // Not sent: when the cycle was first seen
      cycleStartTs: rawMs(msg.cycleStartTs)
        ? toMs(msg.cycleStartTs, now) : ((sameCycle && prev.cycleStartTs) || ts),
      ts,
    },
    steps,
    nodesChanged,
  };
};

const sameValue = (a, b) => (
  a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b))
);

/**
 * Fields of the new execution doc to `$set` over `prev` (the stored doc): the
 * ones that changed, with `nodes` only when the message carried the tree. With
 * no `prev`, the whole doc.
 */
exports.executionChanges = (prev, doc, nodesChanged) => {
  if (!prev) return { ...doc };
  const changes = {};
  Object.entries(doc).forEach(([key, value]) => {
    if (key === 'nodes' && !nodesChanged) return;
    if (!sameValue(prev[key], value)) changes[key] = value;
  });
  return changes;
};

/**
 * Behavior tree nodes -> rows to draw, depth first: [{ node, depth, isLeaf }].
 * Safe with any input: nodes without id, cycles and repeated ids are drawn at
 * most once, and the depth is capped at LIMITS.TREE_DEPTH.
 */
exports.treeRows = (nodes) => {
  const childrenOf = new Map();
  (nodes || []).forEach((node) => {
    if (!node || !node.id) return;
    const parentId = node.parentId || '';
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
    childrenOf.get(parentId).push(node);
  });
  const rows = [];
  const visited = new Set();
  const visit = (node, depth) => {
    if (visited.has(node.id) || depth > LIMITS.TREE_DEPTH) return;
    visited.add(node.id);
    const children = childrenOf.get(node.id) || [];
    rows.push({ node, depth, isLeaf: children.length === 0 });
    children.forEach((child) => visit(child, depth + 1));
  };
  (childrenOf.get('') || []).forEach((root) => visit(root, 0));
  return rows;
};

/**
 * Decoded PerceptionResultMessage -> perception_results doc (image as base64,
 * with its whitelisted mime type and size). An image bigger than
 * LIMITS.PERCEPTION_IMAGE_BYTES is dropped (`imageDropped: true`); the rest of
 * the result is kept.
 */
exports.perceptionDoc = (msg, now = Date.now()) => {
  const size = msg.image ? msg.image.length : 0;
  const imageDropped = size > LIMITS.PERCEPTION_IMAGE_BYTES;
  return {
    ts: toMs(msg.ts, now),
    cameraId: str(msg.cameraId),
    cycleId: str(msg.cycleId),
    // Checked before encoding, so a big image is never copied
    image: size && !imageDropped
      ? { mime: imageMime(msg.imageMime), size, data: Buffer.from(msg.image).toString('base64') }
      : null,
    imageDropped,
    width: msg.width || 0,
    height: msg.height || 0,
    detections: (msg.detections || []).slice(0, LIMITS.DETECTIONS).map((d) => ({
      label: str(d.label), score: d.score, bbox: [d.x, d.y, d.width, d.height],
    })),
    poses: (msg.poses || []).slice(0, LIMITS.POSES).map((p) => ({
      objectId: str(p.objectId),
      pose: poseDoc(p.pose),
      confidence: p.confidence,
      axes: p.axisOrigin
        ? { origin: point2(p.axisOrigin), x: point2(p.axisX), y: point2(p.axisY), z: point2(p.axisZ) }
        : null,
    })),
    success: !!msg.success,
    error: str(msg.error, LIMITS.TEXT_LENGTH),
  };
};
