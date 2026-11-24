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
 * Unit tests for JointStatesModule.
 */
import mongoUnit from 'mongo-unit';
import { assert } from 'chai';
// ORO modules
import { COLLECTIONS } from '../src/shared/constants';
import TimeSeriesStore from '../src/shared/timeseriesStore';
import { JointStatesModule } from '../src/server/modules';
import MongoManager from '../src/mongo';
import MqttMock from './mocks/mqtt';

const mongo = new MongoManager();
const ROBOT_ID = 'arm-1';

describe('JointStatesModule', () => {
  let mqtt;
  let jointStatesModule;
  let encode;

  beforeEach(async () => {
    await mongoUnit.drop();
    await new TimeSeriesStore({ db: mongo.db, collectionName: COLLECTIONS.TIMESERIES }).init();
    mqtt = new MqttMock();
    jointStatesModule = new JointStatesModule(mqtt).load({ persistIntervalMs: 1000 });
    const type = mqtt.lookupType('oro.JointStatesMessage');
    encode = (msg) => type.encode(type.create(msg)).finish();
  });

  it('parseJointStates: pairs names and positions, drops non-finite ones', () => {
    assert.deepEqual(
      JointStatesModule.parseJointStates({ ts: 5, names: ['a', 'b', 'c'], positions: [1, NaN, 3] }),
      { names: ['a', 'c'], positions: [1, 3], ts: 5 }
    );
    assert.isNull(JointStatesModule.parseJointStates({ names: ['a'], positions: [] }));
    assert.isNull(JointStatesModule.parseJointStates({ names: [], positions: [] }));
  });

  it('stores the latest snapshot and a time series point per joint', async () => {
    const ts = Date.now();
    await jointStatesModule.onMessage(ROBOT_ID, encode({
      ts, names: ['shoulder', 'arm/elbow'], positions: [0.5, -1.25],
    }));

    const snapshot = await mongo.getCollection(COLLECTIONS.JOINT_STATES).findOne({ _id: ROBOT_ID });
    assert.deepEqual(snapshot, {
      _id: ROBOT_ID, names: ['shoulder', 'arm/elbow'], positions: [0.5, -1.25], ts,
    });

    const points = await mongo.getCollection(COLLECTIONS.TIMESERIES).find({}).toArray();
    assert.lengthOf(points, 1);
    assert.equal(points[0].meta.robotId, ROBOT_ID);
    assert.equal(points[0].time.getTime(), ts);
    assert.equal(points[0].joint_shoulder, 0.5);
    assert.equal(points[0].joint_arm_elbow, -1.25);
  });

  it('downsamples: messages within persistIntervalMs are dropped', async () => {
    const ts = Date.now();
    await jointStatesModule.onMessage(ROBOT_ID, encode({ ts, names: ['j'], positions: [1] }));
    await jointStatesModule.onMessage(ROBOT_ID, encode({ ts: ts + 10, names: ['j'], positions: [2] }));
    const snapshot = await mongo.getCollection(COLLECTIONS.JOINT_STATES).findOne({ _id: ROBOT_ID });
    assert.deepEqual(snapshot.positions, [1]);
    assert.equal(await mongo.getCollection(COLLECTIONS.TIMESERIES).countDocuments({}), 1);
  });

  it('ignores malformed messages', async () => {
    await jointStatesModule.onMessage(ROBOT_ID, encode({ names: ['a', 'b'], positions: [1] }));
    assert.isNull(await mongo.getCollection(COLLECTIONS.JOINT_STATES).findOne({ _id: ROBOT_ID }));
  });
});
