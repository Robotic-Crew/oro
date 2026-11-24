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

import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { useTracker } from 'meteor/react-meteor-data';
import { SDK_VERSION, pluginCollectionName, pluginEndpointName } from 'oro-plugin-sdk';
import {
  getPluginRegistry, getPluginSettings, makePluginLogger,
} from '../../lib/plugins/registry';
import {
  getRobotId, setRobotId, getStartTime, setStartTime,
  getTimeRangeMs, setTimeRangeMs, getTimeFocus, setTimeFocus,
} from '../oro/Dashboard/Dashboard_index';
import { MqttWrapper, getProtobufType } from '../oro/util/DirectClient';
import { prepareTimeVarsForQuery } from '../oro/util/timeUtils';
import WithNoDataMessage from '../oro/util/WithNoDataMessage';
import LoadingCircle from '../oro/util/LoadingCircle';
import installedPlugins from './installed';

const dashboard = Object.freeze({
  getRobotId,
  setRobotId,
  getStartTime,
  setStartTime,
  getTimeRangeMs,
  setTimeRangeMs,
  getTimeFocus,
  setTimeFocus,
  /** `{ startTs, endTs }` of the dashboard time range, as core widgets compute it. */
  resolveTimeRange: (startTs, timeRangeMs, nowTs = Date.now()) => (
    prepareTimeVarsForQuery(startTs, timeRangeMs, nowTs)
  ),
});

const meteor = Object.freeze({
  callAsync: (...args) => Meteor.callAsync(...args),
  subscribe: (...args) => Meteor.subscribe(...args),
  useTracker,
});

const ui = Object.freeze({ WithNoDataMessage, LoadingCircle });

const mqtt = Object.freeze({
  /**
   * Listens to `subtopic` of a robot over the browser's MQTT connection.
   * Returns a function that stops listening.
   */
  subscribe: (robotId, subtopic, listener) => {
    const instance = MqttWrapper.GrabInstance([robotId]);
    instance.registerListener(subtopic, listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      instance.unregisterListener(subtopic, listener);
      instance.release();
    };
  },
  /** Resolves a protobuf type by full name, e.g. 'oro.example.Hello'. */
  lookupType: (fullName) => getProtobufType(String(fullName).replace(/^oro\./, '')),
});

// Meteor can't define the same client collection twice, so they are cached by name
const collections = {};
const getCollection = (pluginId, name) => {
  const fullName = pluginCollectionName(pluginId, name);
  if (!collections[fullName]) collections[fullName] = new Mongo.Collection(fullName);
  return collections[fullName];
};

/**
 * Registers the enabled client plugins. Must run before the first render, since
 * dashboards read the registry while rendering.
 */
export const loadClientPlugins = ({ plugins = installedPlugins } = {}) => {
  const settings = getPluginSettings();
  getPluginRegistry().load({
    plugins,
    enabled: settings.enabled,
    makeContext: (plugin) => ({
      runtime: 'client',
      sdkVersion: SDK_VERSION,
      pluginId: plugin.id,
      settings: Object.freeze(settings.configFor(plugin.id)),
      log: makePluginLogger(plugin.id),
      dashboard,
      meteor,
      ui,
      mqtt,
      createCollection: (name) => getCollection(plugin.id, name),
      subscribe: (name, params) => Meteor.subscribe(pluginEndpointName(plugin.id, name), params),
      call: (name, params) => Meteor.callAsync(pluginEndpointName(plugin.id, name), params),
    }),
  });
};

export default loadClientPlugins;
