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

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nextExecution, executionChanges, treeRows, perceptionDoc, imageMime, toMs, SDK_RANGE, LIMITS,
} = require('../shared');
const sdkPkg = require('../../../packages/oro-plugin-sdk/package.json');
const { satisfies } = require('../../../packages/oro-plugin-sdk/lib/semver');

const NODES = [
  { id: 'root', name: 'grab', type: 'sequence' },
  { id: 'move', name: 'Move to view', type: 'move', parentId: 'root' },
  { id: 'capture', name: 'Capture', type: 'perception', parentId: 'root' },
];
const msg = (ts, states, extra = {}) => ({
  ts,
  cycleId: 'c1',
  nodes: [],
  status: 'running',
  ...extra,
  nodeStates: Object.entries(states).map(([nodeId, state]) => ({ nodeId, state })),
});

test('nextExecution: records a step when a running leaf finishes, with the time it started', () => {
  const first = nextExecution(null, msg(1000, { root: 'running', move: 'running' }, { nodes: NODES }));
  assert.deepEqual(first.steps, []);
  assert.deepEqual(first.doc.runningSince, [{ nodeId: 'root', ts: 1000 }, { nodeId: 'move', ts: 1000 }]);

  const second = nextExecution(first.doc, msg(2500, { root: 'running', move: 'succeeded', capture: 'running' }));
  assert.deepEqual(second.steps, [{
    cycleId: 'c1', nodeId: 'move', name: 'Move to view', type: 'move', startTs: 1000, endTs: 2500, result: 'succeeded',
  }]);
  // The tree is kept when a message does not resend it
  assert.equal(second.doc.nodes.length, 3);
  assert.deepEqual(second.doc.runningSince, [{ nodeId: 'root', ts: 1000 }, { nodeId: 'capture', ts: 2500 }]);
});

test('nextExecution: does not record parent nodes, nor nodes running in a previous cycle', () => {
  const first = nextExecution(null, msg(1000, { root: 'running', move: 'running' }, { nodes: NODES }));
  const done = nextExecution(first.doc, msg(2000, { root: 'failed', move: 'failed' }));
  assert.deepEqual(done.steps.map((s) => s.nodeId), ['move']);

  const otherCycle = nextExecution(first.doc, msg(2000, { move: 'succeeded' }, { cycleId: 'c2' }));
  assert.deepEqual(otherCycle.steps, []);
});

test('perceptionDoc: image as base64, boxes and projected axes as arrays', () => {
  const doc = perceptionDoc({
    ts: 7,
    cameraId: 'wrist',
    image: Buffer.from('jpeg'),
    width: 640,
    height: 480,
    detections: [{ label: 'piece', score: 0.5, x: 10, y: 20, width: 30, height: 40 }],
    poses: [{ objectId: 'piece', confidence: 0.8, axisOrigin: { u: 25, v: 40 }, axisX: { u: 40 } }],
    success: true,
  });
  assert.deepEqual(doc.image, { mime: 'image/jpeg', size: 4, data: Buffer.from('jpeg').toString('base64') });
  assert.equal(doc.imageDropped, false);
  assert.deepEqual(doc.detections, [{ label: 'piece', score: 0.5, bbox: [10, 20, 30, 40] }]);
  assert.deepEqual(doc.poses[0].axes, { origin: [25, 40], x: [40, 0], y: null, z: null });
  assert.deepEqual(doc.poses[0].pose, { position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
  assert.equal(perceptionDoc({ ts: 1 }).image, null);
});

test('nextExecution: drops nodes and states without id, repeated ids, and caps their number', () => {
  const nodes = [
    { id: '', name: 'no id', parentId: '' },
    { id: 'a', name: 'A' },
    { id: 'a', name: 'A again' },
    ...Array.from({ length: LIMITS.NODES + 10 }, (_, i) => ({ id: `n${i}`, parentId: 'a' })),
  ];
  const { doc, nodesChanged } = nextExecution(null, msg(1000, { '': 'running', a: 'running' }, { nodes }), 5000);
  assert.equal(nodesChanged, true);
  assert.equal(doc.nodes.length, LIMITS.NODES);
  assert.deepEqual(doc.nodes[0], { id: 'a', name: 'A', type: 'other', parentId: '' });
  assert.ok(doc.nodes.every((n) => n.id));
  assert.deepEqual(doc.nodeStates, [{ nodeId: 'a', state: 'running' }]);

  const many = Object.fromEntries(Array.from({ length: LIMITS.NODES + 5 }, (_, i) => [`s${i}`, 'idle']));
  assert.equal(nextExecution(null, msg(1000, many), 5000).doc.nodeStates.length, LIMITS.NODES);
});

test('nextExecution: cuts long strings', () => {
  const long = 'x'.repeat(10000);
  const { doc } = nextExecution(null, msg(1000, { [long]: 'running' }, {
    nodes: [{ id: long, name: long, type: long }], treeName: long, error: long, cycleId: long, status: long,
  }), 5000);
  assert.equal(doc.nodes[0].id.length, LIMITS.ID_LENGTH);
  assert.equal(doc.nodes[0].name.length, LIMITS.ID_LENGTH);
  assert.equal(doc.nodeStates[0].nodeId.length, LIMITS.ID_LENGTH);
  assert.equal(doc.treeName.length, LIMITS.ID_LENGTH);
  assert.equal(doc.cycleId.length, LIMITS.ID_LENGTH);
  assert.equal(doc.status.length, LIMITS.ID_LENGTH);
  assert.equal(doc.error.length, LIMITS.TEXT_LENGTH);
});

test('nextExecution: robot timestamps in the future become the server time', () => {
  const now = 1_000_000;
  const first = nextExecution(null, msg(now + 3600e3, { move: 'running' }, { nodes: NODES, cycleStartTs: now + 3600e3 }), now);
  assert.equal(first.doc.ts, now);
  assert.equal(first.doc.cycleStartTs, now);
  assert.deepEqual(first.doc.runningSince, [{ nodeId: 'move', ts: now }]);
  const done = nextExecution(first.doc, msg(now + 999e3, { move: 'succeeded' }), now + 2000);
  assert.deepEqual([done.steps[0].startTs, done.steps[0].endTs], [now, now + 2000]);
  // Slightly ahead (clock skew) is kept; missing cycleStartTs is the message ts
  const skewed = nextExecution(null, msg(now + 30e3, {}), now);
  assert.equal(skewed.doc.ts, now + 30e3);
  assert.equal(skewed.doc.cycleStartTs, now + 30e3);
  assert.equal(toMs(0, now), now);
  assert.equal(toMs({ toNumber: () => 5 }, now), 5);
});

test('executionChanges: only the changed fields, nodes only when the message carried them', () => {
  const first = nextExecution(null, msg(1000, { root: 'running', move: 'running' }, { nodes: NODES }), 5000);
  assert.deepEqual(executionChanges(null, first.doc, first.nodesChanged), first.doc);

  const second = nextExecution(first.doc, msg(2000, { root: 'running', move: 'running' }), 5000);
  assert.equal(second.nodesChanged, false);
  assert.deepEqual(executionChanges(first.doc, second.doc, second.nodesChanged), { ts: 2000 });

  const third = nextExecution(second.doc, msg(3000, { root: 'running', move: 'succeeded' }, { nodes: NODES }), 5000);
  const changes = executionChanges(second.doc, third.doc, third.nodesChanged);
  assert.deepEqual(Object.keys(changes).sort(), ['nodeStates', 'runningSince', 'ts']);

  const renamed = NODES.map((n) => ({ ...n, name: `${n.name}!` }));
  const fourth = nextExecution(third.doc, msg(3000, { root: 'running', move: 'succeeded' }, { nodes: renamed }), 5000);
  assert.deepEqual(Object.keys(executionChanges(third.doc, fourth.doc, fourth.nodesChanged)), ['nodes']);
});

test('treeRows: depth first, safe with missing ids, cycles and deep trees', () => {
  assert.deepEqual(treeRows(NODES).map((r) => [r.node.id, r.depth, r.isLeaf]), [
    ['root', 0, false], ['move', 1, true], ['capture', 1, true],
  ]);
  // A node with an empty id would be its children's parent '' (the roots): never recurse into it
  assert.deepEqual(treeRows([{ id: '', parentId: '' }, { id: 'a' }]).map((r) => r.node.id), ['a']);
  // Cycles unreachable from a root, a self parent, repeated ids
  assert.deepEqual(treeRows([
    { id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }, { id: 's', parentId: 's' }, { id: 'r' }, { id: 'r' },
  ]).map((r) => r.node.id), ['r']);
  const deep = Array.from({ length: 500 }, (_, i) => ({ id: `d${i}`, parentId: i ? `d${i - 1}` : '' }));
  assert.equal(treeRows(deep).length, LIMITS.TREE_DEPTH + 1);
  assert.deepEqual(treeRows(undefined), []);
});

test('perceptionDoc: whitelists the image mime type', () => {
  const doc = (mime) => perceptionDoc({ ts: 1, image: Buffer.from('img'), imageMime: mime }).image.mime;
  assert.equal(doc('image/png'), 'image/png');
  assert.equal(doc('image/webp'), 'image/webp');
  assert.equal(doc('image/svg+xml'), 'image/jpeg');
  assert.equal(doc('image/png");background:url(https://evil'), 'image/jpeg');
  assert.equal(doc(undefined), 'image/jpeg');
  assert.equal(imageMime('image/jpeg\n'), 'image/jpeg');
  assert.equal(imageMime(42), 'image/jpeg');
});

test('perceptionDoc: drops images over the limit, keeps the result; caps lists and strings', () => {
  const big = perceptionDoc({
    ts: 1,
    image: Buffer.alloc(LIMITS.PERCEPTION_IMAGE_BYTES + 1),
    success: true,
    error: 'e'.repeat(5000),
    cameraId: 'c'.repeat(5000),
    detections: Array.from({ length: LIMITS.DETECTIONS + 5 }, () => ({ label: 'l'.repeat(5000) })),
    poses: Array.from({ length: LIMITS.POSES + 5 }, () => ({ objectId: 'o' })),
  });
  assert.equal(big.image, null);
  assert.equal(big.imageDropped, true);
  assert.equal(big.success, true);
  assert.equal(big.error.length, LIMITS.TEXT_LENGTH);
  assert.equal(big.cameraId.length, LIMITS.ID_LENGTH);
  assert.equal(big.detections.length, LIMITS.DETECTIONS);
  assert.equal(big.detections[0].label.length, LIMITS.ID_LENGTH);
  assert.equal(big.poses.length, LIMITS.POSES);
  const atLimit = perceptionDoc({ ts: 1, image: Buffer.alloc(LIMITS.PERCEPTION_IMAGE_BYTES) });
  assert.equal(atLimit.image.size, LIMITS.PERCEPTION_IMAGE_BYTES);
});

test('perceptionDoc: robot timestamps in the future become the server time', () => {
  assert.equal(perceptionDoc({ ts: 10_000_000 }, 1000).ts, 1000);
  assert.equal(perceptionDoc({ ts: 500 }, 1000).ts, 500);
  assert.equal(perceptionDoc({}, 1000).ts, 1000);
});

test('SDK_RANGE accepts the SDK in this repo', () => {
  assert.ok(satisfies(sdkPkg.version, SDK_RANGE));
});
