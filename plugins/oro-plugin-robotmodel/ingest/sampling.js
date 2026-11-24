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
 * Per-robot sampling state of the robotmodel ingest: rate limiting, the joint
 * states deadband and the scene throttle. Pure Node, no ORO imports, so the
 * plugin tests run it directly. Every map forgets robots that have been silent
 * for `ttlMs`.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SWEEP_EVERY_MS = 60 * 1000;

/**
 * Map whose entries expire `ttlMs` after their last `set`. Expired entries are
 * swept at most every `sweepEveryMs`, on access.
 */
const makeExpiringMap = ({ ttlMs = DEFAULT_TTL_MS, sweepEveryMs = DEFAULT_SWEEP_EVERY_MS } = {}) => {
  const entries = new Map();
  let lastSweep = 0;
  const sweep = (now) => {
    if (now - lastSweep < sweepEveryMs) return;
    lastSweep = now;
    entries.forEach((entry, key) => {
      if (now - entry.touched >= ttlMs) entries.delete(key);
    });
  };
  return {
    get: (key, now = Date.now()) => {
      sweep(now);
      return entries.get(key)?.value;
    },
    set: (key, value, now = Date.now()) => {
      sweep(now);
      entries.set(key, { value, touched: now });
    },
    get size() { return entries.size; },
  };
};

/** Accepts one message per key every `intervalMs`. */
const makeRateLimiter = (intervalMs, options) => {
  const last = makeExpiringMap(options);
  return (key, now = Date.now()) => {
    const prev = last.get(key, now);
    if (prev !== undefined && now - prev < intervalMs) return false;
    last.set(key, now, now);
    return true;
  };
};

const movedBeyond = (prev, names, positions, deadband) => (
  !prev
  || prev.names.length !== names.length
  || names.some((name, ix) => name !== prev.names[ix] || Math.abs(positions[ix] - prev.positions[ix]) > deadband)
);

/**
 * Decides, for each (already rate limited) joint states sample, what to write:
 * - `timeseries`: some joint moved more than `deadband` since the last written
 *   point, the joint set changed, or `keepaliveMs` passed since it;
 * - `snapshot`: at most every `snapshotIntervalMs`, and only if the pose
 *   changed (beyond `deadband`) since the last written snapshot.
 * Returns `(robotId, { names, positions }, now) => { timeseries, snapshot }`
 * and records what it says to write.
 */
const makeJointSampler = ({ deadband, keepaliveMs, snapshotIntervalMs, ...options }) => {
  const state = makeExpiringMap(options);
  return (robotId, { names, positions }, now = Date.now()) => {
    const robot = state.get(robotId, now) || {};
    const timeseries = !robot.point || now - robot.point.at >= keepaliveMs
      || movedBeyond(robot.point, names, positions, deadband);
    const snapshot = (!robot.snapshot || now - robot.snapshot.at >= snapshotIntervalMs)
      && movedBeyond(robot.snapshot, names, positions, deadband);
    const sample = { names, positions, at: now };
    state.set(robotId, {
      point: timeseries ? sample : robot.point,
      snapshot: snapshot ? sample : robot.snapshot,
    }, now);
    return { timeseries, snapshot };
  };
};

/**
 * Runs `run(key, value)` at most once per key every `intervalMs`, keeping the
 * latest value that arrived in between and running it when the interval ends
 * (so the last of a burst is never lost). `run` errors go to `onError`.
 */
const makeThrottle = (intervalMs, run, {
  onError = () => {},
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  now: clock = Date.now,
  ...options
} = {}) => {
  const state = makeExpiringMap(options);
  const fire = async (key, value) => {
    try {
      await run(key, value);
    } catch (err) {
      onError(err, key);
    }
  };
  const flush = (key) => {
    const at = clock();
    const entry = state.get(key, at);
    if (!entry) return;
    const { pending } = entry;
    state.set(key, { last: at, pending: undefined, scheduled: false }, at);
    if (pending !== undefined) fire(key, pending);
  };
  return (key, value) => {
    const at = clock();
    const entry = state.get(key, at);
    if (!entry || at - entry.last >= intervalMs) {
      state.set(key, { last: at, pending: undefined, scheduled: false }, at);
      return fire(key, value);
    }
    state.set(key, { ...entry, pending: value, scheduled: true }, at);
    if (!entry.scheduled) schedule(() => flush(key), entry.last + intervalMs - at);
    return undefined;
  };
};

/**
 * A numeric setting: `value` when it is a finite number >= `min`, else
 * `fallback` (with a warning when a value was given).
 */
const numberSetting = (settings, name, fallback, min, log) => {
  const value = settings[name];
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value >= min) return value;
  log?.warn(`invalid ${name} ${JSON.stringify(value)} (must be a number >= ${min}); using ${fallback}`);
  return fallback;
};

module.exports = {
  makeExpiringMap, makeRateLimiter, makeJointSampler, makeThrottle, numberSetting,
};
