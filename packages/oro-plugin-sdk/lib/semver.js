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

// Minimal semver range matcher, enough for plugin `sdkRange` checks.
// Supports: 'x.y.z', '^x.y.z', '~x.y.z' and '*'. Pre-release tags are not
// supported on purpose: plugins declare ranges against released SDKs.

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(version) {
  const match = VERSION_RE.exec(String(version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function isValidVersion(version) {
  return parseVersion(version) !== null;
}

function isValidRange(range) {
  if (typeof range !== 'string') return false;
  const r = range.trim();
  if (r === '*') return true;
  const op = r[0] === '^' || r[0] === '~' ? r[0] : '';
  return parseVersion(r.slice(op.length)) !== null;
}

/**
 * Returns true when `version` satisfies `range`.
 * Caret on 0.x pins the minor (`^0.1.0` matches `0.1.x`, not `0.2.0`), and on
 * 0.0.x pins the patch, as in npm.
 */
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v || !isValidRange(range)) return false;
  const r = range.trim();
  if (r === '*') return true;

  const op = r[0] === '^' || r[0] === '~' ? r[0] : '';
  const base = parseVersion(r.slice(op.length));
  if (compare(v, base) < 0) return false;

  if (op === '') return compare(v, base) === 0;
  if (op === '~') return v[0] === base[0] && v[1] === base[1];
  // caret
  if (base[0] > 0) return v[0] === base[0];
  if (base[1] > 0) return v[0] === 0 && v[1] === base[1];
  return v[0] === 0 && v[1] === 0 && v[2] === base[2];
}

exports.satisfies = satisfies;
exports.isValidVersion = isValidVersion;
exports.isValidRange = isValidRange;
