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

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeExpiringMap, makeRateLimiter, makeJointSampler, makeThrottle, numberSetting,
} = require('../ingest/sampling');

test('makeRateLimiter: one per key per interval', () => {
  const accepts = makeRateLimiter(200);
  assert.ok(accepts('a', 1000));
  assert.ok(!accepts('a', 1100));
  assert.ok(accepts('b', 1100));
  assert.ok(accepts('a', 1200));
});

test('makeExpiringMap: forgets keys silent for ttlMs, swept occasionally', () => {
  const map = makeExpiringMap({ ttlMs: 1000, sweepEveryMs: 100 });
  map.set('a', 1, 0);
  map.set('b', 2, 500);
  assert.equal(map.size, 2);
  assert.equal(map.get('a', 1200), undefined);
  assert.equal(map.get('b', 1200), 2);
  assert.equal(map.size, 1);
  map.get('x', 1600);
  assert.equal(map.size, 0);
});

test('makeRateLimiter: prunes stale robots', () => {
  const accepts = makeRateLimiter(200, { ttlMs: 10_000, sweepEveryMs: 1000 });
  for (let ix = 0; ix < 100; ix += 1) accepts(`robot-${ix}`, 0);
  accepts('live', 20_000);
  // Only `live` is left: a fresh robot-0 is accepted and the map stays small
  assert.ok(accepts('robot-0', 20_001));
});

test('makeJointSampler: deadband, keepalive and snapshot interval', () => {
  const sample = makeJointSampler({ deadband: 1e-3, keepaliveMs: 10_000, snapshotIntervalMs: 1000 });
  const s = (positions, names = ['a', 'b']) => ({ names, positions });
  assert.deepEqual(sample('r', s([0, 0]), 0), { timeseries: true, snapshot: true });
  // Idle (below the deadband): nothing
  assert.deepEqual(sample('r', s([0.0005, 0]), 200), { timeseries: false, snapshot: false });
  // Moved: a point; the snapshot waits for its interval
  assert.deepEqual(sample('r', s([0.1, 0]), 400), { timeseries: true, snapshot: false });
  assert.deepEqual(sample('r', s([0.2, 0]), 1000), { timeseries: true, snapshot: true });
  // Unchanged after the interval: no snapshot rewrite
  assert.deepEqual(sample('r', s([0.2, 0]), 2200), { timeseries: false, snapshot: false });
  // Keepalive point
  assert.deepEqual(sample('r', s([0.2, 0]), 11_000), { timeseries: true, snapshot: false });
  // Joint set changed
  assert.deepEqual(sample('r', s([0.2], ['a']), 11_200), { timeseries: true, snapshot: true });
  // Robots are independent
  assert.deepEqual(sample('other', s([0.2, 0]), 11_200), { timeseries: true, snapshot: true });
});

test('makeThrottle: at most once per interval, the latest pending value runs at the end', async () => {
  let clock = 0;
  const timers = [];
  const runs = [];
  const errors = [];
  const throttled = makeThrottle(500, async (key, value) => {
    if (value === 'boom') throw new Error('boom');
    runs.push([key, value, clock]);
  }, {
    now: () => clock,
    schedule: (fn, ms) => timers.push({ fn, at: clock + ms }),
    onError: (err) => errors.push(err.message),
  });
  await throttled('r', 1);
  clock = 100;
  throttled('r', 2);
  clock = 200;
  throttled('r', 3);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, 500);
  await throttled('s', 1);
  clock = 500;
  timers.shift().fn();
  await new Promise(setImmediate);
  assert.deepEqual(runs, [['r', 1, 0], ['s', 1, 200], ['r', 3, 500]]);
  // Interval measured from the flushed run
  clock = 700;
  throttled('r', 4);
  assert.equal(timers[0].at, 1000);
  clock = 1000;
  timers.shift().fn();
  await new Promise(setImmediate);
  assert.deepEqual(runs.at(-1), ['r', 4, 1000]);
  clock = 2000;
  await throttled('r', 'boom');
  assert.deepEqual(errors, ['boom']);
});

test('numberSetting: finite numbers >= min, else the default with a warning', () => {
  const warnings = [];
  const log = { warn: (m) => warnings.push(m) };
  assert.equal(numberSetting({}, 'x', 200, 50, log), 200);
  assert.equal(numberSetting({ x: 100 }, 'x', 200, 50, log), 100);
  assert.equal(warnings.length, 0);
  [10, '100', NaN, Infinity, null, 'fast'].forEach((x) => {
    assert.equal(numberSetting({ x }, 'x', 200, 50, log), 200);
  });
  assert.equal(warnings.length, 6);
});
