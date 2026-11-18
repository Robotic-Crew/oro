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

const { version: SDK_VERSION } = require('./package.json');
const { satisfies } = require('./lib/semver');
const { PluginError, validatePluginShape } = require('./lib/validate');
const registry = require('./lib/registry');

/**
 * Declares a plugin entry for one runtime (client, server or ingest).
 * Validates its shape early so mistakes surface at import time, and freezes it.
 *
 * @param {object} def
 * @param {string} def.id lowercase alphanumeric, shared by all runtime entries
 * @param {string} def.version plugin version, x.y.z
 * @param {string} def.sdkRange supported SDK versions, e.g. '^0.1.0'
 * @param {(ctx: object) => void} def.register sync; register widgets, kinds, protos
 * @param {(ctx: object) => Promise<void>} [def.start] async; runs once core is up
 */
function definePlugin(def) {
  validatePluginShape(def);
  return Object.freeze({ ...def });
}

/** Creates a registry checked against this SDK's version. See lib/registry.js. */
function createRegistry(options = {}) {
  return registry.createRegistry({ sdkVersion: SDK_VERSION, ...options });
}

exports.SDK_VERSION = SDK_VERSION;
exports.RUNTIMES = registry.RUNTIMES;
exports.PluginError = PluginError;
exports.definePlugin = definePlugin;
exports.createRegistry = createRegistry;
exports.satisfies = satisfies;
