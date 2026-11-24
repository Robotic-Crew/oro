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
 * Core-owned plugin registry for the current Meteor runtime (client or server).
 *
 * Plugins are loaded once at startup by `client/plugins` / `server/plugins`;
 * core code reads what they registered through `getPluginRegistry()` getters.
 * Getters must not be called at module import time: they return empty results
 * until plugins are loaded, and reading early trips the SDK's load-order guard.
 */
import { Meteor } from 'meteor/meteor';
import { createRegistry, RUNTIMES } from 'oro-plugin-sdk';
import { WIDGET_TYPES_IDS, WIDGET_TYPE_GROUP } from '../uiPreferences';

// Widget type names core uses; plugin types are namespaced (`<id>:<name>`) so
// they can't collide anyway, but keep the check explicit.
export const CORE_WIDGET_TYPES = ['group', WIDGET_TYPE_GROUP, ...Object.values(WIDGET_TYPES_IDS)];

let registry;
let reservedKinds = [];

/** Server only: ConfigAPI kinds implemented by core. Must be set before load. */
export const setReservedConfigKinds = (kinds) => {
  reservedKinds = [...kinds];
};

const buildRegistry = () => createRegistry({
  runtime: Meteor.isServer ? RUNTIMES.SERVER : RUNTIMES.CLIENT,
  reservedWidgetTypes: CORE_WIDGET_TYPES,
  reservedKinds: () => reservedKinds,
});

export const getPluginRegistry = () => {
  if (!registry) registry = buildRegistry();
  return registry;
};

/**
 * Plugin settings: `Meteor.settings.public.plugins = { enabled: [ids], config: {[id]: {}} }`.
 * The server also merges `Meteor.settings.plugins.config[id]` (private config).
 *
 * `public.plugins.config` is sent to every browser: secrets (tokens, keys) go
 * in the top-level `plugins.config`, which only the server reads.
 */
export const getPluginSettings = () => {
  const pub = Meteor.settings?.public?.plugins || {};
  const priv = (Meteor.isServer && Meteor.settings?.plugins) || {};
  return {
    enabled: Array.isArray(pub.enabled) ? pub.enabled : [],
    configFor: (id) => ({ ...(pub.config?.[id] || {}), ...(priv.config?.[id] || {}) }),
  };
};

export const makePluginLogger = (id) => ({
  debug: (...args) => console.debug(`[plugin:${id}]`, ...args),
  info: (...args) => console.log(`[plugin:${id}]`, ...args),
  warn: (...args) => console.warn(`[plugin:${id}]`, ...args),
  error: (...args) => console.error(`[plugin:${id}]`, ...args),
});

/**
 * Tests only: replaces the registry (pass undefined to get a fresh one on the
 * next `getPluginRegistry()` call).
 */
export const setPluginRegistryForTests = (reg) => {
  registry = reg;
};

/** Tests only: a fresh, unshared registry for this runtime. */
export const createPluginRegistryForTests = () => buildRegistry();
