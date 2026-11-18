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
  PLUGIN_ID, VERSION, SDK_RANGE, WIDGET_HELLO, PROTO_NAME,
} from '../shared';

function HelloWidget({ text, robotId }) {
  return (
    <div style={{ padding: 16 }}>
      <strong>{text || 'Hello from the example plugin'}</strong>
      {robotId ? <div>Robot: {robotId}</div> : null}
    </div>
  );
}

export default definePlugin({
  id: PLUGIN_ID,
  version: VERSION,
  sdkRange: SDK_RANGE,
  register(ctx) {
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
