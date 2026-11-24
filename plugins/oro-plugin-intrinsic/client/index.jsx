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
 * Client entry of the intrinsic plugin: the Execution, Cycle Timeline and
 * Perception widgets for skill-based cells (e.g. Intrinsic Core).
 */
import React from 'react';
import { definePlugin } from 'oro-plugin-sdk';
import protoSource from '../proto/intrinsic.proto';
import {
  PLUGIN_ID, VERSION, SDK_RANGE, PROTO_NAME, WIDGETS,
} from '../shared';
import { setPluginContext } from './pluginContext';
import ExecutionWidget from './ExecutionWidget';
import CycleTimelineWidget from './CycleTimelineWidget';
import PerceptionWidget from './PerceptionWidget';

const WIDGET_DEFS = [
  { type: WIDGETS.EXECUTION, label: 'Execution', component: ExecutionWidget },
  { type: WIDGETS.CYCLE_TIMELINE, label: 'Cycle Timeline', component: CycleTimelineWidget },
  { type: WIDGETS.PERCEPTION, label: 'Perception', component: PerceptionWidget },
];

export default definePlugin({
  id: PLUGIN_ID,
  version: VERSION,
  sdkRange: SDK_RANGE,
  register(ctx) {
    setPluginContext(ctx);
    ctx.registerProto({ name: PROTO_NAME, source: protoSource });
    WIDGET_DEFS.forEach(({ type, label, component }) => {
      const Widget = ctx.ui.WithNoDataMessage(component);
      ctx.registerWidget({
        type,
        label,
        scope: 'robot',
        factory: ({ context, scope, isZeroData }) => (
          <Widget robotId={ctx.dashboard.getRobotId(context, scope)} isZeroData={isZeroData} />
        ),
      });
    });
  },
});
