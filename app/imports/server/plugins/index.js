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
import { SDK_VERSION } from 'oro-plugin-sdk';
import {
  getPluginRegistry, getPluginSettings, makePluginLogger, setReservedConfigKinds,
} from '../../lib/plugins/registry';
import { CORE_KINDS } from '../configAPI/configAPI';
import { addProtoSource } from '../mqtt';
import OroRoles from '../roles';
import {
  ValidationError, SchemaError, AuthorizationError, NotFoundError,
} from '../../shared/configAPI';
import { RESOURCE_SINGLETONS, ACCESS_LEVEL_CONFIGURE, isSystemUser } from '../../shared/roles';
import installedPlugins from './installed';

const errors = Object.freeze({
  ValidationError, SchemaError, AuthorizationError, NotFoundError,
});

const auth = Object.freeze({
  isSystemUser: (user) => isSystemUser(user),
  canConfigureFleet: async (user) => Boolean(user) && (
    isSystemUser(user) || new OroRoles().canAccessSystemElement(
      user._id, RESOURCE_SINGLETONS.FLEET, ACCESS_LEVEL_CONFIGURE,
    )
  ),
});

// Meteor can't define the same collection twice in a process, so collections
// are cached by name (matters when tests load plugins more than once).
const collections = {};
export const pluginCollectionName = (pluginId, name) => `plugin_${pluginId}_${name}`;
const getCollection = (pluginId, name) => {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`[plugin:${pluginId}] invalid collection name ${JSON.stringify(name)}`);
  }
  const fullName = pluginCollectionName(pluginId, name);
  if (!collections[fullName]) collections[fullName] = new Mongo.Collection(fullName);
  return collections[fullName];
};

const commonContext = (plugin, settings) => ({
  runtime: 'server',
  sdkVersion: SDK_VERSION,
  pluginId: plugin.id,
  settings: settings.configFor(plugin.id),
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
    }),
  });
  registry.getProtos().forEach(({ source }) => addProtoSource(source));
  return registry;
};

/**
 * Runs plugins' `start(ctx)` hooks once core services (MQTT included) are up.
 */
export const startServerPlugins = async ({ mqtt, registry = getPluginRegistry() }) => {
  const settings = getPluginSettings();
  await registry.start((plugin) => ({
    ...commonContext(plugin, settings),
    mqtt: {
      lookupType: (fullName) => mqtt.lookupType(fullName),
      publishProtobuf: (...args) => mqtt.publishProtobuf(...args),
    },
  }));
};
