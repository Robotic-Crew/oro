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
 * Server side of oro-plugin-robotmodel: the RobotModel and RobotModelAssignment
 * kinds, its publications and the joint states history method.
 */
import { Meteor } from 'meteor/meteor';
import { Mongo, MongoInternals } from 'meteor/mongo';
import sinon from 'sinon';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
// ORO modules
import { resetDatabase } from '../setup';
import { createUser } from '../configAPI';
import ConfigAPI from '../../configAPI/configAPI';
import OroRoles, { ROLE_MANAGER, ROLE_VIEWER } from '../../roles';
import TimeSeriesManager from '../../timeseries';
import {
  AuthorizationError, LIST_FORMAT_FULL, SchemaError, ValidationError,
} from '../../../shared/configAPI';
import {
  createPluginRegistryForTests, setPluginRegistryForTests,
} from '../../../lib/plugins/registry';
import { loadServerPlugins } from '../../plugins';
import { runPluginMethod, runPluginPublication } from '../../plugins/endpoints';

if (!Meteor.isTest) throw new Error('This is TEST code only');
const { expect } = chai;
chai.use(chaiAsPromised);

const KIND_MODEL = 'RobotModel';
const KIND_ASSIGNMENT = 'RobotModelAssignment';
const SPEC = {
  label: 'UR5e',
  urdf: '/plugins/robotmodel/demo-arm/demo_arm.urdf',
  packages: { ur_description: '/robot-assets/ur_description' },
  jointMap: { joint_1: 'shoulder_pan_joint' },
};
const model = (spec, id = 'ur5e') => ({ kind: KIND_MODEL, apiVersion: 'v0.1', metadata: { id }, spec });
const assignment = (spec, id = 'arm-1') => ({
  kind: KIND_ASSIGNMENT, apiVersion: 'v0.1', metadata: { id }, spec,
});
const db = () => MongoInternals.defaultRemoteCollectionDriver().mongo.db;
const coll = (name) => db().collection(`plugin_robotmodel_${name}`);

describe('oro-plugin-robotmodel (server)', () => {
  let configApi;
  let manager;
  const originalPluginSettings = Meteor.settings.plugins;

  // Loads the plugin with `config` as its (private) settings
  const loadPlugin = async (config) => {
    if (config) {
      Meteor.settings.plugins = {
        ...(originalPluginSettings || {}),
        config: { ...(originalPluginSettings?.config || {}), robotmodel: config },
      };
    }
    const registry = createPluginRegistryForTests();
    setPluginRegistryForTests(registry);
    loadServerPlugins({ registry, enabled: ['robotmodel'] });
    configApi = await new ConfigAPI().init({});
  };

  beforeEach(async () => {
    await resetDatabase();
    await new OroRoles().createDefaultRoles();
    await loadPlugin();
    manager = await createUser({ id: 'mgr', role: ROLE_MANAGER });
  });

  afterEach(() => {
    Meteor.settings.plugins = originalPluginSettings;
    setPluginRegistryForTests(undefined);
    sinon.restore();
  });

  after(resetDatabase);

  describe('RobotModel kind', () => {
    it('apply: rejects viewers', async () => {
      const user = await createUser({ role: ROLE_VIEWER });
      await expect(configApi.apply({ configObject: model(SPEC), user })).to.be.rejectedWith(AuthorizationError);
    });

    it('apply: stores the model; re-apply replaces it wholesale', async () => {
      await configApi.apply({ configObject: model(SPEC), user: manager });
      expect(await coll('models').findOne({ _id: 'ur5e' })).to.deep.equal({ _id: 'ur5e', ...SPEC });
      await configApi.apply({ configObject: model({ urdf: '/other.urdf' }), user: manager });
      expect(await coll('models').findOne({ _id: 'ur5e' })).to.deep.equal({ _id: 'ur5e', urdf: '/other.urdf' });
    });

    it('apply: schema rejects a missing urdf, unsafe URLs and unknown keys', async () => {
      const bad = [
        {},
        { urdf: 'javascript:alert(1)' },
        { urdf: 'robot.urdf' },
        { urdf: '/a.urdf', packages: { pkg: 'data:text/plain,x' } },
        { urdf: '/a.urdf', upAxis: 'y' },
        { urdf: '//evil.com/a.urdf' },
        { urdf: '/\\evil.com/a.urdf' },
        { urdf: 'https://cdn.example.com/a.urdf' },
        { urdf: '/a.urdf', packages: { pkg: 'https://cdn.example.com/pkg' } },
        { urdf: '/a.urdf', jointMap: { 'a.b': 'c' } },
        { urdf: '/a.urdf', jointMap: { a: '$c' } },
        { urdf: '/a.urdf', jointMap: JSON.parse('{"__proto__": "c"}') },
      ];
      for (const spec of bad) {
        await expect(configApi.apply({ configObject: model(spec), user: manager }), JSON.stringify(spec))
          .to.be.rejectedWith(SchemaError);
      }
    });

    it('apply: absolute asset URLs only on origins in allowedAssetOrigins', async () => {
      await loadPlugin({ allowedAssetOrigins: ['https://cdn.example.com', 'not an origin'] });
      const spec = { ...SPEC, packages: { ur_description: 'https://cdn.example.com/ur_description' } };
      await configApi.apply({ configObject: model(spec), user: manager });
      expect(await coll('models').findOne({ _id: 'ur5e' })).to.deep.equal({ _id: 'ur5e', ...spec });
      for (const urdf of ['https://evil.com/a.urdf', 'http://cdn.example.com/a.urdf', '//cdn.example.com/a.urdf']) {
        await expect(configApi.apply({ configObject: model({ urdf }), user: manager }), urdf)
          .to.be.rejectedWith(SchemaError);
      }
    });

    it('apply: re-applying the same model keeps the stored document', async () => {
      await configApi.apply({ configObject: model(SPEC), user: manager });
      const upsert = sinon.spy(Mongo.Collection.prototype, 'upsertAsync');
      await configApi.apply({ configObject: model({ ...SPEC }), user: manager });
      expect(upsert.called).to.equal(false);
      await configApi.apply({ configObject: model({ ...SPEC, label: 'UR5' }), user: manager });
      expect(upsert.calledOnce).to.equal(true);
      expect(await coll('models').findOne({ _id: 'ur5e' })).to.include({ label: 'UR5' });
    });

    it('apply: rejects a malformed id', async () => {
      await expect(configApi.apply({ configObject: model(SPEC, 'ur 5e'), user: manager }))
        .to.be.rejectedWith(ValidationError);
    });

    it('list: short is {id,label}; full round-trips', async () => {
      await configApi.apply({ configObject: model(SPEC), user: manager });
      const short = await configApi.list({ kind: KIND_MODEL, user: manager });
      expect(short[0]).to.include({ id: 'ur5e', label: 'UR5e' });
      const [full] = await configApi.list({ kind: KIND_MODEL, user: manager, format: LIST_FORMAT_FULL });
      expect(full.spec).to.deep.equal(SPEC);
      await configApi.apply({ configObject: full, user: manager });
    });

    it('clear: refuses while a robot is assigned the model', async () => {
      await configApi.apply({ configObject: model(SPEC), user: manager });
      await configApi.apply({ configObject: assignment({ model: 'ur5e' }), user: manager });
      await expect(configApi.clear({ configObject: model(), user: manager })).to.be.rejectedWith(ValidationError);

      await configApi.clear({ configObject: assignment(), user: manager });
      await configApi.clear({ configObject: model(), user: manager });
      expect(await coll('models').findOne({ _id: 'ur5e' })).to.equal(null);
    });
  });

  describe('RobotModelAssignment kind', () => {
    it('assigns a model and stores static joint positions', async () => {
      await configApi.apply({
        configObject: assignment({ model: 'ur5e', joints: { shoulder: 0.5 } }), user: manager,
      });
      expect(await coll('assignments').findOne({ _id: 'arm-1' }))
        .to.deep.include({ model: 'ur5e', joints: { shoulder: 0.5 } });
      expect(await coll('joint_states').findOne({ _id: 'arm-1' }))
        .to.deep.include({ names: ['shoulder'], positions: [0.5], ts: 1 });

      const [full] = await configApi.list({ kind: KIND_ASSIGNMENT, user: manager, format: LIST_FORMAT_FULL });
      expect(full.spec).to.deep.equal({ model: 'ur5e', joints: { shoulder: 0.5 } });
      expect((await configApi.list({ kind: KIND_ASSIGNMENT, user: manager }))[0])
        .to.include({ id: 'arm-1', label: 'ur5e' });
    });

    it('clear removes the assignment and its static joints, not live ones', async () => {
      await configApi.apply({
        configObject: assignment({ model: 'ur5e', joints: { shoulder: 0.5 } }), user: manager,
      });
      await configApi.clear({ configObject: assignment(), user: manager });
      expect(await coll('assignments').findOne({ _id: 'arm-1' })).to.equal(null);
      expect(await coll('joint_states').findOne({ _id: 'arm-1' })).to.equal(null);

      // Live joint states are never replaced by static ones, nor cleared
      await coll('joint_states').insertOne({ _id: 'arm-1', names: ['j'], positions: [1], ts: 1000 });
      await configApi.apply({ configObject: assignment({ model: 'ur5e', joints: { j: 0 } }), user: manager });
      expect(await coll('joint_states').findOne({ _id: 'arm-1' })).to.deep.include({ positions: [1], ts: 1000 });
      await configApi.clear({ configObject: assignment(), user: manager });
      expect(await coll('joint_states').findOne({ _id: 'arm-1' })).to.deep.include({ ts: 1000 });
    });

    it('re-apply updates static joints, and removes them when the spec drops them', async () => {
      await configApi.apply({ configObject: assignment({ model: 'ur5e', joints: { j: 0 } }), user: manager });
      await configApi.apply({ configObject: assignment({ model: 'ur5e', joints: { j: 1 } }), user: manager });
      expect(await coll('joint_states').findOne({ _id: 'arm-1' })).to.deep.include({ positions: [1], ts: 1 });
      await configApi.apply({ configObject: assignment({ model: 'ur5e' }), user: manager });
      expect(await coll('joint_states').findOne({ _id: 'arm-1' })).to.equal(null);
      expect(await coll('assignments').findOne({ _id: 'arm-1' })).to.deep.equal({ _id: 'arm-1', model: 'ur5e' });
    });

    it('rejects a spec without a model, non-numeric joints or bad joint names', async () => {
      const bad = [
        {}, { model: 'a b' }, { model: 'ur5e', joints: { j: 'x' } }, { model: 'ur5e', joints: { 'a.b': 1 } },
        { model: 'ur5e', joints: { $set: 1 } }, { model: 'ur5e', joints: { ['x'.repeat(129)]: 1 } },
      ];
      for (const spec of bad) {
        await expect(configApi.apply({ configObject: assignment(spec), user: manager }), JSON.stringify(spec))
          .to.be.rejected;
      }
    });
  });

  describe('publications', () => {
    it('publishes the model only while it is assigned to the robot', async () => {
      const viewer = await createUser({ role: ROLE_VIEWER });
      await configApi.apply({ configObject: model(SPEC), user: manager });
      await configApi.apply({ configObject: model({ urdf: '/b.urdf' }, 'other'), user: manager });
      await configApi.apply({ configObject: assignment({ model: 'ur5e' }), user: manager });
      const run = (name, params) => runPluginPublication(
        `plugin.robotmodel.${name}`, { userId: viewer._id }, { robotId: 'arm-1', ...params },
      );

      const [assigned] = await run('assignment');
      expect((await assigned.fetchAsync())[0]).to.include({ _id: 'arm-1', model: 'ur5e' });
      const [published] = await run('model', { modelId: 'ur5e' });
      expect((await published.fetchAsync())[0]).to.include({ _id: 'ur5e', label: 'UR5e' });
      expect(await run('model', { modelId: 'other' })).to.deep.equal([]);
      expect(await run('model', {})).to.deep.equal([]);
    });

    it('publishes the robot scene and joint states', async () => {
      const viewer = await createUser({ role: ROLE_VIEWER });
      await coll('scenes').insertMany([{ _id: 'arm-1', objects: [] }, { _id: 'arm-2', objects: [] }]);
      await coll('joint_states').insertOne({ _id: 'arm-1', names: ['j'], positions: [1], ts: 5 });
      const run = (name) => runPluginPublication(
        `plugin.robotmodel.${name}`, { userId: viewer._id }, { robotId: 'arm-1' },
      );
      expect((await (await run('scene'))[0].fetchAsync()).map((d) => d._id)).to.deep.equal(['arm-1']);
      expect((await (await run('jointStates'))[0].fetchAsync())[0]).to.include({ ts: 5 });
    });
  });

  describe('jointHistory', () => {
    const T0 = 1_700_000_000_000;
    let rawQuery;
    let userId;
    const call = (params, uid = userId) => runPluginMethod(
      'plugin.robotmodel.jointHistory', { userId: uid }, { robotId: 'arm-1', ...params },
    );

    beforeEach(async () => {
      userId = (await createUser({ role: ROLE_VIEWER }))._id;
      rawQuery = sinon.stub(new TimeSeriesManager(), 'rawQuery');
    });

    it('queries one sanitized field per joint and returns compact rows', async () => {
      rawQuery.resolves([
        { ts: T0, fields: { robotmodel_joint_shoulder: 0.1, robotmodel_joint_arm_elbow: 1 } },
        { ts: T0 + 200, fields: { robotmodel_joint_shoulder: 0.2 } },
      ]);
      const result = await call({ names: ['shoulder', 'arm/elbow'], startTs: T0, endTs: T0 + 1000 });
      expect(rawQuery.firstCall.args[0]).to.deep.include({
        meta: { robotId: 'arm-1', src: 'robotmodel' },
        fields: ['robotmodel_joint_shoulder', 'robotmodel_joint_arm_elbow'],
        startTs: T0,
        endTs: T0 + 1000,
      });
      expect(result).to.deep.equal({
        names: ['shoulder', 'arm/elbow'],
        values: [[T0, 0.1, 1], [T0 + 200, 0.2, null]],
        truncated: false,
      });
    });

    it('rejects anonymous users and bad windows or names', async () => {
      const args = { names: ['a'], startTs: T0, endTs: T0 + 1000 };
      await expect(call(args, null)).to.be.rejectedWith(/Unauthorized/);
      await expect(call({ ...args, endTs: T0 })).to.be.rejectedWith(/window/);
      await expect(call({ ...args, endTs: T0 + 25 * 3600 * 1000 })).to.be.rejectedWith(/window/);
      await expect(call({ ...args, names: [] })).to.be.rejectedWith(/names/);
      await expect(call({ ...args, names: [1] })).to.be.rejectedWith(/names/);
      await expect(call({ ...args, names: ['x'.repeat(129)] })).to.be.rejectedWith(/names/);
      await expect(call({ ...args, names: ['a.b'] })).to.be.rejectedWith(/names/);
      expect(rawQuery.called).to.equal(false);
    });
  });
});
