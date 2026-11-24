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
 * Server entry of the intrinsic plugin: the three widget types, the
 * publications they read and the perception image method. Ingest writes the
 * collections; both ensure their indexes.
 */
import { definePlugin } from 'oro-plugin-sdk';
import protoSource from '../proto/intrinsic.proto';
import {
  PLUGIN_ID, VERSION, SDK_RANGE, PROTO_NAME, WIDGETS, COLLECTIONS, ENDPOINTS, INDEXES,
  RESULT_ID_RE, MAX_STEPS, MAX_PERCEPTION_RESULTS,
} from '../shared';

export const clampLimit = (limit, max) => Math.min(max, Math.max(1, Number(limit) || max));

// Set in register(), used by start()
let collections = {};

export default definePlugin({
  id: PLUGIN_ID,
  version: VERSION,
  sdkRange: SDK_RANGE,
  register(ctx) {
    ctx.registerProto({ name: PROTO_NAME, source: protoSource });
    ctx.registerWidgetType({ type: WIDGETS.EXECUTION, label: 'Execution', scope: 'robot' });
    ctx.registerWidgetType({ type: WIDGETS.CYCLE_TIMELINE, label: 'Cycle Timeline', scope: 'robot' });
    ctx.registerWidgetType({ type: WIDGETS.PERCEPTION, label: 'Perception', scope: 'robot' });

    collections = Object.fromEntries(Object.values(COLLECTIONS).map((name) => [name, ctx.createCollection(name)]));
    const executions = collections[COLLECTIONS.EXECUTIONS];
    const steps = collections[COLLECTIONS.EXECUTION_STEPS];
    const perception = collections[COLLECTIONS.PERCEPTION_RESULTS];

    // Core checks the caller can view `robotId` before any handler runs
    const access = 'robot.view';
    // Latest behavior tree execution of a robot
    ctx.registerPublication({
      name: ENDPOINTS.EXECUTION,
      access,
      handler: ({ robotId }) => executions.find({ _id: robotId }, { fields: { runningSince: 0 } }),
    });
    // Latest finished steps of a robot (the cycle timeline groups them by cycle)
    ctx.registerPublication({
      name: ENDPOINTS.STEPS,
      access,
      handler: ({ robotId, params }) => steps.find({ robotId }, {
        sort: { endTs: -1 }, limit: clampLimit(params.limit, MAX_STEPS), fields: { createdAt: 0 },
      }),
    });
    // Latest perception results of a robot (by arrival), without the image data:
    // `image` keeps { mime, size }, and the data comes from perceptionImage
    ctx.registerPublication({
      name: ENDPOINTS.PERCEPTION,
      access,
      handler: ({ robotId, params }) => perception.find({ robotId }, {
        sort: { createdAt: -1, ts: -1 },
        limit: clampLimit(params.limit, MAX_PERCEPTION_RESULTS),
        fields: { createdAt: 0, 'image.data': 0 },
      }),
    });
    // The image of one perception result of the robot: { mime, data (base64) }, or null
    ctx.registerMethod({
      name: ENDPOINTS.PERCEPTION_IMAGE,
      access,
      handler: async ({ robotId, params }) => {
        const { resultId } = params;
        if (typeof resultId !== 'string' || !RESULT_ID_RE.test(resultId)) {
          throw new ctx.errors.ValidationError('resultId must be a perception result id');
        }
        const result = await perception.findOneAsync({ _id: resultId, robotId }, { fields: { image: 1 } });
        if (!result?.image?.data) return null;
        return { mime: result.image.mime, data: result.image.data };
      },
    });
  },
  // Ingest creates the indexes too; whichever runs first wins, with the same specs
  async start({ log }) {
    for (const [name, key, options] of INDEXES) {
      try {
        await collections[name].rawCollection().createIndex(key, options);
      } catch (err) {
        log.error(`failed to create index ${JSON.stringify(key)} on ${name}: ${err.message}`);
      }
    }
  },
});
