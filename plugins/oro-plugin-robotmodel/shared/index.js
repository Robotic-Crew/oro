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
 * Constants and pure helpers shared by every runtime entry of the robotmodel
 * plugin. CommonJS on purpose: ingest and the plugin tests load it with plain Node.
 */
const { version } = require('../package.json');

const PLUGIN_ID = 'robotmodel';

exports.PLUGIN_ID = PLUGIN_ID;
exports.VERSION = version;
exports.SDK_RANGE = '^0.3.0';

exports.WIDGET_VIEWER = 'robotmodel:viewer';
exports.KIND_MODEL = 'RobotModel';
exports.KIND_ASSIGNMENT = 'RobotModelAssignment';
exports.PROTO_NAME = 'robotmodel.proto';

// Collections (plugin_robotmodel_<name>)
exports.COLLECTIONS = Object.freeze({
  // 3D models, one per robot type: { _id, label, urdf, packages, jointMap }
  MODELS: 'models',
  // Which model each robot uses: { _id: robotId, model }
  ASSIGNMENTS: 'assignments',
  // Latest (downsampled) joint positions: { _id: robotId, names, positions, ts }
  JOINT_STATES: 'joint_states',
  // Latest cell scene: { _id: robotId, objects, frames, attached, plannedPath, ts }
  SCENES: 'scenes',
});

// Publications and methods (plugin.robotmodel.<name>)
exports.ENDPOINTS = Object.freeze({
  ASSIGNMENT: 'assignment',
  MODEL: 'model',
  JOINT_STATES: 'jointStates',
  SCENE: 'scene',
  JOINT_HISTORY: 'jointHistory',
});

// MQTT subtopics (r/<robotId>/<subtopic>)
exports.SUBTOPICS = Object.freeze({
  JOINT_STATES: 'ros/joint_states',
  SCENE: 'robotmodel/scene',
});

exports.TYPES = Object.freeze({
  JOINT_STATES: 'oro.robotmodel.JointStatesMessage',
  SCENE: 'oro.robotmodel.SceneMessage',
});

// Ingest looks at one joint states message per robot every persistIntervalMs
// (5 Hz is plenty to replay arm motion, clients interpolate between samples)
exports.DEFAULT_PERSIST_INTERVAL_MS = 200;
exports.MIN_PERSIST_INTERVAL_MS = 50;
// ...writes the snapshot document at most this often, and only when it changed
// (live viewers get MQTT; the snapshot is the initial pose and the ghost feed)
exports.DEFAULT_SNAPSHOT_INTERVAL_MS = 1000;
// ...and skips time series samples where no joint moved more than the deadband
// (rad or m), except for a keepalive sample every keepaliveMs
exports.DEFAULT_JOINT_DEADBAND = 1e-3;
exports.DEFAULT_KEEPALIVE_MS = 10000;
// Scenes: at most one stored per robot every SCENE_INTERVAL_MS (the latest one wins)
exports.SCENE_INTERVAL_MS = 500;

// Payload caps
exports.JOINT_STATES_MAX_BYTES = 64 * 1024;
exports.SCENE_MAX_BYTES = 1024 * 1024;
exports.SCENE_MAX_ITEMS = 1000;
exports.MAX_STRING_LENGTH = 128;
exports.MAX_COLOR_LENGTH = 32;
// Robot timestamps further than this in the future are replaced by now
exports.MAX_FUTURE_MS = 60 * 1000;

// Replay caps: 20k points at 5 Hz is ~1 hour
exports.JOINT_HISTORY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
exports.JOINT_HISTORY_MAX_POINTS = 20000;
// Also the most joints kept from one joint states message
exports.JOINT_HISTORY_MAX_JOINTS = 64;

/**
 * Accepted joint names (and keys of RobotModel.jointMap / RobotModelAssignment.joints):
 * ROS-style names, 1-128 characters, no `.` or `$` so they are also safe Mongo keys, and not
 * an Object.prototype key.
 */
const JOINT_NAME_RE = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_\-/:]{1,128}$/;
exports.JOINT_NAME_RE = JOINT_NAME_RE;
const isJointName = (name) => typeof name === 'string' && JOINT_NAME_RE.test(name);
exports.isJointName = isJointName;

const JOINT_FIELD_PREFIX = `${PLUGIN_ID}_joint_`;
exports.JOINT_FIELD_PREFIX = JOINT_FIELD_PREFIX;

/**
 * Time series field holding one joint's position: `robotmodel_joint_<name>`,
 * with the name reduced to [A-Za-z0-9_] so it is a plain top-level key.
 */
const jointFieldName = (name) => JOINT_FIELD_PREFIX + String(name).replace(/[^A-Za-z0-9_]/g, '_');
exports.jointFieldName = jointFieldName;

/** Robot timestamp -> ms: robot clocks far in the future are replaced by now */
const clampTs = (ts, now = Date.now()) => (ts > now + exports.MAX_FUTURE_MS ? now : ts);
exports.clampTs = clampTs;

/** int64 from protobufjs (Long or number) -> ms, or now when missing; clamped (see clampTs) */
const toMs = (ts, now = Date.now()) => {
  const ms = ts && typeof ts === 'object' ? ts.toNumber() : Number(ts);
  return Number.isFinite(ms) && ms > 0 ? clampTs(ms, now) : now;
};
exports.toMs = toMs;

/**
 * Decoded JointStatesMessage -> { names, positions, ts, skipped }, keeping the
 * first JOINT_HISTORY_MAX_JOINTS joints with a valid name (see JOINT_NAME_RE)
 * and a finite position. A name whose time series field is already taken by
 * an earlier joint (e.g. `a/b` and `a_b`) is skipped too. `skipped` counts
 * the joints left out. Returns null when names and positions don't pair up or
 * no joint is left.
 */
exports.parseJointStates = ({ ts, names = [], positions = [] } = {}, now = Date.now()) => {
  if (names.length === 0 || names.length !== positions.length) return null;
  const kept = { names: [], positions: [] };
  const fields = new Set();
  for (let ix = 0; ix < names.length && kept.names.length < exports.JOINT_HISTORY_MAX_JOINTS; ix += 1) {
    const name = names[ix];
    const position = positions[ix];
    if (isJointName(name) && Number.isFinite(position) && !fields.has(jointFieldName(name))) {
      fields.add(jointFieldName(name));
      kept.names.push(name);
      kept.positions.push(position);
    }
  }
  if (kept.names.length === 0) return null;
  return { ...kept, ts: toMs(ts, now), skipped: names.length - kept.names.length };
};

const finite = (x) => (Number.isFinite(x) ? x : 0);
const str = (s, max = exports.MAX_STRING_LENGTH) => (typeof s === 'string' ? s.slice(0, max) : '');
const SHAPES = ['box', 'cylinder', 'sphere'];

/** Pose3D -> { position: [x, y, z], quaternion: [x, y, z, w] } (all-zero quaternion = identity) */
const poseDoc = (pose) => {
  const { x, y, z, qx, qy, qz, qw } = pose || {};
  const q = [qx, qy, qz, qw].map(finite);
  const identity = q.every((c) => c === 0);
  return { position: [x, y, z].map(finite), quaternion: identity ? [0, 0, 0, 1] : q };
};
exports.poseDoc = poseDoc;

const capped = (list) => (Array.isArray(list) ? list.slice(0, exports.SCENE_MAX_ITEMS) : []);

/**
 * Decoded SceneMessage -> the `scenes` document. Lists are capped at
 * SCENE_MAX_ITEMS, strings at MAX_STRING_LENGTH, non-finite numbers become 0
 * and unknown shapes become boxes.
 */
exports.sceneDoc = (msg, now = Date.now()) => ({
  objects: capped(msg.objects).map((o) => {
    const id = str(o.id);
    return {
      id,
      name: str(o.name) || id,
      shape: SHAPES.includes(o.shape) ? o.shape : 'box',
      size: capped(o.size).slice(0, 3).map(finite),
      pose: poseDoc(o.pose),
      color: str(o.color, exports.MAX_COLOR_LENGTH),
    };
  }),
  frames: capped(msg.frames).map((f) => {
    const id = str(f.id);
    return { id, name: str(f.name) || id, pose: poseDoc(f.pose) };
  }),
  attached: capped(msg.attached).map((a) => ({
    objectId: str(a.objectId), link: str(a.link), pose: poseDoc(a.pose),
  })),
  plannedPath: capped(msg.plannedPath).map((p) => [finite(p.x), finite(p.y), finite(p.z)]),
  ts: toMs(msg.ts, now),
});

/**
 * Origins (`https://host[:port]`) of `allowedAssetOrigins`, ignoring entries
 * that aren't http(s) origins. Returns { origins, invalid }.
 */
exports.normalizeOrigins = (list) => {
  const origins = [];
  const invalid = [];
  (Array.isArray(list) ? list : []).forEach((entry) => {
    try {
      const u = new URL(String(entry));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
      origins.push(u.origin);
    } catch (e) {
      invalid.push(entry);
    }
  });
  return { origins, invalid };
};

// A path on the app's own origin: one leading `/`, not `//host` (nor `/\host`,
// which browsers read the same), no whitespace or backslashes
const SAME_ORIGIN_PATH_RE = /^\/(?![/\\])[^\s\\]*$/;

/**
 * Whether a model asset URL may be loaded by the browser: a path on the app's
 * origin, or an absolute http(s) URL whose origin is in `allowedOrigins`
 * (normalized, see normalizeOrigins).
 */
exports.isAllowedAssetUrl = (value, allowedOrigins = []) => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  if (SAME_ORIGIN_PATH_RE.test(value)) return true;
  if (!allowedOrigins.length || /[\s\\]/.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && allowedOrigins.includes(u.origin);
  } catch (e) {
    return false;
  }
};
