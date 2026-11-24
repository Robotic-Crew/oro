/**
 * Copyright 2026 InOrbit, Inc.
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
 * Publications for skill-based cells (e.g. Intrinsic Core): behavior tree execution, its steps,
 * the scene and perception results. Written by ingest (IntrinsicModule).
 * See docs/intrinsic-core-widgets.md.
 */
import { Meteor } from 'meteor/meteor';
import { isString } from 'lodash';
// ORO modules
import OroRoles from './roles';
import { ACCESS_LEVEL_VIEW } from '../shared/roles';
import {
  Executions, ExecutionSteps, Scenes, PerceptionResults,
} from '../lib/collections';

const MAX_STEPS = 500;
const MAX_PERCEPTION_RESULTS = 20;

const canView = async (userId, robotId) => (
  !!userId && isString(robotId)
  && new OroRoles().canAccessRobot(userId, robotId, ACCESS_LEVEL_VIEW)
);

const clampLimit = (limit, max) => Math.min(max, Math.max(1, Number(limit) || max));

/** Latest behavior tree execution of a robot. */
Meteor.publish('executions', async function ({ robotId }) {
  if (!await canView(this.userId, robotId)) {
    return this.ready();
  }
  return Executions.find({ _id: robotId }, { fields: { runningSince: 0 } });
});

/** The latest finished steps of a robot (the cycle timeline groups them by cycle). */
Meteor.publish('execution_steps.recent', async function ({ robotId, limit }) {
  if (!await canView(this.userId, robotId)) {
    return this.ready();
  }
  return ExecutionSteps.find({ robotId }, {
    sort: { endTs: -1 }, limit: clampLimit(limit, MAX_STEPS), fields: { createdAt: 0 },
  });
});

/** Latest scene of a robot. */
Meteor.publish('scenes', async function ({ robotId }) {
  if (!await canView(this.userId, robotId)) {
    return this.ready();
  }
  return Scenes.find({ _id: robotId });
});

/** The latest perception results of a robot, with their images. */
Meteor.publish('perception_results.recent', async function ({ robotId, limit }) {
  if (!await canView(this.userId, robotId)) {
    return this.ready();
  }
  return PerceptionResults.find({ robotId }, {
    sort: { ts: -1 }, limit: clampLimit(limit, MAX_PERCEPTION_RESULTS), fields: { createdAt: 0 },
  });
});
