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
 * Server side of the 3D model widget: the robot's model, its latest joint states, and the joint
 * states history for replay.
 *
 * Live joint states do not go through here: clients subscribe to the robot's MQTT topic directly.
 */
import { Meteor } from 'meteor/meteor';
import { isArray, isNumber, isString } from 'lodash';
// ORO modules
import OroRoles from './roles';
import TimeSeriesManager from './timeseries';
import { ACCESS_LEVEL_VIEW } from '../shared/roles';
import { Robots, RobotModels, JointStates } from '../lib/collections';
import { jointFieldName } from '../shared/timeseriesStore';

// Replay window and size caps: ingest stores 5 Hz by default, so 20k points is ~1 hour
const JOINT_HISTORY_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const JOINT_HISTORY_MAX_POINTS = 20000;
const JOINT_HISTORY_MAX_JOINTS = 64;

const canView = async (userId, robotId) => (
  !!userId && isString(robotId)
  && new OroRoles().canAccessRobot(userId, robotId, ACCESS_LEVEL_VIEW)
);

/**
 * Publish the 3D model of a robot. The client passes the `modelId` it read from the robot
 * document (`robot.details`) and re-subscribes when it changes; it is only published if it is
 * still the robot's model.
 */
Meteor.publish('robot_models.forRobot', async function ({ robotId, modelId }) {
  if (!await canView(this.userId, robotId) || !isString(modelId)) {
    return this.ready();
  }
  const robot = await Robots.findOneAsync({ _id: robotId }, { projection: { model: 1 } });
  if (robot?.model !== modelId) {
    return this.ready();
  }
  return RobotModels.find({ _id: modelId });
});

/**
 * Publish the latest (downsampled) joint states of a robot.
 */
Meteor.publish('joint_states', async function ({ robotId }) {
  if (!await canView(this.userId, robotId)) {
    return this.ready();
  }
  return JointStates.find({ _id: robotId });
});

/**
 * Joint states of a robot in [startTs, endTs), for replay. Returns
 *   { names, values: [[ts, position of names[0], position of names[1], ...], ...] }
 * where a missing sample of a joint is null. Capped at JOINT_HISTORY_MAX_POINTS (earliest kept;
 * `truncated` tells the client to ask again from the last ts).
 */
const queryJointStatesHistory = async function ({ robotId, names, startTs, endTs }) {
  if (!await canView(this.userId, robotId)) {
    throw new Meteor.Error('Unauthorized');
  }
  if (!isArray(names) || names.length === 0 || names.length > JOINT_HISTORY_MAX_JOINTS
      || !names.every(isString)) {
    throw new Meteor.Error('wrong-parameter', `names must be 1-${JOINT_HISTORY_MAX_JOINTS} joint names`);
  }
  if (!isNumber(startTs) || !isNumber(endTs) || endTs <= startTs
      || endTs - startTs > JOINT_HISTORY_MAX_WINDOW_MS) {
    throw new Meteor.Error('wrong-parameter', 'startTs and endTs must be a valid window of at most 24 hours');
  }
  const fields = names.map(jointFieldName);
  const points = await new TimeSeriesManager().rawQuery({
    meta: { robotId }, fields, startTs, endTs, limit: JOINT_HISTORY_MAX_POINTS,
  });
  return {
    names,
    values: points.map(({ ts, fields: values }) => [ts, ...fields.map((f) => values[f] ?? null)]),
    truncated: points.length === JOINT_HISTORY_MAX_POINTS,
  };
};

Meteor.methods({
  'jointStates.history': queryJointStatesHistory,
});

export { queryJointStatesHistory };
