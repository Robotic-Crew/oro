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
 * Live joint states of a robot, fed into a LiveJointSource without going through React state.
 *
 * Two inputs:
 * - MQTT, the robot's own rate: what makes the model move smoothly.
 * - The joint states snapshot (ingest-downsampled, or the static joints of a
 *   RobotModelAssignment), through a subscription. It gives the initial pose, and keeps the
 *   model updating if MQTT is not delivering; it is ignored while MQTT is, and the subscription
 *   is dropped while MQTT keeps delivering (and taken again once it goes silent).
 *
 * Also returns a ref to the latest joint names (needed to query their history for replay).
 */
import { useEffect, useMemo, useRef } from 'react';
import { ENDPOINTS, SUBTOPICS, TYPES, isJointName, toMs } from '../shared';
import { getPluginContext, getCollections } from './pluginContext';
import { LiveJointSource } from './jointSources';

// The snapshot is only used if MQTT has been silent for this long
const MQTT_PRIORITY_MS = 2000;
// How often to check whether the snapshot subscription is needed
const WATCHDOG_MS = 1000;

const valuesOf = ({ names = [], positions = [] }) => {
  const values = {};
  names.forEach((name, ix) => {
    // Same names ingest accepts (also never an Object.prototype key)
    if (isJointName(name) && Number.isFinite(positions[ix])) {
      values[name] = positions[ix];
    }
  });
  return values;
};

const useLiveJointSource = (robotId, enabled = true) => {
  const source = useMemo(() => new LiveJointSource(), [robotId]);
  const namesRef = useRef([]);

  useEffect(() => {
    if (!robotId || !enabled) {
      return undefined;
    }
    const ctx = getPluginContext();
    const { jointStates } = getCollections();

    // Snapshot
    let subscription = ctx.subscribe(ENDPOINTS.JOINT_STATES, { robotId });
    let mqttLastArrival = null;
    // Robot timestamp of the last MQTT sample: an older snapshot would move the model back
    let mqttLastTs = null;
    const onSnapshot = (doc) => {
      namesRef.current = doc.names || [];
      const last = source.lastArrival;
      // MQTT samples are the newest ones whenever they keep coming
      if (last !== null && last === mqttLastArrival && performance.now() - last < MQTT_PRIORITY_MS) {
        return;
      }
      if (mqttLastTs !== null && doc.ts <= mqttLastTs) {
        return;
      }
      source.push(valuesOf(doc));
      mqttLastArrival = null;
    };
    const handle = jointStates.find({ _id: robotId }).observe({ added: onSnapshot, changed: onSnapshot });

    // MQTT
    let unsubscribe = null;
    let cancelled = false;
    ctx.mqtt.lookupType(TYPES.JOINT_STATES).then((type) => {
      if (cancelled) {
        return;
      }
      unsubscribe = ctx.mqtt.subscribe(robotId, SUBTOPICS.JOINT_STATES, (msg) => {
        const decoded = type.decode(msg);
        namesRef.current = decoded.names.filter(isJointName);
        source.push(valuesOf(decoded));
        mqttLastArrival = source.lastArrival;
        mqttLastTs = toMs(decoded.ts);
      });
    }).catch((err) => ctx.log.error('joint states type not available', err));

    // The snapshot subscription only while MQTT is silent
    const watchdog = setInterval(() => {
      const silent = mqttLastArrival === null || performance.now() - mqttLastArrival >= MQTT_PRIORITY_MS;
      if (silent && !subscription) {
        subscription = ctx.subscribe(ENDPOINTS.JOINT_STATES, { robotId });
      } else if (!silent && subscription) {
        subscription.stop();
        subscription = null;
      }
    }, WATCHDOG_MS);

    return () => {
      cancelled = true;
      clearInterval(watchdog);
      handle.stop();
      if (subscription) {
        subscription.stop();
      }
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [source, robotId, enabled]);

  return { source, namesRef };
};

export default useLiveJointSource;
