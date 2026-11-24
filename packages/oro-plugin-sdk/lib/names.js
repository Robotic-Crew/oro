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

const { PluginError, PLUGIN_ID_RE } = require('./validate');

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]*$/;
const ENDPOINT_NAME_RE = /^[a-z][A-Za-z0-9]*$/;

function assertPluginId(id) {
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    throw new PluginError(`Invalid plugin id ${JSON.stringify(id)}`);
  }
}

/** Mongo collection owned by a plugin: `plugin_<id>_<name>`. */
function pluginCollectionName(id, name) {
  assertPluginId(id);
  if (typeof name !== 'string' || !COLLECTION_NAME_RE.test(name)) {
    throw new PluginError(
      `Invalid collection name ${JSON.stringify(name)}: must match ${COLLECTION_NAME_RE}`,
      id
    );
  }
  return `plugin_${id}_${name}`;
}

/** Meteor publication/method name of a plugin endpoint: `plugin.<id>.<name>`. */
function pluginEndpointName(id, name) {
  assertPluginId(id);
  if (typeof name !== 'string' || !ENDPOINT_NAME_RE.test(name)) {
    throw new PluginError(
      `Invalid endpoint name ${JSON.stringify(name)}: must match ${ENDPOINT_NAME_RE}`,
      id
    );
  }
  return `plugin.${id}.${name}`;
}

/** Prefix of every time series field a plugin writes or reads: `<id>_`. */
function pluginFieldPrefix(id) {
  assertPluginId(id);
  return `${id}_`;
}

exports.COLLECTION_NAME_RE = COLLECTION_NAME_RE;
exports.ENDPOINT_NAME_RE = ENDPOINT_NAME_RE;
exports.pluginCollectionName = pluginCollectionName;
exports.pluginEndpointName = pluginEndpointName;
exports.pluginFieldPrefix = pluginFieldPrefix;
