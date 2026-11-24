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
 * Joint samples and their interpolation, for the 3D model widget. No three.js and no React here.
 *
 * A sample is `{ t, values }`: a time (ms) and `{ [jointName]: position }`. Both live data and
 * replay go through `interpolateAt`, so the model moves smoothly whatever rate samples arrive at.
 */

/**
 * Index of the last sample with `t <= time` (binary search), or -1.
 */
const lastIndexAtOrBefore = (samples, time) => {
  let lo = 0;
  let hi = samples.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
};

/**
 * Joint values at `time`, linearly interpolated between the samples around it, or clamped to the
 * first/last sample. A joint missing from the next sample keeps its previous value.
 */
const interpolateAt = (samples, time) => {
  if (samples.length === 0) {
    return null;
  }
  const ix = lastIndexAtOrBefore(samples, time);
  if (ix < 0) {
    return samples[0].values;
  }
  const prev = samples[ix];
  const next = samples[ix + 1];
  if (!next || next.t === prev.t) {
    return prev.values;
  }
  const alpha = (time - prev.t) / (next.t - prev.t);
  const values = {};
  Object.entries(prev.values).forEach(([name, from]) => {
    const to = next.values[name];
    values[name] = to === undefined ? from : from + (to - from) * alpha;
  });
  return values;
};

/**
 * History rows from `jointStates.history` ({ names, values: [[ts, ...positions]] }) into
 * samples. A null position (joint missing from that point) carries the previous value over.
 * Samples are read-only: a row that changes nothing shares the previous sample's values.
 */
const samplesFromHistory = ({ names = [], values = [] } = {}) => {
  let last = {};
  return values.map(([t, ...positions]) => {
    let next = null;
    positions.forEach((position, ix) => {
      if (position !== null && position !== undefined && last[names[ix]] !== position) {
        next = next || { ...last };
        next[names[ix]] = position;
      }
    });
    last = next || last;
    return { t, values: last };
  });
};

/**
 * Buffer for live joint states. Samples are stamped with their arrival time (local clock: no
 * skew with the robot) and played back `delayMs` late, so there is usually a sample on each side
 * of the rendered time to interpolate between. The delay adapts to the observed interval.
 */
class LiveJointBuffer {
  constructor({ maxSamples = 32, minDelayMs = 40, maxDelayMs = 500 } = {}) {
    this._samples = [];
    this._maxSamples = maxSamples;
    this._minDelayMs = minDelayMs;
    this._maxDelayMs = maxDelayMs;
    this._intervalMs = 100;
  }

  get lastArrival() {
    return this._samples.length ? this._samples[this._samples.length - 1].t : null;
  }

  push(values, t = performance.now()) {
    const last = this._samples[this._samples.length - 1];
    if (last) {
      if (t <= last.t) {
        return;
      }
      // Exponential moving average of the arrival interval
      this._intervalMs = 0.8 * this._intervalMs + 0.2 * (t - last.t);
    }
    this._samples.push({ t, values });
    if (this._samples.length > this._maxSamples) {
      this._samples.shift();
    }
  }

  get delayMs() {
    return Math.min(this._maxDelayMs, Math.max(this._minDelayMs, this._intervalMs * 1.5));
  }

  /**
   * Values to render at `now`, and whether the model is still moving (more frames are needed).
   */
  sample(now = performance.now()) {
    const time = now - this.delayMs;
    const lastT = this.lastArrival;
    return {
      values: interpolateAt(this._samples, time),
      animating: lastT !== null && time < lastT,
    };
  }

  clear() {
    this._samples = [];
  }
}

export {
  interpolateAt,
  samplesFromHistory,
  LiveJointBuffer,
};
