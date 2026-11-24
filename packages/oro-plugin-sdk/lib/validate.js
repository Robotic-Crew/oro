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

const { isValidVersion, isValidRange } = require('./semver');

const PLUGIN_ID_RE = /^[a-z][a-z0-9]{1,31}$/;
const KIND_RE = /^[A-Z][A-Za-z0-9]+$/;
const WIDGET_NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const PROTO_IMPORT_RE = /^\s*import\s/m;
const PROTO_EXTEND_RE = /^\s*extend\s/m;
const PROTO_PACKAGE_RE = /^\s*package\s+([A-Za-z0-9_.]+)\s*;/gm;

// Ids that would read as core names in collections, endpoints, topics or protos
const RESERVED_PLUGIN_IDS = Object.freeze([
  'core', 'oro', 'system', 'plugin', 'plugins', 'admin', 'meteor', 'inorbit', 'robot', 'robots',
]);

/** Proto source without comments, so commented-out statements can't fool the checks. */
function stripProtoComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

class PluginError extends Error {
  constructor(message, pluginId) {
    super(pluginId ? `[plugin:${pluginId}] ${message}` : message);
    this.name = 'PluginError';
    this.pluginId = pluginId;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Throws PluginError when `plugin` doesn't have the shape the SDK expects. */
function validatePluginShape(plugin) {
  if (!isPlainObject(plugin)) {
    throw new PluginError('Plugin must be an object');
  }
  const { id, version, sdkRange, register, start } = plugin;
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    throw new PluginError(
      `Invalid plugin id ${JSON.stringify(id)}: must match ${PLUGIN_ID_RE}`
    );
  }
  if (RESERVED_PLUGIN_IDS.includes(id)) {
    throw new PluginError(`Plugin id ${JSON.stringify(id)} is reserved`, id);
  }
  if (!isValidVersion(version)) {
    throw new PluginError(`Invalid version ${JSON.stringify(version)}: must be x.y.z`, id);
  }
  if (!isValidRange(sdkRange)) {
    throw new PluginError(
      `Invalid sdkRange ${JSON.stringify(sdkRange)}: use 'x.y.z', '^x.y.z', '~x.y.z' or '*'`,
      id
    );
  }
  if (typeof register !== 'function') {
    throw new PluginError('register(ctx) must be a function', id);
  }
  if (start !== undefined && typeof start !== 'function') {
    throw new PluginError('start(ctx), when present, must be a function', id);
  }
}

/** Widget types are namespaced by plugin: `<pluginId>:<name>`. */
function validateWidgetType(pluginId, type) {
  const prefix = `${pluginId}:`;
  if (
    typeof type !== 'string' ||
    !type.startsWith(prefix) ||
    !WIDGET_NAME_RE.test(type.slice(prefix.length))
  ) {
    throw new PluginError(
      `Invalid widget type ${JSON.stringify(type)}: must be '${prefix}<name>' with an alphanumeric name`,
      pluginId
    );
  }
}

function validateKind(pluginId, kind) {
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) {
    throw new PluginError(
      `Invalid config kind ${JSON.stringify(kind)}: must match ${KIND_RE}`,
      pluginId
    );
  }
}

function validateProto(pluginId, { name, source } = {}) {
  if (typeof name !== 'string' || !name) {
    throw new PluginError('registerProto requires a name', pluginId);
  }
  if (typeof source !== 'string' || !source) {
    throw new PluginError(`Proto ${name} has no source`, pluginId);
  }
  const code = stripProtoComments(source);
  const packages = [...code.matchAll(PROTO_PACKAGE_RE)].map((m) => m[1]);
  if (packages.length !== 1 || packages[0] !== `oro.${pluginId}`) {
    throw new PluginError(`Proto ${name} must declare exactly 'package oro.${pluginId};'`, pluginId);
  }
  if (PROTO_IMPORT_RE.test(code)) {
    throw new PluginError(
      `Proto ${name} must not use import statements; reference core types by full name (oro.X)`,
      pluginId
    );
  }
  if (PROTO_EXTEND_RE.test(code)) {
    throw new PluginError(`Proto ${name} must not extend other messages`, pluginId);
  }
}

exports.PluginError = PluginError;
exports.isPlainObject = isPlainObject;
exports.validatePluginShape = validatePluginShape;
exports.validateWidgetType = validateWidgetType;
exports.validateKind = validateKind;
exports.validateProto = validateProto;
exports.PLUGIN_ID_RE = PLUGIN_ID_RE;
exports.RESERVED_PLUGIN_IDS = RESERVED_PLUGIN_IDS;
