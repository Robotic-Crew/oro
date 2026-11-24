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
 * Joint sources pose the 3D model. RobotModelView polls `sample(now)` on animation frames (only
 * while it returns `animating`) and listens to `onChange` to know when to wake up. Data never
 * goes through React state: motion costs no re-renders.
 */
import { LiveJointBuffer, interpolateAt } from './jointSamples';

class JointSource {
  constructor() {
    this._listeners = new Set();
  }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    this._listeners.forEach((listener) => listener());
  }
}

/** Live joint states, interpolated (see LiveJointBuffer). */
class LiveJointSource extends JointSource {
  constructor() {
    super();
    this._buffer = new LiveJointBuffer();
  }

  /** Time (performance.now()) the last sample arrived, or null. */
  get lastArrival() {
    return this._buffer.lastArrival;
  }

  push(values, t = performance.now()) {
    this._buffer.push(values, t);
    this._notify();
  }

  sample(now) {
    return this._buffer.sample(now);
  }
}

/**
 * Replay of recorded samples ({ t: epoch ms, values }) over [startTs, endTs], with play/pause and
 * seek. Playback advances with the animation frames' clock.
 */
class ReplayJointSource extends JointSource {
  constructor({ samples, startTs, endTs }) {
    super();
    this.samples = samples;
    this.startTs = startTs;
    this.endTs = endTs;
    this.playbackTs = samples.length ? Math.max(startTs, samples[0].t) : startTs;
    this.playing = false;
    this.speed = 1;
    this._lastFrame = null;
  }

  sample(now) {
    if (this.playing) {
      if (this._lastFrame !== null) {
        this.playbackTs += (now - this._lastFrame) * this.speed;
      }
      this._lastFrame = now;
      if (this.playbackTs >= this.endTs) {
        this.playbackTs = this.endTs;
        this.pause();
      }
    }
    return { values: interpolateAt(this.samples, this.playbackTs), animating: this.playing };
  }

  play() {
    if (this.playbackTs >= this.endTs) {
      this.playbackTs = this.startTs;
    }
    this.playing = true;
    this._lastFrame = null;
    this._notify();
  }

  pause() {
    this.playing = false;
    this._lastFrame = null;
    this._notify();
  }

  seek(ts) {
    this.playbackTs = Math.min(this.endTs, Math.max(this.startTs, ts));
    this._lastFrame = null;
    this._notify();
  }
}

export { LiveJointSource, ReplayJointSource };
