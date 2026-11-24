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
 * Ingest-side implementation of the Joint States module: joint positions of an articulated
 * robot (e.g. an arm), drawn by the 3D model widget.
 *
 * The agent publishes a JointStatesMessage on r/<robotId>/ros/joint_states at whatever rate it
 * samples (often 30-100 Hz). Clients watching a robot live subscribe to that topic directly, so
 * this module only keeps a downsampled copy, one message per robot every `persistIntervalMs`:
 * - the latest snapshot in `joint_states` ({ names, positions, ts }), for clients that are not
 *   (yet) receiving live data
 * - one time series point with a field per joint (`joint_<name>`), for replay
 */
import RateLimiter from '../rateLimiter';
import MongoManager from '../../mongo';
import { COLLECTIONS, JOINT_STATES_SUBTOPIC } from '../../shared/constants';
import TimeSeriesStore, { jointFieldName } from '../../shared/timeseriesStore';

// 5 Hz is plenty to replay arm motion; clients interpolate between samples
const DEFAULT_PERSIST_INTERVAL_MS = 200;

export default class JointStatesModule {
  constructor(mqtt) {
    this.mqtt = mqtt;
  }

  load = (settings = {}) => {
    const {
      persistIntervalMs = DEFAULT_PERSIST_INTERVAL_MS,
      timeseriesEnabled = true,
    } = settings;
    const mongo = new MongoManager();
    this._rateLimiter = new RateLimiter(persistIntervalMs);
    this._jointStates = mongo.getCollection(COLLECTIONS.JOINT_STATES);
    this._timeSeriesStore = timeseriesEnabled
      ? new TimeSeriesStore({ db: mongo.db, collectionName: COLLECTIONS.TIMESERIES })
      : null;
    this.JointStatesMessage = this.mqtt.lookupType('oro.JointStatesMessage');
    this.mqtt.registerListener(JOINT_STATES_SUBTOPIC, this.onMessage);
    console.log('JointStatesModule started with settings: ' + JSON.stringify(settings));
    return this;
  };

  onMessage = async (robotId, msg) => {
    if (!this._rateLimiter.accepts(robotId)) {
      return;
    }
    try {
      const decodedMsg = this.JointStatesMessage.decode(msg);
      const jointStates = JointStatesModule.parseJointStates(decodedMsg);
      if (!jointStates) {
        console.warn(`JointStatesModule: ignoring malformed joint states from ${robotId}`);
        return;
      }
      await this.saveJointStates(robotId, jointStates);
    } catch (e) {
      console.error(`Error processing joint states from ${robotId}`, e);
    }
  };

  saveJointStates = async (robotId, { names, positions, ts }) => {
    await this._jointStates.updateOne(
      { _id: robotId },
      { $set: { names, positions, ts } },
      { upsert: true }
    );
    if (this._timeSeriesStore) {
      const fields = {};
      names.forEach((name, ix) => { fields[jointFieldName(name)] = positions[ix]; });
      await this._timeSeriesStore.write({ ts, meta: { robotId }, fields });
    }
  };

  /**
   * Decoded JointStatesMessage -> { names, positions, ts }, keeping only joints with a finite
   * position. Returns null when names and positions don't pair up.
   */
  static parseJointStates = ({ ts, names = [], positions = [] }) => {
    if (names.length === 0 || names.length !== positions.length) {
      return null;
    }
    const valid = names
      .map((name, ix) => [name, positions[ix]])
      .filter(([name, position]) => name && Number.isFinite(position));
    if (valid.length === 0) {
      return null;
    }
    const tsMs = (ts && typeof ts === 'object' ? ts.toNumber() : Number(ts)) || Date.now();
    return {
      names: valid.map(([name]) => name),
      positions: valid.map(([, position]) => position),
      ts: tsMs,
    };
  };
}
