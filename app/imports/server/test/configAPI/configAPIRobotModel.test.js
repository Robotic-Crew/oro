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
 * Configuration as code tests for the RobotModel kind
 */
import { Meteor } from 'meteor/meteor';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
// ORO modules
import { resetDatabase } from '../setup';
import ConfigAPI from '../../configAPI/configAPI';
import OroRoles from '../../roles';
import {
  AuthorizationError, SchemaError, ValidationError, LIST_FORMAT_FULL, KIND_ROBOT_MODEL, KIND_ROBOT,
} from '../../../shared/configAPI';
import { ROLE_VIEWER, ROLE_MANAGER } from '../../../lib/roles';
import { createUser } from '../configAPI';
import { RobotModels } from '../../../lib/collections';

if (!Meteor.isTest) throw new Error('This is TEST code only');
const { expect } = chai;
chai.use(chaiAsPromised);

const SPEC = {
  label: 'UR5e',
  urdf: '/robot-models/ur5e/ur5e.urdf',
  packages: { ur_description: 'https://cdn.example.com/ur_description' },
  jointMap: { joint_1: 'shoulder_pan_joint' },
};
const obj = (spec, id = 'ur5e') => ({ kind: KIND_ROBOT_MODEL, apiVersion: 'v0.1', metadata: { id }, spec });

describe('configAPI:RobotModel', () => {
  let configApi;
  let manager;

  beforeEach(async () => {
    await resetDatabase();
    configApi = await new ConfigAPI().init({});
    await new OroRoles().createDefaultRoles();
    manager = await createUser({ id: 'mgr', role: ROLE_MANAGER });
  });

  after(resetDatabase);

  it('apply: rejects viewers', async () => {
    const user = await createUser({ role: ROLE_VIEWER });
    await expect(configApi.apply({ configObject: obj(SPEC), user })).to.be.rejectedWith(AuthorizationError);
  });

  it('apply: stores the model; re-apply replaces it wholesale', async () => {
    await configApi.apply({ configObject: obj(SPEC), user: manager });
    expect(await RobotModels.findOneAsync({ _id: 'ur5e' })).to.deep.equal({ _id: 'ur5e', ...SPEC });
    await configApi.apply({ configObject: obj({ urdf: '/other.urdf' }), user: manager });
    expect(await RobotModels.findOneAsync({ _id: 'ur5e' })).to.deep.equal({ _id: 'ur5e', urdf: '/other.urdf' });
  });

  it('apply: schema rejects a missing urdf, unsafe URLs and unknown keys', async () => {
    const bad = [
      {},
      { urdf: 'javascript:alert(1)' },
      { urdf: 'robot.urdf' },
      { urdf: '/a.urdf', packages: { pkg: 'data:text/plain,x' } },
      { urdf: '/a.urdf', upAxis: 'y' },
    ];
    for (const spec of bad) {
      await expect(configApi.apply({ configObject: obj(spec), user: manager })).to.be.rejectedWith(SchemaError);
    }
  });

  it('apply: rejects a malformed id', async () => {
    await expect(configApi.apply({ configObject: obj(SPEC, 'ur 5e'), user: manager }))
      .to.be.rejectedWith(ValidationError);
  });

  it('list: short is {id,label}; full round-trips', async () => {
    await configApi.apply({ configObject: obj(SPEC), user: manager });
    const short = await configApi.list({ kind: KIND_ROBOT_MODEL, user: manager });
    expect(short[0]).to.include({ id: 'ur5e', label: 'UR5e' });
    const [full] = await configApi.list({ kind: KIND_ROBOT_MODEL, user: manager, format: LIST_FORMAT_FULL });
    expect(full.spec).to.deep.equal(SPEC);
    await configApi.apply({ configObject: full, user: manager });
  });

  it('clear: refuses while a robot uses the model', async () => {
    await configApi.apply({ configObject: obj(SPEC), user: manager });
    const robot = { kind: KIND_ROBOT, apiVersion: 'v0.1', metadata: { id: 'arm-1' } };
    await configApi.apply({ configObject: { ...robot, spec: { model: 'ur5e' } }, user: manager });
    await expect(configApi.clear({ configObject: obj(), user: manager })).to.be.rejectedWith(ValidationError);

    await configApi.apply({ configObject: { ...robot, spec: { model: null } }, user: manager });
    await configApi.clear({ configObject: obj(), user: manager });
    expect(await RobotModels.findOneAsync({ _id: 'ur5e' })).to.equal(undefined);
  });
});
