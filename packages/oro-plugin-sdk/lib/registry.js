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

const { satisfies } = require('./semver');
const {
  PluginError,
  isPlainObject,
  validatePluginShape,
  validateWidgetType,
  validateKind,
  validateProto,
} = require('./validate');

const { ENDPOINT_NAME_RE, pluginEndpointName } = require('./names');

const RUNTIMES = Object.freeze({ CLIENT: 'client', SERVER: 'server', INGEST: 'ingest' });

// Authorization policies core enforces before a plugin endpoint runs.
// 'robot.view': caller is logged in, params is an object with a `robotId` and
// the user can view that robot.
const ENDPOINT_ACCESS = Object.freeze({ ROBOT_VIEW: 'robot.view' });
const ENDPOINT_ACCESS_VALUES = Object.values(ENDPOINT_ACCESS);
// Authorization policies core enforces on every ConfigAPI call of a plugin kind.
// 'fleet.configure': the user can configure the fleet (or is a system user).
const CONFIG_KIND_ACCESS = Object.freeze({ FLEET_CONFIGURE: 'fleet.configure' });
const CONFIG_KIND_ACCESS_VALUES = Object.values(CONFIG_KIND_ACCESS);
const RUNTIME_VALUES = Object.values(RUNTIMES);

// Which registration functions each runtime exposes on `ctx`.
const REGISTRATIONS_BY_RUNTIME = {
  client: ['registerProto', 'registerWidget'],
  server: [
    'registerProto',
    'registerWidgetType',
    'registerConfigKind',
    'registerPublication',
    'registerMethod',
  ],
  ingest: ['registerProto'],
};

function resolveList(listOrFn) {
  const list = typeof listOrFn === 'function' ? listOrFn() : listOrFn;
  return new Set(list || []);
}

/**
 * Creates the plugin registry for one runtime. Core owns the instance; the SDK
 * keeps no global state, so several copies of the SDK can't split the registry.
 *
 * Lifecycle: `load()` once (sync, runs every plugin's `register`), then the
 * registry is frozen and getters expose what was registered; `start()` runs the
 * optional async `start` hooks once core services are up.
 *
 * @param {object} options
 * @param {'client'|'server'|'ingest'} options.runtime
 * @param {string[]|() => string[]} [options.reservedWidgetTypes] core widget
 *   types plugins may not register. A function is resolved at load time.
 * @param {string[]|() => string[]} [options.reservedKinds] core ConfigAPI kinds.
 * @param {string} options.sdkVersion SDK version plugins are checked against.
 */
function createRegistry({ runtime, reservedWidgetTypes = [], reservedKinds = [], sdkVersion }) {
  if (!RUNTIME_VALUES.includes(runtime)) {
    throw new PluginError(`Unknown runtime ${JSON.stringify(runtime)}`);
  }

  let loaded = false;
  let frozen = false;
  let started = false;
  let read = false;

  const plugins = [];
  const widgetFactories = {};
  const widgetTypes = [];
  const widgetConfigConverters = {};
  const configKinds = {};
  const protos = [];
  const publications = [];
  const methods = [];

  function markRead() {
    read = true;
  }

  function assertOpen(pluginId, fnName) {
    if (frozen) {
      throw new PluginError(
        `${fnName} called after registration closed; register everything in register(ctx)`,
        pluginId
      );
    }
  }

  function makeRegistrationFns(plugin, reserved) {
    const pluginId = plugin.id;
    const knownTypes = new Set(widgetTypes.map((w) => w.type));

    function addWidgetType(type, label, scope) {
      validateWidgetType(pluginId, type);
      if (reserved.widgetTypes.has(type)) {
        throw new PluginError(`Widget type ${type} is reserved by core`, pluginId);
      }
      if (knownTypes.has(type) || widgetTypes.some((w) => w.type === type)) {
        throw new PluginError(`Widget type ${type} is already registered`, pluginId);
      }
      if (typeof label !== 'string' || !label) {
        throw new PluginError(`Widget type ${type} needs a label`, pluginId);
      }
      widgetTypes.push(Object.freeze({ type, label, scope, pluginId }));
    }

    const all = {
      registerProto(proto) {
        assertOpen(pluginId, 'registerProto');
        validateProto(pluginId, proto);
        if (protos.some((p) => p.pluginId === pluginId && p.name === proto.name)) {
          throw new PluginError(`Proto ${proto.name} is already registered`, pluginId);
        }
        protos.push(Object.freeze({ pluginId, name: proto.name, source: proto.source }));
      },

      registerWidget({ type, label, scope, factory } = {}) {
        assertOpen(pluginId, 'registerWidget');
        if (typeof factory !== 'function') {
          throw new PluginError(`Widget ${type} needs a factory function`, pluginId);
        }
        addWidgetType(type, label, scope);
        widgetFactories[type] = factory;
      },

      registerWidgetType({ type, label, scope, configConverter } = {}) {
        assertOpen(pluginId, 'registerWidgetType');
        if (configConverter !== undefined) {
          if (!isPlainObject(configConverter)) {
            throw new PluginError(`configConverter for ${type} must be an object`, pluginId);
          }
          for (const fn of ['configToSpec', 'specToConfig']) {
            if (configConverter[fn] !== undefined && typeof configConverter[fn] !== 'function') {
              throw new PluginError(`configConverter.${fn} for ${type} must be a function`, pluginId);
            }
          }
          if (
            configConverter.configSchema !== undefined &&
            !isPlainObject(configConverter.configSchema)
          ) {
            throw new PluginError(`configConverter.configSchema for ${type} must be an object`, pluginId);
          }
        }
        addWidgetType(type, label, scope);
        if (configConverter) widgetConfigConverters[type] = Object.freeze({ ...configConverter });
      },

      registerConfigKind({ kind, access, createHandler } = {}) {
        assertOpen(pluginId, 'registerConfigKind');
        validateKind(pluginId, kind);
        if (reserved.kinds.has(kind)) {
          throw new PluginError(`Config kind ${kind} is reserved by core`, pluginId);
        }
        if (configKinds[kind]) {
          throw new PluginError(
            `Config kind ${kind} is already registered by plugin ${configKinds[kind].pluginId}`,
            pluginId
          );
        }
        if (!CONFIG_KIND_ACCESS_VALUES.includes(access)) {
          throw new PluginError(
            `Config kind ${kind} needs access set to one of: ${CONFIG_KIND_ACCESS_VALUES.join(', ')}`,
            pluginId
          );
        }
        if (typeof createHandler !== 'function') {
          throw new PluginError(`Config kind ${kind} needs a createHandler function`, pluginId);
        }
        configKinds[kind] = Object.freeze({ pluginId, access, createHandler });
      },
    };

    function addEndpoint(list, label, { name, access, handler } = {}) {
      if (typeof name !== 'string' || !ENDPOINT_NAME_RE.test(name)) {
        throw new PluginError(
          `Invalid ${label} name ${JSON.stringify(name)}: must match ${ENDPOINT_NAME_RE}`,
          pluginId
        );
      }
      if (!ENDPOINT_ACCESS_VALUES.includes(access)) {
        throw new PluginError(
          `${label} ${name} needs access set to one of: ${ENDPOINT_ACCESS_VALUES.join(', ')}`,
          pluginId
        );
      }
      if (typeof handler !== 'function') {
        throw new PluginError(`${label} ${name} needs a handler function`, pluginId);
      }
      if (list.some((e) => e.pluginId === pluginId && e.name === name)) {
        throw new PluginError(`${label} ${name} is already registered`, pluginId);
      }
      list.push(
        Object.freeze({
          pluginId,
          name,
          fullName: pluginEndpointName(pluginId, name),
          access,
          handler,
        })
      );
    }

    all.registerPublication = (def) => {
      assertOpen(pluginId, 'registerPublication');
      addEndpoint(publications, 'Publication', def);
    };

    all.registerMethod = (def) => {
      assertOpen(pluginId, 'registerMethod');
      addEndpoint(methods, 'Method', def);
    };

    const allowed = REGISTRATIONS_BY_RUNTIME[runtime];
    const fns = {};
    for (const name of Object.keys(all)) {
      fns[name] = allowed.includes(name)
        ? all[name]
        : () => {
            throw new PluginError(`${name} is not available in the ${runtime} runtime`, pluginId);
          };
    }
    return fns;
  }

  return {
    runtime,

    /**
     * Registers the enabled plugins, in the order of `enabled`, and freezes the
     * registry. Synchronous and callable once.
     *
     * @param {object} options
     * @param {object[]} options.plugins installed plugin objects for this runtime
     * @param {string[]} options.enabled ids to activate
     * @param {(plugin) => object} [options.makeContext] core services for ctx
     */
    load({ plugins: installed = [], enabled = [], makeContext = () => ({}) } = {}) {
      if (loaded) throw new PluginError('Plugin registry already loaded');
      if (!Array.isArray(installed) || !Array.isArray(enabled)) {
        throw new PluginError('load() expects arrays for plugins and enabled');
      }
      if (enabled.length > 0 && read) {
        throw new PluginError(
          'Plugin registry was read before plugins were loaded; load plugins earlier in startup'
        );
      }
      loaded = true;

      const byId = new Map();
      for (const plugin of installed) {
        validatePluginShape(plugin);
        if (byId.has(plugin.id)) {
          throw new PluginError('Duplicate plugin id', plugin.id);
        }
        byId.set(plugin.id, plugin);
      }

      const reserved = {
        widgetTypes: resolveList(reservedWidgetTypes),
        kinds: resolveList(reservedKinds),
      };

      const seen = new Set();
      for (const id of enabled) {
        if (seen.has(id)) throw new PluginError('Plugin enabled twice', id);
        seen.add(id);
        const plugin = byId.get(id);
        if (!plugin) {
          const installedIds = [...byId.keys()].join(', ') || '(none)';
          throw new PluginError(
            `Plugin is enabled but not installed for the ${runtime} runtime. Installed: ${installedIds}`,
            id
          );
        }
        if (!satisfies(sdkVersion, plugin.sdkRange)) {
          throw new PluginError(
            `Requires oro-plugin-sdk ${plugin.sdkRange}, but core provides ${sdkVersion}`,
            id
          );
        }
        const ctx = {
          ...makeContext(plugin),
          ...makeRegistrationFns(plugin, reserved),
        };
        plugin.register(ctx);
        plugins.push(plugin);
      }
      frozen = true;
    },

    /**
     * Runs each loaded plugin's optional async `start(ctx)`, sequentially.
     * @param {(plugin) => object} [makeStartContext]
     */
    async start(makeStartContext = () => ({})) {
      if (!loaded) throw new PluginError('start() called before load()');
      if (started) throw new PluginError('Plugin registry already started');
      started = true;
      for (const plugin of plugins) {
        if (plugin.start) await plugin.start(makeStartContext(plugin));
      }
    },

    isLoaded() {
      return loaded;
    },

    getPlugins() {
      markRead();
      return Object.freeze(
        plugins.map((p) => Object.freeze({ id: p.id, version: p.version }))
      );
    },

    getWidgetFactories() {
      markRead();
      return Object.freeze({ ...widgetFactories });
    },

    getWidgetTypes() {
      markRead();
      return Object.freeze([...widgetTypes]);
    },

    getWidgetConfigConverters() {
      markRead();
      return Object.freeze({ ...widgetConfigConverters });
    },

    /** Server: `{ [kind]: { pluginId, access, createHandler } }`. */
    getConfigKinds() {
      markRead();
      return Object.freeze({ ...configKinds });
    },

    getProtos() {
      markRead();
      return Object.freeze([...protos]);
    },

    /** Server: `[{ pluginId, name, fullName, access, handler }]`. */
    getPublications() {
      markRead();
      return Object.freeze([...publications]);
    },

    /** Server: `[{ pluginId, name, fullName, access, handler }]`. */
    getMethods() {
      markRead();
      return Object.freeze([...methods]);
    },
  };
}

exports.RUNTIMES = RUNTIMES;
exports.ENDPOINT_ACCESS = ENDPOINT_ACCESS;
exports.CONFIG_KIND_ACCESS = CONFIG_KIND_ACCESS;
exports.createRegistry = createRegistry;
