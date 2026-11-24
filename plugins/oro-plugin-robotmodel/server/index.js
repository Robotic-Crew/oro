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
 * Server entry of the robotmodel plugin: the RobotModel and RobotModelAssignment
 * kinds, the viewer widget type, and the endpoints the widget reads: a robot's
 * assignment and model, its latest joint states and scene, and the joint
 * states history for replay.
 *
 * Live joint states do not go through here: clients subscribe to the robot's
 * MQTT topic directly.
 */
import { definePlugin } from 'oro-plugin-sdk';
import protoSource from '../proto/robotmodel.proto';
import {
  PLUGIN_ID, VERSION, SDK_RANGE, WIDGET_VIEWER, KIND_MODEL, KIND_ASSIGNMENT, PROTO_NAME,
  COLLECTIONS, ENDPOINTS, JOINT_HISTORY_MAX_WINDOW_MS, JOINT_HISTORY_MAX_POINTS,
  JOINT_HISTORY_MAX_JOINTS, jointFieldName, isJointName,
} from '../shared';
import { createModelHandler, createAssignmentHandler } from './kinds';

const isString = (x) => typeof x === 'string';
const isNumber = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Joint states of a robot in [startTs, endTs), for replay. Returns
 *   { names, values: [[ts, position of names[0], ...], ...], truncated }
 * where a missing sample of a joint is null. Capped at JOINT_HISTORY_MAX_POINTS
 * (earliest kept; `truncated` tells the client to ask again from the last ts).
 */
export const makeJointHistory = ({ errors, timeseries }) => async ({ robotId, params }) => {
  const { names, startTs, endTs } = params;
  if (!Array.isArray(names) || names.length === 0 || names.length > JOINT_HISTORY_MAX_JOINTS
      || !names.every(isJointName)) {
    throw new errors.ValidationError(
      `names must be 1-${JOINT_HISTORY_MAX_JOINTS} joint names of up to 128 characters [A-Za-z0-9_-/:]`,
    );
  }
  if (!isNumber(startTs) || !isNumber(endTs) || endTs <= startTs
      || endTs - startTs > JOINT_HISTORY_MAX_WINDOW_MS) {
    throw new errors.ValidationError('startTs and endTs must be a valid window of at most 24 hours');
  }
  const fields = names.map(jointFieldName);
  const points = await timeseries.rawQuery({
    robotId, fields, startTs, endTs, limit: JOINT_HISTORY_MAX_POINTS,
  });
  return {
    names,
    values: points.map(({ ts, fields: values }) => [ts, ...fields.map((f) => values[f] ?? null)]),
    truncated: points.length === JOINT_HISTORY_MAX_POINTS,
  };
};

export default definePlugin({
  id: PLUGIN_ID,
  version: VERSION,
  sdkRange: SDK_RANGE,
  register(ctx) {
    ctx.registerProto({ name: PROTO_NAME, source: protoSource });
    ctx.registerWidgetType({ type: WIDGET_VIEWER, label: '3D Model', scope: 'robot' });

    const collections = {
      models: ctx.createCollection(COLLECTIONS.MODELS),
      assignments: ctx.createCollection(COLLECTIONS.ASSIGNMENTS),
      jointStates: ctx.createCollection(COLLECTIONS.JOINT_STATES),
      scenes: ctx.createCollection(COLLECTIONS.SCENES),
    };
    const { models, assignments, jointStates, scenes } = collections;

    // Core enforces `access` on list/apply/clear; the handlers check it again
    ctx.registerConfigKind({
      kind: KIND_MODEL, access: 'fleet.configure', createHandler: () => createModelHandler(ctx, collections),
    });
    ctx.registerConfigKind({
      kind: KIND_ASSIGNMENT,
      access: 'fleet.configure',
      createHandler: () => createAssignmentHandler(ctx, collections),
    });

    // Core checks the caller can view `robotId` before any handler runs
    const access = 'robot.view';
    ctx.registerPublication({
      name: ENDPOINTS.ASSIGNMENT, access, handler: ({ robotId }) => assignments.find({ _id: robotId }),
    });
    // The client passes the model id it read from the assignment and subscribes
    // again when it changes; it is only published while it is the robot's model
    ctx.registerPublication({
      name: ENDPOINTS.MODEL,
      access,
      handler: async ({ robotId, params: { modelId } }) => {
        if (!isString(modelId)) return null;
        const assignment = await assignments.findOneAsync({ _id: robotId });
        return assignment?.model === modelId ? models.find({ _id: modelId }) : null;
      },
    });
    ctx.registerPublication({
      name: ENDPOINTS.JOINT_STATES, access, handler: ({ robotId }) => jointStates.find({ _id: robotId }),
    });
    ctx.registerPublication({
      name: ENDPOINTS.SCENE, access, handler: ({ robotId }) => scenes.find({ _id: robotId }),
    });
    ctx.registerMethod({ name: ENDPOINTS.JOINT_HISTORY, access, handler: makeJointHistory(ctx) });
  },
});
