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
import {
  createRegistry, RUNTIMES, SDK_VERSION, pluginCollectionName, pluginFieldPrefix,
} from 'oro-plugin-sdk';
import { addProtoSource as addProtoSourceToMqtt } from '../server/mqtt';
import TimeSeriesStore from '../shared/timeseriesStore';
import { COLLECTIONS } from '../shared/constants';
import installedPlugins from './installed';

export { pluginCollectionName };

const FIELD_RE = /^[A-Za-z0-9_]+$/;

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

// Robot messages a plugin listener accepts by default, and the most it may ask for
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
// Plugin time series points are buffered and written together
export const TIMESERIES_FLUSH_MS = 1000;
const TIMESERIES_MAX_BUFFER = 5000;
// Robot clocks may run ahead; points further in the future are stamped now
export const MAX_FUTURE_TS_MS = 60 * 1000;
const SUBTOPIC_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
const LOG_EVERY_MS = 60 * 1000;

/** Logs at most once a minute per key. */
const makeThrottledLog = (log) => {
  const last = new Map();
  return (key, ...args) => {
    const now = Date.now();
    if (now - (last.get(key) || 0) < LOG_EVERY_MS) return;
    last.set(key, now);
    log(...args);
  };
};

/**
 * Write access to the robot time series, limited to the plugin's own fields
 * (`<id>_*`). Points are tagged `meta: { robotId, src: <pluginId> }`, so core
 * queries don't scan them, and buffered: `buffer.flush()` writes them in one
 * insertMany (on a timer, see startIngestPlugins).
 */
const makeTimeseries = (pluginId, buffer) => {
  const prefix = pluginFieldPrefix(pluginId);
  return Object.freeze({
    write: async ({ robotId, ts, fields } = {}) => {
      if (typeof robotId !== 'string' || !robotId) {
        throw new Error(`[plugin:${pluginId}] timeseries.write needs a robotId`);
      }
      const keys = Object.keys(fields || {});
      const bad = keys.find((k) => !FIELD_RE.test(k) || !k.startsWith(prefix));
      if (keys.length === 0 || bad !== undefined) {
        throw new Error(
          `[plugin:${pluginId}] timeseries fields must be non-empty and start with '${prefix}'`
          + (bad !== undefined ? ` (got ${JSON.stringify(bad)})` : '')
        );
      }
      const now = Date.now();
      const time = Number.isFinite(ts) && ts <= now + MAX_FUTURE_TS_MS ? ts : now;
      buffer.add({ ts: time, meta: { robotId, src: pluginId }, fields: { ...fields } });
    },
  });
};

const makeTimeseriesBuffer = (getStore) => {
  let points = [];
  let flushing = Promise.resolve();
  const flush = () => {
    if (points.length === 0) return flushing;
    const batch = points;
    points = [];
    flushing = flushing
      .then(async () => (await getStore()).writeMany(batch))
      .catch((err) => console.error('[plugins] time series write failed', err));
    return flushing;
  };
  return {
    add: (point) => {
      if (points.length >= TIMESERIES_MAX_BUFFER) {
        points.shift(); // Mongo is behind: keep the newest points
      }
      points.push(point);
    },
    flush,
  };
};

/**
 * The plugin's view of MQTT. Listeners:
 *   - subtopic is `<pluginId>/...`, or any other one core doesn't listen to
 *     (logged); `system/*` and core subtopics are refused;
 *   - messages above `maxBytes` are dropped before the callback runs;
 *   - errors are caught and logged, so a plugin can't break other listeners.
 */
const makePluginMqtt = (plugin, mqtt, coreSubtopics, log) => {
  const warn = makeThrottledLog(log.warn);
  const own = `${plugin.id}/`;
  return Object.freeze({
    registerListener: (subtopic, callback, { maxBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) => {
      if (typeof subtopic !== 'string' || !SUBTOPIC_RE.test(subtopic) || subtopic.startsWith('system/')) {
        throw new Error(`[plugin:${plugin.id}] invalid subtopic ${JSON.stringify(subtopic)}`);
      }
      if (typeof callback !== 'function') {
        throw new Error(`[plugin:${plugin.id}] registerListener needs a callback`);
      }
      if (!subtopic.startsWith(own)) {
        if (coreSubtopics.has(subtopic)) {
          throw new Error(`[plugin:${plugin.id}] subtopic ${subtopic} belongs to core`);
        }
        log.warn(`listens on ${subtopic}, outside its ${own}* namespace`);
      }
      if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MESSAGE_BYTES) {
        throw new Error(`[plugin:${plugin.id}] maxBytes must be an integer in (0, ${MAX_MESSAGE_BYTES}]`);
      }
      mqtt.registerListener(subtopic, async (robotId, msg, packet) => {
        if (msg?.length > maxBytes) {
          warn(`big:${subtopic}`, `dropped ${msg.length} byte message on ${subtopic} from ${robotId} (max ${maxBytes})`);
          return;
        }
        try {
          await callback(robotId, msg, packet);
        } catch (err) {
          warn(`err:${subtopic}`, `listener for ${subtopic} failed`, err);
        }
      });
    },
    lookupType: (fullName) => mqtt.lookupType(fullName),
  });
};

/**
 * Runs plugins' `start(ctx)` hooks: they get MQTT listeners, their own
 * (prefixed) Mongo collections and time series fields.
 *
 * Call it after core modules registered their MQTT listeners: those subtopics
 * are reserved for core.
 *
 * @returns {{ flushTimeseries: () => Promise<void>, stop: () => Promise<void> }}
 */
export const startIngestPlugins = async (registry, {
  mqtt, mongo, settings, timeseriesFlushMs = TIMESERIES_FLUSH_MS,
}) => {
  let storePromise;
  const getStore = () => {
    if (!storePromise) {
      const store = new TimeSeriesStore({ db: mongo.db, collectionName: COLLECTIONS.TIMESERIES });
      storePromise = store.init().then(() => store);
      storePromise.catch(() => { storePromise = undefined; });
    }
    return storePromise;
  };
  const buffer = makeTimeseriesBuffer(getStore);
  const timer = setInterval(buffer.flush, timeseriesFlushMs);
  timer.unref?.();
  const coreSubtopics = new Set(mqtt.listenerSubtopics?.() || []);

  await registry.start((plugin) => {
    const common = commonContext(plugin, settings);
    return {
      ...common,
      mqtt: makePluginMqtt(plugin, mqtt, coreSubtopics, common.log),
      db: {
        collection: (name) => mongo.getCollection(pluginCollectionName(plugin.id, name)),
      },
      timeseries: makeTimeseries(plugin.id, buffer),
    };
  });

  return {
    flushTimeseries: () => buffer.flush(),
    stop: async () => {
      clearInterval(timer);
      await buffer.flush();
    },
  };
};
