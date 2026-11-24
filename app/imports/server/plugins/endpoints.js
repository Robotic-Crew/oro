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
 * Meteor publications and methods declared by plugins (`ctx.registerPublication`,
 * `ctx.registerMethod`). Core owns the Meteor endpoint and enforces the declared
 * access policy before the plugin handler runs, so a plugin can't forget it.
 *
 * Endpoints are named `plugin.<id>.<name>` and take a single object argument.
 */
import { Meteor } from 'meteor/meteor';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { ENDPOINT_ACCESS } from 'oro-plugin-sdk';
import OroRoles from '../roles';
import { ACCESS_LEVEL_VIEW } from '../../shared/roles';
import {
  ValidationError, SchemaError, AuthorizationError, NotFoundError,
} from '../../shared/configAPI';
import { makePluginLogger } from '../../lib/plugins/registry';

const UNAUTHORIZED = 'Unauthorized';
// Same as core's ID_PATTERN (shared/configAPI.js)
const ROBOT_ID_RE = /^[a-zA-Z0-9_-]{1,255}$/;
// Per connection and endpoint: calls / subscriptions allowed per interval
export const PLUGIN_RATE_LIMIT = Object.freeze({ calls: 20, intervalMs: 1000 });

// fullName -> current definition. Meteor endpoints can't be redefined, so each
// name gets one trampoline that reads its definition at call time; reloading
// plugins (tests) swaps definitions without redefining endpoints.
const publications = new Map();
const methods = new Map();
const definedPublications = new Set();
const definedMethods = new Set();

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

/**
 * Checks the endpoint's access policy. Returns the handler args, or null when
 * the call is not authorized.
 */
const authorize = async (def, userId, params) => {
  if (!def || !userId || !isPlainObject(params)) return null;
  if (def.access === ENDPOINT_ACCESS.ROBOT_VIEW) {
    const { robotId } = params;
    if (typeof robotId !== 'string' || !ROBOT_ID_RE.test(robotId)) return null;
    if (!await new OroRoles().canAccessRobot(userId, robotId, ACCESS_LEVEL_VIEW)) return null;
    return { userId, robotId, params };
  }
  return null; // unknown policy: deny
};

const toMeteorError = (def, err) => {
  if (err instanceof Meteor.Error) return err;
  if (err instanceof ValidationError || err instanceof SchemaError) {
    return new Meteor.Error('wrong-parameter', err.message);
  }
  if (err instanceof NotFoundError) return new Meteor.Error('not-found', err.message);
  if (err instanceof AuthorizationError) return new Meteor.Error(UNAUTHORIZED);
  makePluginLogger(def.pluginId).error(`Method ${def.name} failed`, err);
  return new Meteor.Error('internal-error');
};

/** Runs a plugin method as `userId`. Exported for tests. */
export const runPluginMethod = async (fullName, { userId }, params) => {
  const def = methods.get(fullName);
  const args = await authorize(def, userId, params);
  if (!args) throw new Meteor.Error(UNAUTHORIZED);
  try {
    return await def.handler(args);
  } catch (err) {
    throw toMeteorError(def, err);
  }
};

/**
 * Runs a plugin publication handler as `userId` and returns the cursors it may
 * publish (empty when unauthorized). Only cursors of the plugin's own
 * collections are allowed. Exported for tests.
 */
export const runPluginPublication = async (fullName, { userId }, params) => {
  const def = publications.get(fullName);
  const args = await authorize(def, userId, params);
  if (!args) return [];
  const result = await def.handler(args);
  if (result == null) return [];
  const cursors = Array.isArray(result) ? result : [result];
  const prefix = `plugin_${def.pluginId}_`;
  const foreign = cursors.find((c) => {
    const name = typeof c?._getCollectionName === 'function' ? c._getCollectionName() : null;
    return typeof name !== 'string' || !name.startsWith(prefix);
  });
  if (foreign) {
    makePluginLogger(def.pluginId).error(
      `Publication ${def.name} returned a cursor outside its collections (${prefix}*); nothing published`,
    );
    return [];
  }
  return cursors;
};

const definePublication = (fullName) => {
  if (definedPublications.has(fullName)) return;
  definedPublications.add(fullName);
  Meteor.publish(fullName, async function publishPluginEndpoint(params) {
    const cursors = await runPluginPublication(fullName, { userId: this.userId }, params);
    if (cursors.length === 0) return this.ready();
    return cursors.length === 1 ? cursors[0] : cursors;
  });
};

const defineMethod = (fullName) => {
  if (definedMethods.has(fullName)) return;
  definedMethods.add(fullName);
  Meteor.methods({
    async [fullName](params) {
      return runPluginMethod(fullName, { userId: this.userId }, params);
    },
  });
};

let rateLimitAdded = false;
const addRateLimit = () => {
  if (rateLimitAdded) return;
  rateLimitAdded = true;
  DDPRateLimiter.addRule({
    type: (type) => type === 'method' || type === 'subscription',
    name: (name) => typeof name === 'string' && name.startsWith('plugin.'),
    connectionId: () => true,
  }, PLUGIN_RATE_LIMIT.calls, PLUGIN_RATE_LIMIT.intervalMs);
};

/** Exposes the registry's plugin endpoints over DDP. Called after plugins load. */
export const registerPluginEndpoints = (registry) => {
  addRateLimit();
  publications.clear();
  methods.clear();
  registry.getPublications().forEach((def) => {
    publications.set(def.fullName, def);
    definePublication(def.fullName);
  });
  registry.getMethods().forEach((def) => {
    methods.set(def.fullName, def);
    defineMethod(def.fullName);
  });
};
