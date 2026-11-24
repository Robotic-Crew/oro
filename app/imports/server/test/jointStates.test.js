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
 * Tests for the joint states history method (3D model widget replay).
 */
import { Meteor } from 'meteor/meteor';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';
// ORO modules
import { resetDatabase } from './setup';
import OroRoles from '../roles';
import TimeSeriesManager from '../timeseries';
import { queryJointStatesHistory } from '../jointStates';
import { ROLE_MANAGER } from '../../lib/roles';
import { createUser, createRobot } from './configAPI';

if (!Meteor.isTest) throw new Error('This is TEST code only');
const { expect } = chai;
chai.use(chaiAsPromised);

describe('jointStates.history', () => {
  let sandbox;
  let userId;
  let robotId;
  let rawQuery;
  const call = (args, uid = userId) => queryJointStatesHistory.call({ userId: uid }, args);
  const T0 = 1_700_000_000_000;

  beforeEach(async () => {
    await resetDatabase();
    await new OroRoles().createDefaultRoles();
    userId = (await createUser({ id: 'mgr', role: ROLE_MANAGER }))._id;
    robotId = await createRobot('arm');
    sandbox = sinon.createSandbox();
    rawQuery = sandbox.stub(new TimeSeriesManager(), 'rawQuery');
  });

  afterEach(() => sandbox.restore());

  after(resetDatabase);

  it('queries one sanitized field per joint and returns compact rows', async () => {
    rawQuery.resolves([
      { ts: T0, fields: { joint_shoulder: 0.1, joint_arm_elbow: 1 } },
      { ts: T0 + 200, fields: { joint_shoulder: 0.2 } },
    ]);
    const result = await call({ robotId, names: ['shoulder', 'arm/elbow'], startTs: T0, endTs: T0 + 1000 });
    expect(rawQuery.firstCall.args[0]).to.deep.include({
      meta: { robotId }, fields: ['joint_shoulder', 'joint_arm_elbow'], startTs: T0, endTs: T0 + 1000,
    });
    expect(result).to.deep.equal({
      names: ['shoulder', 'arm/elbow'],
      values: [[T0, 0.1, 1], [T0 + 200, 0.2, null]],
      truncated: false,
    });
  });

  it('rejects anonymous users and bad windows or names', async () => {
    const args = { robotId, names: ['a'], startTs: T0, endTs: T0 + 1000 };
    await expect(call(args, null)).to.be.rejectedWith(/Unauthorized/);
    await expect(call({ ...args, endTs: T0 })).to.be.rejectedWith(/window/);
    await expect(call({ ...args, endTs: T0 + 25 * 3600 * 1000 })).to.be.rejectedWith(/window/);
    await expect(call({ ...args, names: [] })).to.be.rejectedWith(/names/);
    await expect(call({ ...args, names: [1] })).to.be.rejectedWith(/names/);
    expect(rawQuery.called).to.equal(false);
  });
});
