'use strict';

/**
 * Demo publisher for the 3D Model widget: publishes a looping motion for the demo arm
 * (app/public/robot-models/demo-arm) as JointStatesMessage on r/<robotId>/ros/joint_states,
 * the topic a real agent would use. It connects with ingest's own broker credentials
 * (settings.json), so it works for ghost robots, which have no agent.
 *
 *   node scripts/publishJointStates.js <robotId> [--hz 30] [--settings settings.json]
 *
 * Run ./import.sh first (it copies oro.proto into src/shared). See docs/visualizer.md.
 */
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const protobuf = require('protobufjs');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const ix = args.indexOf(`--${name}`);
  return ix >= 0 ? args[ix + 1] : fallback;
};
const robotId = args.find((a, ix) => !a.startsWith('--') && !(ix > 0 && args[ix - 1].startsWith('--')));
if (!robotId) {
  console.error('Usage: node scripts/publishJointStates.js <robotId> [--hz 30] [--settings settings.json]');
  process.exit(1);
}
const hz = Number(option('hz', 30));
const settingsPath = path.resolve(option('settings', path.join(__dirname, '..', 'settings.json')));

const { brokers, defaultBrokerId } = JSON.parse(fs.readFileSync(settingsPath)).mqtt;
const broker = brokers[defaultBrokerId];
const JointStatesMessage = protobuf
  .loadSync(path.join(__dirname, '..', 'src', 'shared', 'oro.proto'))
  .lookupType('oro.JointStatesMessage');

// A pick-and-place-like loop: every joint follows a sine with its own period and phase
const JOINTS = {
  shoulder_pan: (t) => 1.2 * Math.sin(t / 4),
  shoulder_lift: (t) => -0.5 + 0.45 * Math.sin(t / 3),
  elbow: (t) => 1.1 + 0.5 * Math.sin(t / 3 + 1),
  wrist_pitch: (t) => 0.6 * Math.sin(t / 2.5),
  wrist_roll: (t) => 1.5 * Math.sin(t / 5),
  finger_left: (t) => 0.0275 + 0.0225 * Math.sin(t * 1.5),
};
const names = Object.keys(JOINTS);

const client = mqtt.connect(`${broker.protocol}${broker.hostname}:${broker.port}`, {
  username: broker.username,
  password: broker.password,
});
const topic = `r/${robotId}/ros/joint_states`;
client.on('connect', () => {
  console.log(`Publishing joint states to ${topic} at ${hz} Hz (Ctrl+C to stop)`);
  const t0 = Date.now();
  setInterval(() => {
    const now = Date.now();
    const t = (now - t0) / 1000;
    const msg = JointStatesMessage.create({ ts: now, names, positions: names.map((n) => JOINTS[n](t)) });
    client.publish(topic, Buffer.from(JointStatesMessage.encode(msg).finish()));
  }, 1000 / hz);
});
client.on('error', (err) => {
  console.error('MQTT error', err.message);
  process.exit(1);
});
