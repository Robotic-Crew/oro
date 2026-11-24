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
 * Live joint states of a robot, fed into a LiveJointSource without going through React state.
 *
 * Two inputs:
 * - MQTT (DirectClient), the robot's own rate: what makes the model move smoothly.
 * - The `joint_states` snapshot (ingest-downsampled, or a ghost robot's static joints), through a
 *   Meteor subscription. It gives the initial pose, and keeps the model updating if MQTT is not
 *   delivering; it is ignored while MQTT is.
 *
 * Also returns a ref to the latest joint names (needed to query their history for replay).
 */
import { useEffect, useMemo, useRef } from 'react';
import { Meteor } from 'meteor/meteor';
// ORO modules
import { JointStates } from '../../../../lib/collections';
import { JOINT_STATES_SUBTOPIC } from '../../../../shared/constants';
import { MqttWrapper, getProtobufType } from '../../util/DirectClient';
import { LiveJointSource } from './jointSources';

// The snapshot is only used if MQTT has been silent for this long
const MQTT_PRIORITY_MS = 2000;

const valuesOf = ({ names = [], positions = [] }) => {
  const values = {};
  names.forEach((name, ix) => {
    if (Number.isFinite(positions[ix])) {
      values[name] = positions[ix];
    }
  });
  return values;
};

const useLiveJointSource = (robotId, enabled = true) => {
  const source = useMemo(() => new LiveJointSource(), [robotId]);
  const namesRef = useRef([]);

  // Snapshot from Meteor
  useEffect(() => {
    if (!robotId || !enabled) {
      return undefined;
    }
    const subscription = Meteor.subscribe('joint_states', { robotId });
    let mqttLastArrival = null;
    const onSnapshot = (doc) => {
      namesRef.current = doc.names || [];
      const last = source.lastArrival;
      // MQTT samples are the newest ones whenever they keep coming
      if (last !== null && last === mqttLastArrival && performance.now() - last < MQTT_PRIORITY_MS) {
        return;
      }
      source.push(valuesOf(doc));
      mqttLastArrival = null;
    };
    const handle = JointStates.find({ _id: robotId }).observe({ added: onSnapshot, changed: onSnapshot });

    // MQTT
    let mqtt = null;
    let listener = null;
    let cancelled = false;
    getProtobufType('JointStatesMessage').then((type) => {
      if (cancelled) {
        return;
      }
      mqtt = MqttWrapper.GrabInstance([robotId]);
      listener = (msg) => {
        const decoded = type.decode(msg);
        namesRef.current = decoded.names;
        source.push(valuesOf(decoded));
        mqttLastArrival = source.lastArrival;
      };
      mqtt.registerListener(JOINT_STATES_SUBTOPIC, listener);
    });

    return () => {
      cancelled = true;
      handle.stop();
      subscription.stop();
      if (mqtt) {
        mqtt.unregisterListener(JOINT_STATES_SUBTOPIC, listener);
        mqtt.release();
      }
    };
  }, [source, robotId, enabled]);

  return { source, namesRef };
};

export default useLiveJointSource;
