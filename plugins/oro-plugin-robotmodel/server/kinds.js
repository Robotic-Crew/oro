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
 * ConfigAPI kinds of the robotmodel plugin.
 *
 * `RobotModel`: a 3D model (URDF) for one robot type. The spec only points at
 * the assets: the URDF and its meshes are served from the app (plugin assets
 * at /plugins/robotmodel/..., or the app's public/ folder) or from an origin
 * listed in the `allowedAssetOrigins` plugin setting, ideally after
 * tools/urdf_optimize.py converted the meshes to compressed GLB.
 *
 * `RobotModelAssignment`: which model a robot uses (metadata.id is the robot
 * id), and optional static `joints` positions, e.g. for a ghost robot.
 *
 * Both kinds are registered with access 'fleet.configure', which core
 * enforces; the handlers check it again.
 */
import Validator from 'fastest-validator';
import {
  KIND_MODEL, KIND_ASSIGNMENT, JOINT_NAME_RE, isAllowedAssetUrl, normalizeOrigins,
} from '../shared';

// Same as core's ID_PATTERN (shared/configAPI.js)
const ID_RE = /^[a-zA-Z0-9_-]+$/;
const MODEL_FIELDS = ['label', 'urdf', 'packages', 'jointMap'];
const ASSIGNMENT_FIELDS = ['model', 'joints'];
// Snapshot timestamp of static joints: older than any live sample
export const STATIC_JOINTS_TS = 1;
const MAX_RECORD_KEYS = 256;

// URLs are checked against the allowed origins after the schema (isAllowedAssetUrl)
const url = { type: 'string', empty: false, max: 2048 };
const jointKey = { type: 'string', pattern: JOINT_NAME_RE };
const v = new Validator();
const modelValidator = v.compile({
  $$strict: true,
  label: { type: 'string', optional: true, empty: false, max: 256 },
  urdf: url,
  packages: { type: 'record', optional: true, key: { type: 'string', pattern: ID_RE }, value: url },
  jointMap: { type: 'record', optional: true, key: jointKey, value: jointKey },
});
const assignmentValidator = v.compile({
  $$strict: true,
  model: { type: 'string', pattern: ID_RE },
  joints: { type: 'record', optional: true, key: jointKey, value: 'number' },
});

const pick = (doc, fields) => Object.fromEntries(
  fields.filter((f) => doc[f] !== undefined).map((f) => [f, doc[f]]),
);

/** JSON with sorted keys, to compare documents whatever their key order */
const canonical = (value) => JSON.stringify(value, (key, val) => (
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
    : val
));
const sameDoc = (a, b) => canonical(a) === canonical(b);

/**
 * Replaces the document `_id` with `doc` in one write (an upsert with a
 * replacement document), unless the stored one is identical: viewers then
 * don't reload anything.
 */
const replaceDoc = async (collection, _id, doc) => {
  const existing = await collection.findOneAsync({ _id });
  if (existing && sameDoc(existing, { _id, ...doc })) return;
  await collection.upsertAsync({ _id }, doc);
};

const makeHelpers = ({ errors, auth }) => ({
  assertAuthorized: async (user) => {
    if (!user || !(await auth.canConfigureFleet(user))) {
      throw new errors.AuthorizationError('Unauthorized');
    }
  },
  idOf: (configObject) => {
    const id = String(configObject?.metadata?.id || '');
    if (!ID_RE.test(id)) throw new errors.ValidationError(`metadata.id must match ${ID_RE}`);
    return id;
  },
  validate: (validator, kind, spec) => {
    const result = validator(spec || {});
    if (result !== true) {
      throw new errors.SchemaError(`${kind} spec is invalid: ${result.map((r) => r.message).join('; ')}`);
    }
    ['packages', 'jointMap', 'joints'].forEach((field) => {
      if (spec[field] && Object.keys(spec[field]).length > MAX_RECORD_KEYS) {
        throw new errors.SchemaError(`${kind} spec is invalid: ${field} has more than ${MAX_RECORD_KEYS} entries`);
      }
    });
  },
});

/** Allowed absolute asset origins, from the `allowedAssetOrigins` plugin setting */
const allowedOriginsOf = ({ settings, log }) => {
  const { origins, invalid } = normalizeOrigins(settings?.allowedAssetOrigins);
  if (invalid.length) log?.warn(`ignoring invalid allowedAssetOrigins entries: ${JSON.stringify(invalid)}`);
  return origins;
};

export function createModelHandler(ctx, { models, assignments }) {
  const { assertAuthorized, idOf, validate } = makeHelpers(ctx);
  const allowedOrigins = allowedOriginsOf(ctx);
  return {
    isGlobalConfig: () => false,

    list: async ({ id = null, user, format } = {}) => {
      await assertAuthorized(user);
      const docs = await models.find(id ? { _id: id } : {}).fetchAsync();
      if (format === 'short') return docs.map((doc) => ({ id: doc._id, label: doc.label || doc._id }));
      return docs.map((doc) => ({
        apiVersion: 'v0.1', kind: KIND_MODEL, metadata: { id: doc._id }, spec: pick(doc, MODEL_FIELDS),
      }));
    },

    apply: async ({ configObject, user }) => {
      await assertAuthorized(user);
      const id = idOf(configObject);
      const spec = configObject.spec || {};
      validate(modelValidator, KIND_MODEL, spec);
      const urls = [spec.urdf, ...Object.values(spec.packages || {})];
      const bad = urls.find((u) => !isAllowedAssetUrl(u, allowedOrigins));
      if (bad !== undefined) {
        throw new ctx.errors.SchemaError(
          `${KIND_MODEL} spec is invalid: ${JSON.stringify(bad)} must be a path on the app origin (/...)`
          + ' or an http(s) URL on an origin listed in the allowedAssetOrigins plugin setting',
        );
      }
      // Re-applying replaces the model wholesale
      await replaceDoc(models, id, pick(spec, MODEL_FIELDS));
    },

    clear: async ({ configObject, user }) => {
      await assertAuthorized(user);
      const id = idOf(configObject);
      const users = await assignments.find({ model: id }, { fields: { _id: 1 } }).fetchAsync();
      if (users.length) {
        throw new ctx.errors.ValidationError(
          `${KIND_MODEL} ${id} is assigned to robots ${users.map((r) => r._id).join(', ')}; clear their ${KIND_ASSIGNMENT} first`,
        );
      }
      await models.removeAsync({ _id: id });
    },
  };
}

/**
 * Static joints snapshot of an assignment. Only written when the robot has no
 * snapshot yet or it is the static one: live joint states are never replaced.
 */
const writeStaticJoints = async (jointStates, robotId, joints) => {
  const snapshot = { names: Object.keys(joints), positions: Object.values(joints), ts: STATIC_JOINTS_TS };
  const updated = await jointStates.updateAsync({ _id: robotId, ts: STATIC_JOINTS_TS }, { $set: snapshot });
  if (updated) return;
  try {
    await jointStates.insertAsync({ _id: robotId, ...snapshot });
  } catch (err) {
    // Duplicate key: a live snapshot exists, leave it
    if (err?.code !== 11000 && !/E11000/.test(err?.message)) throw err;
  }
};

export function createAssignmentHandler(ctx, { assignments, jointStates }) {
  const { assertAuthorized, idOf, validate } = makeHelpers(ctx);
  return {
    isGlobalConfig: () => false,

    list: async ({ id = null, user, format } = {}) => {
      await assertAuthorized(user);
      const docs = await assignments.find(id ? { _id: id } : {}).fetchAsync();
      if (format === 'short') return docs.map((doc) => ({ id: doc._id, label: doc.model }));
      return docs.map((doc) => ({
        apiVersion: 'v0.1',
        kind: KIND_ASSIGNMENT,
        metadata: { id: doc._id },
        spec: pick(doc, ASSIGNMENT_FIELDS),
      }));
    },

    apply: async ({ configObject, user }) => {
      await assertAuthorized(user);
      const robotId = idOf(configObject);
      const spec = configObject.spec || {};
      validate(assignmentValidator, KIND_ASSIGNMENT, spec);
      // The model may be applied later in the same batch: not checked here
      await replaceDoc(assignments, robotId, pick(spec, ASSIGNMENT_FIELDS));
      if (spec.joints) {
        await writeStaticJoints(jointStates, robotId, spec.joints);
      } else {
        // Static joints of a previous version of the assignment; live data stays
        await jointStates.removeAsync({ _id: robotId, ts: STATIC_JOINTS_TS });
      }
    },

    clear: async ({ configObject, user }) => {
      await assertAuthorized(user);
      const robotId = idOf(configObject);
      const doc = await assignments.findOneAsync({ _id: robotId });
      await assignments.removeAsync({ _id: robotId });
      // Only the static snapshot this assignment wrote; live data stays
      if (doc?.joints) await jointStates.removeAsync({ _id: robotId, ts: STATIC_JOINTS_TS });
    },
  };
}
