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
 * Plugin loading for the ingest service.
 *
 * Settings: `plugins: { enabled: ['<id>', ...], config: { '<id>': {...} } }`
 */
import { createRegistry, RUNTIMES, SDK_VERSION } from 'oro-plugin-sdk';
import { addProtoSource as addProtoSourceToMqtt } from '../server/mqtt';
import installedPlugins from './installed';

export const pluginCollectionName = (pluginId, name) => `plugin_${pluginId}_${name}`;

const makeLogger = (pluginId) => {
  const prefix = `[plugin:${pluginId}]`;
  return {
    debug: (...args) => console.debug(prefix, ...args),
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
};

const commonContext = (plugin, settings) => ({
  runtime: RUNTIMES.INGEST,
  sdkVersion: SDK_VERSION,
  pluginId: plugin.id,
  settings: Object.freeze({ ...(settings?.plugins?.config?.[plugin.id] || {}) }),
  log: makeLogger(plugin.id),
});

/**
 * Registers the enabled plugins and adds their protos to the MQTT proto root.
 * Must run before mqtt.run() so plugin message types resolve from the start.
 *
 * @returns the loaded registry, to pass to startIngestPlugins()
 */
export const loadIngestPlugins = ({
  settings,
  plugins = installedPlugins,
  addProtoSource = addProtoSourceToMqtt,
} = {}) => {
  const registry = createRegistry({ runtime: RUNTIMES.INGEST, sdkVersion: SDK_VERSION });
  registry.load({
    plugins,
    enabled: settings?.plugins?.enabled || [],
    makeContext: (plugin) => commonContext(plugin, settings),
  });
  registry.getProtos().forEach(({ source }) => addProtoSource(source));
  const ids = registry.getPlugins().map(({ id }) => id);
  console.log('Plugins: ' + (ids.length ? ids.join(', ') : 'none'));
  return registry;
};

/**
 * Runs plugins' `start(ctx)` hooks: they get MQTT listeners and their own
 * (prefixed) Mongo collections.
 */
export const startIngestPlugins = async (registry, { mqtt, mongo, settings }) => {
  await registry.start((plugin) => ({
    ...commonContext(plugin, settings),
    mqtt: {
      registerListener: (...args) => mqtt.registerListener(...args),
      registerSystemListener: (...args) => mqtt.registerSystemListener(...args),
      publish: (...args) => mqtt.publish(...args),
      lookupType: (fullName) => mqtt.lookupType(fullName),
    },
    db: {
      collection: (name) => {
        if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) {
          throw new Error(`[plugin:${plugin.id}] invalid collection name ${JSON.stringify(name)}`);
        }
        return mongo.getCollection(pluginCollectionName(plugin.id, name));
      },
    },
  }));
};
