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
import { useTracker } from 'meteor/react-meteor-data';
import { SDK_VERSION } from 'oro-plugin-sdk';
import {
  getPluginRegistry, getPluginSettings, makePluginLogger,
} from '../../lib/plugins/registry';
import {
  getRobotId, setRobotId, getStartTime, setStartTime,
  getTimeRangeMs, setTimeRangeMs, getTimeFocus, setTimeFocus,
} from '../oro/Dashboard/Dashboard_index';
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
});

const meteor = Object.freeze({
  callAsync: (...args) => Meteor.callAsync(...args),
  subscribe: (...args) => Meteor.subscribe(...args),
  useTracker,
});

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
      settings: settings.configFor(plugin.id),
      log: makePluginLogger(plugin.id),
      dashboard,
      meteor,
    }),
  });
};

export default loadClientPlugins;
