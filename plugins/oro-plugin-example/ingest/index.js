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

const fs = require('fs');
const path = require('path');
const { definePlugin } = require('oro-plugin-sdk');
const {
  PLUGIN_ID, VERSION, SDK_RANGE, PROTO_NAME, HELLO_SUBTOPIC, HELLO_TYPE, HELLO_COLLECTION,
} = require('../shared');

const protoSource = fs.readFileSync(path.join(__dirname, '..', 'proto', PROTO_NAME), 'utf8');

/**
 * Ingest entry: stores the last Hello message of each robot in
 * plugin_example_hello.
 */
module.exports = definePlugin({
  id: PLUGIN_ID,
  version: VERSION,
  sdkRange: SDK_RANGE,
  register(ctx) {
    ctx.registerProto({ name: PROTO_NAME, source: protoSource });
  },
  async start({ mqtt, db, log }) {
    const Hello = mqtt.lookupType(HELLO_TYPE);
    const hello = db.collection(HELLO_COLLECTION);
    mqtt.registerListener(HELLO_SUBTOPIC, async (robotId, msg) => {
      try {
        const decoded = Hello.decode(msg);
        const ts = Number(decoded.ts) || Date.now();
        await hello.updateOne(
          { _id: robotId },
          { $set: { text: decoded.text, ts } },
          { upsert: true }
        );
      } catch (err) {
        log.error(`failed to process hello from ${robotId}: ${err.message}`);
      }
    });
  },
});
