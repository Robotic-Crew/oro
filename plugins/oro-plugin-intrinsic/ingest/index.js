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
 * Ingest entry of the intrinsic plugin.
 *
 * - intrinsic/execution (ExecutionStateMessage): latest state per robot in
 *   plugin_intrinsic_executions. Steps (leaf nodes going from running to a
 *   final state) are derived here and appended to plugin_intrinsic_execution_steps,
 *   so the agent only has to report node states. The latest state of each
 *   robot is kept in memory (read from Mongo on its first message) and only the
 *   fields that changed are written.
 * - intrinsic/perception (PerceptionResultMessage): appended to
 *   plugin_intrinsic_perception_results, keeping the last PERCEPTION_RESULTS_KEPT
 *   per robot (by arrival time; they carry the image).
 *
 * The cell scene is handled by oro-plugin-robotmodel (robotmodel/scene).
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { definePlugin } = require('oro-plugin-sdk');
const {
  PLUGIN_ID, VERSION, SDK_RANGE, PROTO_NAME, COLLECTIONS, SUBTOPICS, TYPES, INDEXES, LIMITS,
  PERCEPTION_RESULTS_KEPT, nextExecution, executionChanges, perceptionDoc,
} = require('../shared');

const protoSource = fs.readFileSync(path.join(__dirname, '..', 'proto', PROTO_NAME), 'utf8');

// Execution messages of a robot waiting to be processed; more are dropped
const MAX_PENDING_EXECUTIONS = 100;
const DROP_WARNING_INTERVAL_MS = 10 * 1000;

module.exports = definePlugin({
  id: PLUGIN_ID,
  version: VERSION,
  sdkRange: SDK_RANGE,
  register(ctx) {
    ctx.registerProto({ name: PROTO_NAME, source: protoSource });
  },
  async start({ mqtt, db, log }) {
    const ExecutionStateMessage = mqtt.lookupType(TYPES.EXECUTION);
    const PerceptionResultMessage = mqtt.lookupType(TYPES.PERCEPTION);
    const executions = db.collection(COLLECTIONS.EXECUTIONS);
    const steps = db.collection(COLLECTIONS.EXECUTION_STEPS);
    const perception = db.collection(COLLECTIONS.PERCEPTION_RESULTS);

    for (const [name, key, options] of INDEXES) {
      await db.collection(name).createIndex(key, options);
    }

    // Latest execution doc per robot, as stored
    const latest = new Map();
    const processExecution = async (robotId, msg) => {
      try {
        const decoded = ExecutionStateMessage.decode(msg);
        if (!latest.has(robotId)) latest.set(robotId, await executions.findOne({ _id: robotId }));
        const prev = latest.get(robotId);
        const { doc, steps: finished, nodesChanged } = nextExecution(prev, decoded);
        const changes = executionChanges(prev, doc, nodesChanged);
        if (Object.keys(changes).length) {
          await executions.updateOne({ _id: robotId }, { $set: changes }, { upsert: true });
        }
        latest.set(robotId, { _id: robotId, ...doc });
        if (finished.length) {
          const createdAt = new Date();
          await steps.insertMany(finished.map((s) => ({ ...s, robotId, createdAt })));
        }
      } catch (err) {
        // Read it again from Mongo on the next message
        latest.delete(robotId);
        log.error(`failed to process execution state from ${robotId}: ${err.message}`);
      }
    };

    // Messages are handled concurrently, but each execution state is computed
    // from the previous one: process them one at a time per robot, in arrival
    // order, so a step is not derived twice. A robot flooding messages faster
    // than they are stored gets the excess dropped.
    const queues = new Map();
    const lastDropWarning = new Map();
    mqtt.registerListener(SUBTOPICS.EXECUTION, (robotId, msg) => {
      const queue = queues.get(robotId) || { tail: Promise.resolve(), pending: 0 };
      if (queue.pending >= MAX_PENDING_EXECUTIONS) {
        const now = Date.now();
        if (now - (lastDropWarning.get(robotId) || 0) > DROP_WARNING_INTERVAL_MS) {
          lastDropWarning.set(robotId, now);
          log.warn(`dropping execution states from ${robotId}: more than ${MAX_PENDING_EXECUTIONS} pending`);
        }
        return queue.tail;
      }
      queue.pending += 1;
      const current = queue.tail.then(() => processExecution(robotId, msg));
      queue.tail = current;
      queues.set(robotId, queue);
      return current.finally(() => {
        queue.pending -= 1;
        if (queue.pending === 0 && queues.get(robotId) === queue) queues.delete(robotId);
      });
    });

    // Arrival time of perception results, strictly increasing so trimming by it is exact
    let lastCreatedAt = 0;
    mqtt.registerListener(SUBTOPICS.PERCEPTION, async (robotId, msg) => {
      try {
        const doc = perceptionDoc(PerceptionResultMessage.decode(msg));
        if (doc.imageDropped) {
          log.warn(`perception result from ${robotId}: image over ${LIMITS.PERCEPTION_IMAGE_BYTES} bytes dropped`);
        }
        lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
        await perception.insertOne({
          _id: randomUUID(), ...doc, robotId, createdAt: new Date(lastCreatedAt),
        });
        // Keep only the latest ones (by arrival, robot clocks are not trusted): they carry the image
        const old = await perception.find({ robotId }, { projection: { _id: 1 } })
          .sort({ createdAt: -1 }).skip(PERCEPTION_RESULTS_KEPT).toArray();
        if (old.length) {
          await perception.deleteMany({ _id: { $in: old.map((d) => d._id) } });
        }
      } catch (err) {
        log.error(`failed to process perception result from ${robotId}: ${err.message}`);
      }
    }, { maxBytes: LIMITS.PERCEPTION_MESSAGE_BYTES });

    log.info('started');
  },
});
