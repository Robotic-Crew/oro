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

import { Mongo } from 'meteor/mongo';
import { SDK_VERSION, pluginCollectionName, pluginFieldPrefix } from 'oro-plugin-sdk';
import {
  getPluginRegistry, getPluginSettings, makePluginLogger, setReservedConfigKinds,
} from '../../lib/plugins/registry';
import { CORE_KINDS } from '../configAPI/configAPI';
import { addProtoSource } from '../mqtt';
import TimeSeriesManager from '../timeseries';
import { registerPluginEndpoints } from './endpoints';
import {
  ValidationError, SchemaError, AuthorizationError, NotFoundError,
} from '../../shared/configAPI';
import { isSystemUser } from '../../shared/roles';
import { canConfigureFleet } from './configKinds';
import installedPlugins from './installed';

const errors = Object.freeze({
  ValidationError, SchemaError, AuthorizationError, NotFoundError,
});

const auth = Object.freeze({
  isSystemUser: (user) => isSystemUser(user),
  canConfigureFleet,
});

// Meteor can't define the same collection twice in a process, so collections
// are cached by name (matters when tests load plugins more than once).
const collections = {};
const getCollection = (pluginId, name) => {
  const fullName = pluginCollectionName(pluginId, name);
  if (!collections[fullName]) collections[fullName] = new Mongo.Collection(fullName);
  return collections[fullName];
};

const TIMESERIES_MAX_LIMIT = 20000;
// Longest time range one rawQuery may scan
export const TIMESERIES_MAX_WINDOW_MS = 24 * 3600 * 1000;
const FIELD_RE = /^[A-Za-z0-9_]+$/;

/**
 * Read access to the robot time series, limited to the plugin's own fields
 * (`<id>_*`). No authorization here: plugins call it from access-gated
 * endpoints.
 */
const makeTimeseries = (pluginId) => {
  const prefix = pluginFieldPrefix(pluginId);
  return Object.freeze({
    rawQuery: async ({ robotId, fields, startTs, endTs, limit = TIMESERIES_MAX_LIMIT } = {}) => {
      if (typeof robotId !== 'string' || !robotId) {
        throw new ValidationError('timeseries.rawQuery needs a robotId');
      }
      if (!Array.isArray(fields) || fields.length === 0
          || !fields.every((f) => typeof f === 'string' && FIELD_RE.test(f) && f.startsWith(prefix))) {
        throw new ValidationError(`timeseries fields must be non-empty and start with '${prefix}'`);
      }
      if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
        throw new ValidationError('timeseries.rawQuery needs numeric startTs < endTs');
      }
      if (endTs - startTs > TIMESERIES_MAX_WINDOW_MS) {
        throw new ValidationError(
          `timeseries.rawQuery range is limited to ${TIMESERIES_MAX_WINDOW_MS / 3600000} h`,
        );
      }
      return new TimeSeriesManager().rawQuery({
        // Plugin points are tagged with their plugin (see ingest/src/plugins)
        meta: { robotId, src: pluginId },
        fields,
        startTs,
        endTs,
        limit: Math.min(TIMESERIES_MAX_LIMIT, Math.max(1, Number(limit) || TIMESERIES_MAX_LIMIT)),
      });
    },
  });
};

const commonContext = (plugin, settings) => ({
  runtime: 'server',
  sdkVersion: SDK_VERSION,
  pluginId: plugin.id,
  settings: Object.freeze(settings.configFor(plugin.id)),
  log: makePluginLogger(plugin.id),
});

/**
 * Registers the enabled server plugins and adds their protos to the MQTT root.
 * Must run before ConfigAPI.init(), which picks up plugin kinds.
 *
 * @param {object} [options] overrides, for tests
 */
export const loadServerPlugins = ({
  registry = getPluginRegistry(),
  plugins = installedPlugins,
  enabled,
} = {}) => {
  const settings = getPluginSettings();
  setReservedConfigKinds(CORE_KINDS);
  registry.load({
    plugins,
    enabled: enabled || settings.enabled,
    makeContext: (plugin) => ({
      ...commonContext(plugin, settings),
      errors,
      auth,
      createCollection: (name) => getCollection(plugin.id, name),
      timeseries: makeTimeseries(plugin.id),
    }),
  });
  registry.getProtos().forEach(({ source }) => addProtoSource(source));
  registerPluginEndpoints(registry);
  return registry;
};

/**
 * Runs plugins' `start(ctx)` hooks once core services (MQTT included) are up.
 */
export const startServerPlugins = async ({ mqtt, registry = getPluginRegistry() }) => {
  const settings = getPluginSettings();
  await registry.start((plugin) => ({
    ...commonContext(plugin, settings),
    timeseries: makeTimeseries(plugin.id),
    mqtt: {
      lookupType: (fullName) => mqtt.lookupType(fullName),
      publishProtobuf: (...args) => mqtt.publishProtobuf(...args),
    },
  }));
};
