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
  jointFieldName, parseJointStates, sceneDoc, poseDoc, JOINT_FIELD_PREFIX, SDK_RANGE,
  isJointName, isAllowedAssetUrl, normalizeOrigins, clampTs, toMs, JOINT_HISTORY_MAX_JOINTS,
  SCENE_MAX_ITEMS, MAX_STRING_LENGTH,
} = require('../shared');
const sdkPkg = require('../../../packages/oro-plugin-sdk/package.json');
const { satisfies } = require('../../../packages/oro-plugin-sdk/lib/semver');

test('jointFieldName: prefixed and reduced to [A-Za-z0-9_]', () => {
  assert.equal(JOINT_FIELD_PREFIX, 'robotmodel_joint_');
  assert.equal(jointFieldName('arm/elbow.1'), 'robotmodel_joint_arm_elbow_1');
  assert.equal(jointFieldName('shoulder'), 'robotmodel_joint_shoulder');
});

test('parseJointStates: pairs names and positions, drops non-finite ones', () => {
  assert.deepEqual(
    parseJointStates({ ts: 5, names: ['a', 'b', 'c'], positions: [1, NaN, 3] }),
    { names: ['a', 'c'], positions: [1, 3], ts: 5, skipped: 1 },
  );
  assert.equal(parseJointStates({ names: ['a'], positions: [] }), null);
  assert.equal(parseJointStates({ names: [], positions: [] }), null);
  assert.equal(parseJointStates({ names: ['a'], positions: [Infinity] }), null);
  // protobufjs int64 as Long
  assert.equal(parseJointStates({ ts: { toNumber: () => 7 }, names: ['a'], positions: [0] }).ts, 7);
});

test('isJointName: ROS-style names, no dots, $ or prototype keys, at most 128 chars', () => {
  ['shoulder_pan_joint', 'arm/elbow', 'ur5e::wrist-1', 'a'.repeat(128)].forEach((name) => {
    assert.ok(isJointName(name), name);
  });
  ['', 'a.b', '$set', 'a b', '__proto__', 'constructor', 'prototype', 'a'.repeat(129), 5, null]
    .forEach((name) => assert.ok(!isJointName(name), String(name)));
});

test('parseJointStates: skips invalid and colliding names, caps the joint count', () => {
  const parsed = parseJointStates({
    ts: 5, names: ['a/b', 'a_b', 'x.y', '__proto__', 'c'], positions: [1, 2, 3, 4, 5],
  });
  assert.deepEqual(parsed, { names: ['a/b', 'c'], positions: [1, 5], ts: 5, skipped: 3 });
  assert.equal(parseJointStates({ names: ['a.b'], positions: [1] }), null);

  const names = Array.from({ length: 100 }, (_, ix) => `j${ix}`);
  const many = parseJointStates({ ts: 5, names, positions: names.map(() => 0) });
  assert.equal(many.names.length, JOINT_HISTORY_MAX_JOINTS);
  assert.equal(many.names[63], 'j63');
  assert.equal(many.skipped, 100 - JOINT_HISTORY_MAX_JOINTS);
});

test('clampTs / toMs: future robot timestamps become now; missing ones are now', () => {
  const now = 1_000_000_000;
  assert.equal(clampTs(now + 30_000, now), now + 30_000);
  assert.equal(clampTs(now + 61_000, now), now);
  assert.equal(toMs(now + 3_600_000, now), now);
  assert.equal(toMs(0, now), now);
  assert.equal(toMs(undefined, now), now);
  assert.equal(toMs(-5, now), now);
  assert.equal(parseJointStates({ ts: now * 2, names: ['a'], positions: [0] }, now).ts, now);
});

test('poseDoc: an all-zero quaternion is identity', () => {
  assert.deepEqual(poseDoc(undefined), { position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
  assert.deepEqual(poseDoc({ x: 1, qz: 1 }), { position: [1, 0, 0], quaternion: [0, 0, 1, 0] });
});

test('sceneDoc: fills defaults', () => {
  const doc = sceneDoc({
    ts: 5,
    objects: [{ id: 'cart', size: [0.3, 0.2, 0.1], pose: { x: 1, z: 0.05 } }],
    frames: [{ id: 'grasp' }],
    attached: [{ objectId: 'piece', link: 'tool', pose: { z: 0.1 } }],
    plannedPath: [{ z: 1 }],
  });
  assert.deepEqual(doc.objects, [{
    id: 'cart', name: 'cart', shape: 'box', size: [0.3, 0.2, 0.1],
    pose: { position: [1, 0, 0.05], quaternion: [0, 0, 0, 1] }, color: '',
  }]);
  assert.equal(doc.frames[0].name, 'grasp');
  assert.deepEqual(doc.attached[0].pose.position, [0, 0, 0.1]);
  assert.deepEqual(doc.plannedPath, [[0, 0, 1]]);
  assert.equal(doc.ts, 5);
});

test('sceneDoc: caps lists and strings, sanitizes numbers and shapes', () => {
  const big = Array.from({ length: SCENE_MAX_ITEMS + 50 }, (_, ix) => ({ id: `o${ix}` }));
  const doc = sceneDoc({
    ts: 5,
    objects: [{ id: 'x'.repeat(500), shape: 'torus', size: [1, NaN, 2, 3, 4], color: '#'.repeat(100) }, ...big],
    frames: big,
    attached: big.map((o) => ({ objectId: o.id, link: 'l' })),
    plannedPath: big.map(() => ({ x: Infinity, y: 1, z: 2 })),
  });
  assert.equal(doc.objects.length, SCENE_MAX_ITEMS);
  assert.equal(doc.frames.length, SCENE_MAX_ITEMS);
  assert.equal(doc.attached.length, SCENE_MAX_ITEMS);
  assert.equal(doc.plannedPath.length, SCENE_MAX_ITEMS);
  assert.equal(doc.objects[0].id.length, MAX_STRING_LENGTH);
  assert.equal(doc.objects[0].shape, 'box');
  assert.deepEqual(doc.objects[0].size, [1, 0, 2]);
  assert.ok(doc.objects[0].color.length <= 32);
  assert.deepEqual(doc.plannedPath[0], [0, 1, 2]);
  assert.deepEqual(poseDoc({ x: NaN, qw: Infinity }), { position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
});

test('isAllowedAssetUrl: same-origin paths by default, listed origins otherwise', () => {
  ['/plugins/robotmodel/a.urdf', '/a', '/meshes/x%20y.glb'].forEach((u) => assert.ok(isAllowedAssetUrl(u), u));
  [
    '//evil.com/a.urdf', '/\\evil.com/a', '/a b', 'https://cdn.example.com/a.urdf', 'robot.urdf',
    'javascript:alert(1)', 'data:text/plain,x', '', null, `/${'a'.repeat(3000)}`,
  ].forEach((u) => assert.ok(!isAllowedAssetUrl(u), String(u)));

  const { origins, invalid } = normalizeOrigins([
    'https://cdn.example.com/', 'http://localhost:8080', 'ftp://x.com', 'not a url', 5,
  ]);
  assert.deepEqual(origins, ['https://cdn.example.com', 'http://localhost:8080']);
  assert.deepEqual(invalid, ['ftp://x.com', 'not a url', 5]);
  assert.ok(isAllowedAssetUrl('https://cdn.example.com/ur/a.urdf', origins));
  assert.ok(isAllowedAssetUrl('http://localhost:8080/a', origins));
  assert.ok(isAllowedAssetUrl('/a', origins));
  [
    'https://cdn.example.com.evil.com/a', 'http://cdn.example.com/a', 'https://evil.com/a',
    'https://cdn.example.com@evil.com/a', 'https://cdn.example.com:444/a', '//cdn.example.com/a',
  ].forEach((u) => assert.ok(!isAllowedAssetUrl(u, origins), u));
  assert.deepEqual(normalizeOrigins(undefined), { origins: [], invalid: [] });
});

test('SDK_RANGE accepts the SDK in this repo', () => {
  assert.ok(satisfies(sdkPkg.version, SDK_RANGE));
});
