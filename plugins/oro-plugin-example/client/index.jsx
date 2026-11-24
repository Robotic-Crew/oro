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

import React from 'react';
import { definePlugin } from 'oro-plugin-sdk';
import protoSource from '../proto/example.proto';
import {
  PLUGIN_ID, VERSION, SDK_RANGE, WIDGET_HELLO, PROTO_NAME, HELLO_COLLECTION, PUB_LAST_HELLO,
} from '../shared';

// Set in register(); components read core services from here
let pluginCtx;
let hello;

function HelloWidget({ text, robotId }) {
  // Last Hello message published by the robot on example/hello, stored by ingest
  const lastHello = pluginCtx.meteor.useTracker(() => {
    if (!robotId) return null;
    pluginCtx.subscribe(PUB_LAST_HELLO, { robotId });
    return hello.findOne({ _id: robotId });
  }, [robotId]);
  return (
    <div style={{ padding: 16 }}>
      <strong>{text || 'Hello from the example plugin'}</strong>
      {robotId ? <div>Robot: {robotId}</div> : null}
      {lastHello ? <div>Last message: {lastHello.text}</div> : null}
    </div>
  );
}

export default definePlugin({
  id: PLUGIN_ID,
  version: VERSION,
  sdkRange: SDK_RANGE,
  register(ctx) {
    pluginCtx = ctx;
    hello = ctx.createCollection(HELLO_COLLECTION);
    ctx.registerProto({ name: PROTO_NAME, source: protoSource });
    ctx.registerWidget({
      type: WIDGET_HELLO,
      label: 'Hello (example)',
      scope: 'robot',
      factory: ({ config, context, scope }) => (
        <HelloWidget text={config?.text} robotId={ctx.dashboard.getRobotId(context, scope)} />
      ),
    });
  },
});
