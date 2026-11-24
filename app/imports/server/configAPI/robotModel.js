/**
 * Copyright 2026 InOrbit, Inc.
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
 * `RobotModel` kind: a 3D model (URDF) for one robot type, drawn by the 3D model widget.
 *
 * Defined once per robot type and referenced by robots through the `Robot` kind
 * (`spec.model`), so all robots of a type share one download and one browser cache entry. The
 * spec only points at the assets: the URDF (and its meshes) are served from the app's `public/`
 * folder or any other origin, ideally after `tools/urdf_optimize.py` has converted the meshes to
 * compressed GLB. See docs/visualizer.md.
 */
import Validator from 'fastest-validator';

import OroRoles from '../roles';
import { Robots, RobotModels } from '../../lib/collections';
import {
  SchemaError, ValidationError, AuthorizationError, LIST_FORMAT_SHORT, KIND_ROBOT_MODEL, ID_PATTERN,
} from '../../shared/configAPI';
import { RESOURCE_SINGLETONS, ACCESS_LEVEL_CONFIGURE, isSystemUser } from '../../shared/roles';

const SPEC_FIELDS = ['label', 'urdf', 'packages', 'jointMap'];

// Same guard as robots.js: configure access on the fleet singleton.
const assertAuthorized = async (user) => {
  if (!user) throw new AuthorizationError('Unauthorized');
  if (!isSystemUser(user) && !await new OroRoles().canAccessSystemElement(
    user._id, RESOURCE_SINGLETONS.FLEET, ACCESS_LEVEL_CONFIGURE,
  )) {
    throw new AuthorizationError('Unauthorized');
  }
};

// Assets load in the browser: only http(s) URLs or paths on the app's own origin
const url = { type: 'string', pattern: /^(https?:\/\/|\/)\S+$/ };
const specValidator = new Validator().compile({
  $$strict: true,
  label: { type: 'string', optional: true, empty: false },
  urdf: url,
  packages: { type: 'record', optional: true, key: { type: 'string', pattern: ID_PATTERN }, value: url },
  jointMap: { type: 'record', optional: true, value: { type: 'string', empty: false } },
});

const idOf = (configObject) => {
  const id = String(configObject?.metadata?.id || '');
  if (!new RegExp(ID_PATTERN).test(id)) {
    throw new ValidationError(`metadata.id must match ${ID_PATTERN}`);
  }
  return id;
};

const toSpec = (doc) => Object.fromEntries(
  SPEC_FIELDS.filter((f) => doc[f] !== undefined).map((f) => [f, doc[f]]));

export class RobotModelConfigAPIHandler {
  constructor(configApi) { this._configApi = configApi; }

  isGlobalConfig = () => false;

  list = async ({ id = null, user, format = LIST_FORMAT_SHORT } = {}) => {
    await assertAuthorized(user);
    const docs = await RobotModels.find(id ? { _id: id } : {}).fetchAsync();
    if (format === LIST_FORMAT_SHORT) {
      return docs.map((doc) => ({ id: doc._id, label: doc.label || doc._id }));
    }
    return docs.map((doc) => ({
      apiVersion: 'v0.1',
      kind: KIND_ROBOT_MODEL,
      metadata: { id: doc._id },
      spec: toSpec(doc),
    }));
  };

  apply = async ({ configObject, user }) => {
    await assertAuthorized(user);
    const id = idOf(configObject);
    const spec = configObject.spec || {};
    const validation = specValidator(spec);
    if (validation !== true) {
      throw new SchemaError(`RobotModel spec is invalid: ${validation.map((v) => v.message).join('; ')}`);
    }
    // Re-applying replaces the model wholesale
    await RobotModels.removeAsync({ _id: id });
    await RobotModels.insertAsync({ _id: id, ...toSpec(spec) });
  };

  clear = async ({ configObject, user }) => {
    await assertAuthorized(user);
    const id = idOf(configObject);
    const users = await Robots.find({ model: id }, { projection: { _id: 1 } }).fetchAsync();
    if (users.length) {
      throw new ValidationError(
        `RobotModel ${id} is used by robots ${users.map((r) => r._id).join(', ')}; clear their model first`);
    }
    await RobotModels.removeAsync({ _id: id });
  };
}

export default RobotModelConfigAPIHandler;
