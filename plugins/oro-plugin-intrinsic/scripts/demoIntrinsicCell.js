'use strict';

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
 * Demo of a skill-based cell (e.g. Intrinsic Core) for the Execution, Cycle Timeline, Perception
 * and 3D Model widgets: a ghost arm doing pick-and-place cycles from two lanes onto a drop
 * station, with a grasp or a detection failing now and then.
 *
 * Run it from ingest/, which has the mqtt and protobufjs dependencies and settings.json:
 *
 *   node --preserve-symlinks --preserve-symlinks-main \
 *     node_modules/oro-plugin-intrinsic/scripts/demoIntrinsicCell.js \
 *     [--robot cell-1] [--app http://localhost:3000] [--settings settings.json] \
 *     [--app-settings ../app/settings.json]
 *
 * Needs the app and ingest running with the intrinsic and robotmodel plugins enabled. It applies
 * (idempotently, through the config API with the app's peer key) the `demo-arm` RobotModel, a
 * ghost Robot, its RobotModelAssignment and the "Intrinsic Cell" dashboard,
 * then publishes over MQTT what an agent on a real cell would (with ingest's broker credentials,
 * so it works for a ghost robot):
 * - r/<robot>/state: online, retained (offline as last will)
 * - r/<robot>/ros/joint_states: JointStatesMessage
 * - r/<robot>/intrinsic/{execution,perception}: ExecutionStateMessage, PerceptionResultMessage
 *   (oro.intrinsic; ingest derives the cycle steps from the execution states)
 * - r/<robot>/robotmodel/scene: SceneMessage (oro.robotmodel)
 * - r/<robot>/custom: a summary of the cell as key-values (cell_state, current_step, ...), which
 *   any ORO or InOrbit dashboard can show without the cell widgets, e.g. when forwarded upstream
 *
 * Run ./import.sh first (it copies oro.proto into src/shared). See the plugin README.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mqtt = require('mqtt');
const protobuf = require('protobufjs');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const ix = args.indexOf(`--${name}`);
  return ix >= 0 ? args[ix + 1] : fallback;
};
const ROBOT_ID = option('robot', 'cell-1');
const APP_URL = option('app', 'http://localhost:3000');
// The app's peer key goes with each config request: never in clear text to another host
{
  const { protocol, hostname } = new URL(APP_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  if (protocol !== 'https:' && !(protocol === 'http:' && local)) {
    console.error(`Refusing --app ${APP_URL}: use https:// (plain http:// only to localhost), it sends the peer key`);
    process.exit(1);
  }
}
const SETTINGS_PATH = path.resolve(option('settings', 'settings.json'));
const APP_SETTINGS_PATH = path.resolve(option('app-settings', path.join('..', 'app', 'settings.json')));
const TICK_MS = 100;
// Key-values go in custom data with this custom_field, as the InOrbit agents do
const KEY_VALUES_FIELD = '0';

// --- Demo arm kinematics (oro-plugin-robotmodel public/demo-arm/demo_arm.urdf) -----------------------

const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow', 'wrist_pitch', 'wrist_roll', 'finger_left'];
const rz = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const ry = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const mul = (A, B) => A.map(row => [0, 1, 2].map(j => row.reduce((s, v, k) => s + v * B[k][j], 0)));
const apply = (A, v) => A.map(row => row.reduce((s, x, k) => s + x * v[k], 0));

/** Tool tip (between the fingers) position for joints [pan, lift, elbow, pitch, roll] */
const toolTip = (q) => {
  let p = [0, 0, 0.08];
  let R = rz(q[0]);
  [[0.14, ry(q[1])], [0.4, ry(q[2])], [0.34, ry(q[3])], [0.1, rz(q[4])]].forEach(([offset, rot]) => {
    p = p.map((x, i) => x + apply(R, [0, 0, offset])[i]);
    R = mul(R, rot);
  });
  return p.map((x, i) => x + apply(R, [0, 0, 0.11])[i]);
};

// Arm poses (tool pointing down over the lanes and the drop station); fingers set separately
const lanePose = (pan, lift, elbow, pitch) => [pan, lift, elbow, pitch, 0];
const POSES = {
  standby: lanePose(0, -0.3, 1.7, 1.2),
  left: { view: lanePose(0.8, 0.15, 1.35, 1.6), above: lanePose(0.8, 0.45, 1.35, 1.34), grasp: lanePose(0.8, 0.7, 1.25, 1.19) },
  right: { view: lanePose(-0.8, 0.15, 1.35, 1.6), above: lanePose(-0.8, 0.45, 1.35, 1.34), grasp: lanePose(-0.8, 0.7, 1.25, 1.19) },
  aboveDrop: lanePose(2.6, 0.2, 1.2, 1.74),
  drop: lanePose(2.6, 0.4, 1.15, 1.59),
};
const FINGERS = { open: 0.045, closed: 0.008, holding: 0.03 };

// --- Scene ----------------------------------------------------------------------------------------

const DOWN = [1, 0, 0, 0]; // tool frames: rotated 180° about X
const pose = (position, quaternion = [0, 0, 0, 1]) => ({ position, quaternion });
/** { position, quaternion } -> Pose3D */
const pose3D = ({ position: [x, y, z], quaternion: [qx, qy, qz, qw] }) => ({ x, y, z, qx, qy, qz, qw });
const frameAt = (id, q) => ({ id, name: id, pose: pose(toolTip(q), DOWN) });
const graspTip = lane => toolTip(POSES[lane].grasp);

const PIECE_SIZE = [0.06, 0.06, 0.08];
const pieceRestingPose = (lane) => {
  const [x, y, z] = graspTip(lane);
  return pose([x, y, z - 0.02]);
};
const STATIC_OBJECTS = ['left', 'right'].map((lane) => {
  const [x, y] = graspTip(lane);
  const top = graspTip(lane)[2] - 0.06;
  return {
    id: `cart_${lane}`, name: `Cart ${lane}`, shape: 'box', size: [0.26, 0.22, top], pose: pose([x, y, top / 2]), color: '#6b7280',
  };
}).concat([{
  id: 'drop_station', name: 'Drop station', shape: 'box', size: [0.34, 0.34, 0.3],
  pose: pose([toolTip(POSES.drop)[0], toolTip(POSES.drop)[1], 0.15]), color: '#94a3b8',
}]);
const FRAMES = [
  frameAt('standby', POSES.standby),
  frameAt('lane_left_view', POSES.left.view), frameAt('lane_left_grasp', POSES.left.grasp),
  frameAt('lane_right_view', POSES.right.view), frameAt('lane_right_grasp', POSES.right.grasp),
  frameAt('drop', POSES.drop),
];

// --- Behavior tree -----------------------------------------------------------------------------------

const TREE = [
  { id: 'full', name: 'Pick and place', type: 'sequence' },
  { id: 'grab', name: 'grab', type: 'sequence', parentId: 'full' },
  { id: 'standby', name: 'Move to standby', type: 'move', parentId: 'grab' },
  { id: 'view', name: 'Move to lane view', type: 'move', parentId: 'grab' },
  { id: 'close_view', name: 'Close fingers', type: 'gripper', parentId: 'grab' },
  { id: 'estimate', name: 'Capture + estimate pose', type: 'perception', parentId: 'grab' },
  { id: 'open', name: 'Open gripper', type: 'gripper', parentId: 'grab' },
  { id: 'approach', name: 'Approach piece', type: 'move', parentId: 'grab' },
  { id: 'descend', name: 'Descend to piece', type: 'move', parentId: 'grab' },
  { id: 'close', name: 'Close gripper', type: 'gripper', parentId: 'grab' },
  { id: 'check', name: 'Grasp check', type: 'gripper', parentId: 'grab' },
  { id: 'lift', name: 'Lift', type: 'move', parentId: 'grab' },
  { id: 'over_drop', name: 'Move over drop station', type: 'move', parentId: 'grab' },
  { id: 'wait', name: 'Wait for AMR', type: 'wait', parentId: 'grab' },
  { id: 'release', name: 'release', type: 'sequence', parentId: 'full' },
  { id: 'lower', name: 'Lower onto station', type: 'move', parentId: 'release' },
  { id: 'let_go', name: 'Open gripper', type: 'gripper', parentId: 'release' },
  { id: 'retreat', name: 'Retreat', type: 'move', parentId: 'release' },
  { id: 'home', name: 'Return to standby', type: 'move', parentId: 'release' },
];
const parentOf = Object.fromEntries(TREE.map(n => [n.id, n.parentId]));

/** The steps of one cycle on `lane`: { node, seconds, arm?, fingers?, onEnd? } */
const cycleSteps = lane => [
  { node: 'standby', seconds: 1.2, arm: POSES.standby, fingers: FINGERS.open },
  { node: 'view', seconds: 1.8, arm: POSES[lane].view },
  { node: 'close_view', seconds: 0.5, fingers: FINGERS.closed },
  { node: 'estimate', seconds: 1.1 + Math.random() * 0.6, perception: true },
  { node: 'open', seconds: 0.5, fingers: FINGERS.open },
  { node: 'approach', seconds: 1.3, arm: POSES[lane].above },
  { node: 'descend', seconds: 0.9, arm: POSES[lane].grasp },
  { node: 'close', seconds: 0.7, fingers: FINGERS.holding },
  { node: 'check', seconds: 0.4, graspCheck: true },
  { node: 'lift', seconds: 0.8, arm: POSES[lane].above },
  { node: 'over_drop', seconds: 2.2, arm: POSES.aboveDrop },
  { node: 'wait', seconds: 0.8 + Math.random() * 3 },
  { node: 'lower', seconds: 1.0, arm: POSES.drop },
  { node: 'let_go', seconds: 0.5, fingers: FINGERS.open, release: true },
  { node: 'retreat', seconds: 0.7, arm: POSES.aboveDrop },
  { node: 'home', seconds: 2.0, arm: POSES.standby },
];

// --- Perception: a synthetic top-down capture of the lane ---------------------------------------

const W = 640;
const H = 400;
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const mixColor = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const COLORS = {
  floor: rgb('#55595f'), border: rgb('#3b3e43'), light: rgb('#d9dbde'), dark: rgb('#8e9298'),
  line: rgb('#b9bcc1'), piece: rgb('#3f5fbf'), pieceTop: rgb('#5577d6'),
};
const TRAY = { x0: 90, y0: 40, x1: W - 90, y1: H - 40 };

/** Color of a pixel of the capture: a lit tray with lane lines and, maybe, the piece */
const capturePixel = (x, y, piece) => {
  if (piece) {
    const u = Math.abs((x - piece.cx) * piece.cos + (y - piece.cy) * piece.sin);
    const v = Math.abs(-(x - piece.cx) * piece.sin + (y - piece.cy) * piece.cos);
    if (u <= 40 && v <= 40) return COLORS.pieceTop;
    if (u <= 55 && v <= 55) return COLORS.piece;
  }
  const { x0, y0, x1, y1 } = TRAY;
  if (x < x0 - 3 || x > x1 + 3 || y < y0 - 3 || y > y1 + 3) return COLORS.floor;
  if (x < x0 + 3 || x > x1 - 3 || y < y0 + 3 || y > y1 - 3) return COLORS.border;
  if (y >= 60 && y <= H - 60 && [0, 1, 2, 3].some(i => Math.abs(x - (130 + i * 110)) < 1)) return COLORS.line;
  const d = Math.hypot(x - W / 2, (y - H * 0.45) * 1.4) / (0.7 * (x1 - x0));
  return mixColor(COLORS.light, COLORS.dark, Math.min(1, d));
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A synthetic top-down capture of the lane, as a PNG (perception images are jpeg, png or webp) */
const capturePng = ({ found, dx, dy, angle }) => {
  const rad = (angle * Math.PI) / 180;
  const piece = found ? { cx: W / 2 + dx, cy: H / 2 + dy, cos: Math.cos(rad), sin: Math.sin(rad) } : null;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y += 1) {
    const row = y * (W * 3 + 1); // first byte: filter type 0
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = capturePixel(x + 0.5, y + 0.5, piece);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(W, 0);
  header.writeUInt32BE(H, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const perceptionResult = (lane, cycleId) => {
  const found = Math.random() > 0.08;
  const dx = (Math.random() - 0.5) * 120;
  const dy = (Math.random() - 0.5) * 80;
  const angle = (Math.random() - 0.5) * 50;
  const cx = W / 2 + dx;
  const cy = H / 2 + dy;
  const rad = (angle * Math.PI) / 180;
  const half = 55 * (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)));
  const confidence = 0.82 + Math.random() * 0.16;
  return {
    found,
    error: found ? '' : 'PieceNotFound: no detection above the score threshold',
    message: {
      ts: Date.now(),
      cameraId: 'wrist',
      cycleId,
      image: capturePng({ found, dx, dy, angle }),
      imageMime: 'image/png',
      width: W,
      height: H,
      detections: found ? [{
        label: `piece_${lane}`, score: 0.9 + Math.random() * 0.09,
        x: cx - half - 8, y: cy - half - 8, width: 2 * half + 16, height: 2 * half + 16,
      }] : [],
      poses: found ? [{
        objectId: `piece_${lane}`,
        pose: pose3D(pieceRestingPose(lane)),
        confidence,
        axisOrigin: { u: cx, v: cy },
        axisX: { u: cx + 70 * Math.cos(rad), v: cy + 70 * Math.sin(rad) },
        axisY: { u: cx + 70 * Math.sin(rad), v: cy - 70 * Math.cos(rad) },
        axisZ: { u: cx - 30, v: cy + 30 },
      }] : [],
      success: found,
      error: found ? '' : 'PieceNotFound: no detection above the score threshold',
    },
    confidence: found ? confidence : null,
  };
};

// --- Config (through the app's config API) ------------------------------------------------------

const DASHBOARD = {
  apiVersion: 'v0.1',
  kind: 'DashboardDefinition',
  metadata: { id: 'intrinsic-cell' },
  spec: {
    label: 'Intrinsic Cell',
    order: 10,
    sections: [{
      label: 'Cell',
      scope: 'robot',
      withControlWidget: true,
      widgets: [
        { label: '3D Model', type: 'robotmodel:viewer', layout: { chroma: true, grid: 7, height: 1 } },
        { label: 'Execution', type: 'intrinsic:execution', layout: { chroma: true, grid: 5, height: 1 } },
        { label: 'Perception', type: 'intrinsic:perception', layout: { chroma: true, grid: 5, height: 1 } },
        { label: 'Cycle Timeline', type: 'intrinsic:cycleTimeline', layout: { chroma: true, grid: 7, height: 1 } },
      ],
    }],
  },
};

const applyConfig = async () => {
  const { peerKey } = JSON.parse(fs.readFileSync(APP_SETTINGS_PATH));
  const objects = [
    { apiVersion: 'v0.1', kind: 'RobotModel', metadata: { id: 'demo-arm' }, spec: { label: 'Demo arm', urdf: '/plugins/robotmodel/demo-arm/demo_arm.urdf' } },
    { apiVersion: 'v0.1', kind: 'Robot', metadata: { id: ROBOT_ID, scope: '' }, spec: { label: 'Demo cell', ghost: true } },
    { apiVersion: 'v0.1', kind: 'RobotModelAssignment', metadata: { id: ROBOT_ID }, spec: { model: 'demo-arm' } },
    DASHBOARD,
  ];
  for (const object of objects) {
    const res = await fetch(`${APP_URL}/api/configuration/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-peer-key': peerKey },
      body: JSON.stringify(object),
    });
    if (!res.ok) {
      throw new Error(`Applying ${object.kind} ${object.metadata.id}: ${res.status} ${await res.text()}`);
    }
  }
  console.log(`Applied RobotModel demo-arm, ghost Robot ${ROBOT_ID} with its assignment and dashboard "${DASHBOARD.spec.label}"`);
};

// --- Simulation --------------------------------------------------------------------------------------

const smoothstep = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const connect = () => {
  const { brokers, defaultBrokerId } = JSON.parse(fs.readFileSync(SETTINGS_PATH)).mqtt;
  const broker = brokers[defaultBrokerId];
  const stateTopic = `r/${ROBOT_ID}/state`;
  const client = mqtt.connect(`${broker.protocol}${broker.hostname}:${broker.port}`, {
    username: broker.username,
    password: broker.password,
    will: { topic: stateTopic, payload: `0||${AGENT_VERSION}|${ROBOT_ID}`, retain: true, qos: 1 },
  });
  return new Promise((resolve, reject) => {
    client.once('connect', () => {
      client.publish(stateTopic, `1||${AGENT_VERSION}|${ROBOT_ID}`, { retain: true, qos: 1 });
      resolve(client);
    });
    client.once('error', reject);
  });
};
const AGENT_VERSION = 'demo-intrinsic-cell';

const run = async () => {
  await applyConfig();
  // Core messages (custom data) plus the two plugins' messages
  const types = protobuf.loadSync(path.resolve('src', 'shared', 'oro.proto'));
  [
    path.join(__dirname, '..', 'proto', 'intrinsic.proto'),
    require.resolve('oro-plugin-robotmodel/proto/robotmodel.proto'),
  ].forEach(file => protobuf.parse(fs.readFileSync(file, 'utf8'), types));
  const client = await connect();
  console.log(`Publishing the cell on r/${ROBOT_ID}/... (Ctrl+C to stop)`);
  const publish = (subtopic, typeName, fields) => {
    const Type = types.lookupType(typeName);
    client.publish(`r/${ROBOT_ID}/${subtopic}`, Buffer.from(Type.encode(Type.fromObject(fields)).finish()));
  };

  let arm = [...POSES.standby];
  let fingers = FINGERS.open;
  const scene = { objects: [], frames: FRAMES, attached: [], plannedPath: [] };
  const pieces = { left: pieceRestingPose('left'), right: pieceRestingPose('right') };

  const writeJoints = () => publish('ros/joint_states', 'oro.robotmodel.JointStatesMessage', {
    ts: Date.now(), names: JOINTS, positions: [...arm, fingers],
  });
  const writeScene = () => {
    scene.objects = STATIC_OBJECTS.concat(['left', 'right'].map(lane => ({
      id: `piece_${lane}`, name: `Piece ${lane}`, shape: 'box', size: PIECE_SIZE, pose: pieces[lane], color: '#3f5fbf',
    })));
    publish('robotmodel/scene', 'oro.robotmodel.SceneMessage', {
      ts: Date.now(),
      objects: scene.objects.map(o => ({ ...o, pose: pose3D(o.pose) })),
      frames: scene.frames.map(f => ({ ...f, pose: pose3D(f.pose) })),
      attached: scene.attached.map(a => ({ ...a, pose: pose3D(a.pose) })),
      plannedPath: scene.plannedPath.map(([x, y, z]) => ({ x, y, z })),
    });
  };
  const writeExecution = ({ nodes, ...execution }) => publish('intrinsic/execution', 'oro.intrinsic.ExecutionStateMessage', {
    ...execution, nodes: nodes.map(({ parentId = '', ...n }) => ({ ...n, parentId })),
  });

  // Summary for dashboards without the cell widgets (e.g. InOrbit, through upstream forwarding)
  const summary = { cycles_ok: 0, cycles_failed: 0 };
  const writeKeyValues = (values) => {
    Object.assign(summary, values);
    const ts = Date.now();
    publish('custom', 'oro.CustomDataMessage', {
      customField: KEY_VALUES_FIELD,
      ts,
      keyValuePayload: { pairs: Object.entries(values).map(([key, value]) => ({ key, value: String(value), ts })) },
    });
  };
  writeKeyValues({ cell_state: 'idle', cycles_ok: 0, cycles_failed: 0 });

  /** Moves arm and/or fingers to their targets over `seconds`, writing joint states. */
  const animate = async ({ seconds, arm: armTarget, fingers: fingerTarget }) => {
    const fromArm = arm;
    const fromFingers = fingers;
    const ticks = Math.max(1, Math.round((seconds * 1000) / TICK_MS));
    for (let i = 1; i <= ticks; i += 1) {
      const t = smoothstep(i / ticks);
      if (armTarget) arm = lerp(fromArm, armTarget, t);
      if (fingerTarget !== undefined) fingers = fromFingers + (fingerTarget - fromFingers) * t;
      await writeJoints();
      await sleep(TICK_MS);
    }
  };

  await writeScene();
  let cycleNumber = 0;
  process.on('SIGINT', () => {
    writeExecution({
      treeId: 'full', treeName: 'Pick and place', nodes: TREE, nodeStates: [], status: 'idle',
      currentNodeId: '', error: '', cycleId: '', cycleStartTs: Date.now(), ts: Date.now(),
    });
    writeKeyValues({ cell_state: 'idle', current_step: '' });
    client.publish(`r/${ROBOT_ID}/state`, `0||${AGENT_VERSION}|${ROBOT_ID}`, { retain: true, qos: 1 });
    client.end(false, () => process.exit(0));
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    cycleNumber += 1;
    const lane = cycleNumber % 2 ? 'left' : 'right';
    const cycleId = `${Date.now().toString(36)}-${lane}`;
    const cycleStartTs = Date.now();
    const states = {};
    let error = '';
    let status = 'running';
    const execution = currentNodeId => ({
      treeId: 'full', treeName: 'Pick and place', nodes: TREE,
      nodeStates: Object.entries(states).map(([nodeId, state]) => ({ nodeId, state })),
      status, currentNodeId, error, cycleId, cycleStartTs, ts: Date.now(),
    });
    states.full = 'running';
    console.log(`Cycle ${cycleId}`);
    writeKeyValues({ cell_state: 'running', lane, cycle_id: cycleId });

    for (const step of cycleSteps(lane)) {
      const { node } = step;
      states[parentOf[node]] = 'running';
      states[node] = 'running';
      await writeExecution(execution(node));
      writeKeyValues({ current_step: TREE.find(n => n.id === node).name });
      if (step.arm) {
        // The planner's path for this motion: tool tip along the interpolated joints
        scene.plannedPath = Array.from({ length: 24 }, (_, i) => toolTip(lerp(arm, step.arm, smoothstep(i / 23))));
        await writeScene();
      }
      await animate(step);

      let result = 'succeeded';
      if (step.perception) {
        const { found, message, confidence, error: perceptionError } = perceptionResult(lane, cycleId);
        publish('intrinsic/perception', 'oro.intrinsic.PerceptionResultMessage', message);
        writeKeyValues({ perception_confidence: confidence === null ? '' : confidence.toFixed(3) });
        if (!found) {
          result = 'failed';
          error = perceptionError;
        }
      }
      if (step.graspCheck && Math.random() < 0.15) {
        result = 'failed';
        error = 'GrabFailed: the gripper closed empty';
      }
      if (step.graspCheck && result === 'succeeded') {
        scene.attached = [{ objectId: `piece_${lane}`, link: 'wrist_roll_link', pose: pose([0, 0, 0.09]) }];
      }
      if (step.release) {
        scene.attached = [];
      }
      if (step.arm) {
        scene.plannedPath = [];
      }
      await writeScene();

      // Ingest derives the cycle's steps (with their durations) from these state changes
      states[node] = result;
      if (result === 'failed') {
        states[parentOf[node]] = 'failed';
        states.full = 'failed';
        status = 'failed';
        await writeExecution(execution(node));
        break;
      }
      // A sequence succeeds with its last child
      const siblings = TREE.filter(n => n.parentId === parentOf[node]);
      if (siblings[siblings.length - 1].id === node) {
        states[parentOf[node]] = 'succeeded';
      }
      await writeExecution(execution(node));
    }

    const cycleSeconds = ((Date.now() - cycleStartTs) / 1000).toFixed(1);
    if (status === 'failed') {
      console.log(`  failed: ${error}`);
      writeKeyValues({
        cell_state: 'recovering', current_step: '', last_cycle_result: 'failed', last_cycle_error: error,
        last_cycle_seconds: cycleSeconds, cycles_failed: summary.cycles_failed + 1,
      });
      // Recover outside of the tree (open, back to standby) before the next cycle
      await animate({ seconds: 0.5, fingers: FINGERS.open });
      await animate({ seconds: 2, arm: POSES.standby });
      await sleep(2000);
    } else {
      states.full = 'succeeded';
      status = 'succeeded';
      await writeExecution(execution(''));
      writeKeyValues({
        cell_state: 'idle', current_step: '', last_cycle_result: 'succeeded', last_cycle_error: '',
        last_cycle_seconds: cycleSeconds, cycles_ok: summary.cycles_ok + 1,
      });
      await sleep(1500);
    }
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
