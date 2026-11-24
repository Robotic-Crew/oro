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
 * Server-side plugin extension points, exercised with oro-plugin-example:
 * widget types in dashboards, ConfigAPI kinds and protos. Endpoints and time
 * series access use an inline plugin.
 */
import { Meteor } from 'meteor/meteor';
import { Mongo, MongoInternals } from 'meteor/mongo';
import sinon from 'sinon';
import { definePlugin, SDK_VERSION } from 'oro-plugin-sdk';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
// ORO modules
import { resetDatabase } from './setup';
import { createUser } from './configAPI';
import ConfigAPI from '../configAPI/configAPI';
import OroRoles, { ROLE_ADMIN, ROLE_VIEWER } from '../roles';
import OroMqtt from '../mqtt';
import DashboardsManager from '../dashboards';
import {
  AuthorizationError, KIND_DASHBOARD_DEFINITION, LIST_FORMAT_FULL, SchemaError, ValidationError,
} from '../../shared/configAPI';
import {
  createPluginRegistryForTests, setPluginRegistryForTests,
} from '../../lib/plugins/registry';
import { loadServerPlugins } from '../plugins';
import { runPluginMethod, runPluginPublication } from '../plugins/endpoints';
import TimeSeriesManager from '../timeseries';

if (!Meteor.isTest) {
  throw new Error('This is TEST code only');
}
const { expect } = chai;
chai.use(chaiAsPromised);

const KIND_NOTE = 'ExampleNote';

const dashboardWith = (widget) => ({
  kind: KIND_DASHBOARD_DEFINITION,
  apiVersion: 'v0.1',
  metadata: { id: 'plugindash' },
  spec: {
    label: 'Plugin dashboard',
    sections: [{ label: 'Robot', scope: 'robot', widgets: [widget] }],
  },
});

const noteObject = (id, text) => ({
  kind: KIND_NOTE,
  apiVersion: 'v0.1',
  metadata: { id },
  spec: { text },
});

// Loads the given plugins into a fresh registry and returns a ConfigAPI that sees them
const setup = async (enabled, plugins) => {
  const registry = createPluginRegistryForTests();
  setPluginRegistryForTests(registry);
  loadServerPlugins({ registry, enabled, ...(plugins ? { plugins } : {}) });
  return new ConfigAPI().init({});
};

describe('plugins (server)', () => {
  beforeEach(async () => {
    await resetDatabase();
    await new OroRoles().createDefaultRoles();
  });

  afterEach(() => {
    // Next getPluginRegistry() builds an empty one again
    setPluginRegistryForTests(undefined);
  });

  describe('widget types', () => {
    it('accepts and round-trips a plugin widget in a dashboard', async () => {
      const configApi = await setup(['example']);
      const user = await createUser({ role: ROLE_ADMIN });
      const widget = { type: 'example:hello', label: 'Hello', config: { text: 'hi there' } };
      await configApi.apply({ configObject: dashboardWith(widget), user });

      const doc = (await new DashboardsManager().listDashboards())
        .find((d) => d._id === 'plugindash');
      expect(doc.sections[0].widgets[0]).to.include({ type: 'example:hello' });
      expect(doc.sections[0].widgets[0].config).to.deep.equal({ text: 'hi there' });

      const [listed] = await configApi.list({
        kind: KIND_DASHBOARD_DEFINITION, id: 'plugindash', user, format: LIST_FORMAT_FULL,
      });
      expect(listed.spec.sections[0].widgets[0]).to.deep.include(widget);
    });

    it('validates plugin widget config with the plugin schema', async () => {
      const configApi = await setup(['example']);
      const user = await createUser({ role: ROLE_ADMIN });
      await expect(configApi.apply({
        configObject: dashboardWith({ type: 'example:hello', label: 'Hello', config: { text: '' } }),
        user,
      })).to.be.rejectedWith(SchemaError);
      await expect(configApi.apply({
        configObject: dashboardWith({
          type: 'example:hello', label: 'Hello', config: { text: 'x', extra: 1 },
        }),
        user,
      })).to.be.rejectedWith(SchemaError);
    });

    it('rejects widget types no plugin registered', async () => {
      const configApi = await setup(['example']);
      const user = await createUser({ role: ROLE_ADMIN });
      await expect(configApi.apply({
        configObject: dashboardWith({ type: 'foo:bar', label: 'Nope' }),
        user,
      })).to.be.rejectedWith(SchemaError);
    });

    it('rejects plugin widget types when the plugin is not enabled', async () => {
      const configApi = await setup([]);
      const user = await createUser({ role: ROLE_ADMIN });
      await expect(configApi.apply({
        configObject: dashboardWith({ type: 'example:hello', label: 'Hello' }),
        user,
      })).to.be.rejectedWith(SchemaError);
    });
  });

  describe('config kinds', () => {
    it('applies, lists and clears a plugin kind', async () => {
      const configApi = await setup(['example']);
      const user = await createUser({ role: ROLE_ADMIN });
      await configApi.apply({ configObject: noteObject('n1', 'first note'), user });
      await configApi.apply({ configObject: noteObject('n2', 'second note'), user });

      const full = await configApi.list({ kind: KIND_NOTE, user, format: LIST_FORMAT_FULL });
      expect(full.map((o) => o.spec.text).sort()).to.deep.equal(['first note', 'second note']);

      await configApi.clear({ configObject: noteObject('n1'), user });
      const short = await configApi.list({ kind: KIND_NOTE, user });
      expect(short).to.have.length(1);
      expect(short[0]).to.include({ id: 'n2', label: 'second note' });
    });

    it('enforces the plugin authorization check', async () => {
      const configApi = await setup(['example']);
      const user = await createUser({ role: ROLE_VIEWER });
      await expect(configApi.apply({ configObject: noteObject('n1', 'note'), user }))
        .to.be.rejectedWith(AuthorizationError);
    });

    it('core enforces the kind access policy even if the handler does not', async () => {
      const calls = [];
      const lax = definePlugin({
        id: 'lax',
        version: '1.0.0',
        sdkRange: `^${SDK_VERSION}`,
        register(ctx) {
          ctx.registerConfigKind({
            kind: 'LaxThing',
            access: 'fleet.configure',
            createHandler: () => ({
              isGlobalConfig: () => false,
              list: async () => { calls.push('list'); return []; },
              apply: async () => { calls.push('apply'); },
              clear: async () => { calls.push('clear'); },
            }),
          });
        },
      });
      const configApi = await setup(['lax'], [lax]);
      const viewer = await createUser({ role: ROLE_VIEWER });
      const admin = await createUser({ id: 'admin1', role: ROLE_ADMIN });
      const obj = { kind: 'LaxThing', apiVersion: 'v0.1', metadata: { id: 't1' }, spec: {} };
      await expect(configApi.apply({ configObject: obj, user: viewer })).to.be.rejectedWith(AuthorizationError);
      await expect(configApi.list({ kind: 'LaxThing', user: viewer })).to.be.rejectedWith(AuthorizationError);
      expect(calls).to.deep.equal([]);
      await configApi.apply({ configObject: obj, user: admin });
      expect(calls).to.deep.equal(['apply']);
    });

    it('does not know plugin kinds when the plugin is not enabled', async () => {
      const configApi = await setup([]);
      const user = await createUser({ role: ROLE_ADMIN });
      await expect(configApi.apply({ configObject: noteObject('n1', 'note'), user }))
        .to.be.rejectedWith(ValidationError, /Unsupported object kind/);
    });
  });

  describe('protos', () => {
    it('makes plugin messages available to OroMqtt', async () => {
      await setup(['example']);
      const Hello = new OroMqtt().lookupType('oro.example.Hello');
      const decoded = Hello.decode(Hello.encode({ text: 'hi', ts: 42 }).finish());
      expect(decoded.text).to.equal('hi');
      expect(Number(decoded.ts)).to.equal(42);
    });
  });
  describe('example publication', () => {
    it('publishes the last Hello of a robot the user can view', async () => {
      await setup(['example']);
      const user = await createUser({ role: ROLE_VIEWER });
      const hello = MongoInternals.defaultRemoteCollectionDriver().mongo.db
        .collection('plugin_example_hello');
      await hello.insertMany([{ _id: 'r1', text: 'hi' }, { _id: 'r2', text: 'other' }]);
      const [cursor] = await runPluginPublication(
        'plugin.example.lastHello', { userId: user._id }, { robotId: 'r1' },
      );
      expect(await cursor.fetchAsync()).to.deep.equal([{ _id: 'r1', text: 'hi' }]);
    });
  });

  describe('endpoints', () => {
    const ROBOT = 'robot-1';
    const OTHER_ROBOT = 'robot-2';
    const foreign = new Mongo.Collection(null);
    let items;
    let fail;

    const demoPlugin = definePlugin({
      id: 'demo',
      version: '1.0.0',
      sdkRange: `^${SDK_VERSION}`,
      register(ctx) {
        items = ctx.createCollection('items');
        ctx.registerPublication({
          name: 'items',
          access: 'robot.view',
          handler: async ({ robotId }) => items.find({ robotId }),
        });
        ctx.registerPublication({
          name: 'leak',
          access: 'robot.view',
          handler: async () => foreign.find({}),
        });
        ctx.registerMethod({
          name: 'echo',
          access: 'robot.view',
          handler: async ({ userId, robotId, params }) => {
            if (fail) throw fail;
            return { userId, robotId, n: params.n };
          },
        });
        ctx.registerMethod({
          name: 'history',
          access: 'robot.view',
          handler: async ({ robotId, params }) => ctx.timeseries.rawQuery({
            robotId, fields: params.fields, limit: params.limit, startTs: params.startTs, endTs: params.endTs,
          }),
        });
      },
    });

    const load = () => {
      const registry = createPluginRegistryForTests();
      setPluginRegistryForTests(registry);
      loadServerPlugins({ registry, plugins: [demoPlugin], enabled: ['demo'] });
    };

    let rawQuery;
    beforeEach(async () => {
      fail = undefined;
      load();
      await items.insertAsync({ robotId: ROBOT, v: 1 });
      await items.insertAsync({ robotId: OTHER_ROBOT, v: 2 });
      rawQuery = sinon.stub(new TimeSeriesManager(), 'rawQuery').resolves([]);
    });

    afterEach(() => sinon.restore());

    it('runs methods for users who can view the robot', async () => {
      const user = await createUser({ role: ROLE_VIEWER });
      expect(await runPluginMethod('plugin.demo.echo', { userId: user._id }, { robotId: ROBOT, n: 3 }))
        .to.deep.equal({ userId: user._id, robotId: ROBOT, n: 3 });
    });

    it('rejects anonymous users, users without access and bad params', async () => {
      const viewer = await createUser({ role: ROLE_VIEWER });
      const nobody = await createUser({ id: 'nobody', role: null });
      const call = (userId, params) => runPluginMethod('plugin.demo.echo', { userId }, params);
      await expect(call(null, { robotId: ROBOT })).to.be.rejectedWith(/Unauthorized/);
      await expect(call(nobody._id, { robotId: ROBOT })).to.be.rejectedWith(/Unauthorized/);
      await expect(call(viewer._id, 'robot-1')).to.be.rejectedWith(/Unauthorized/);
      await expect(call(viewer._id, { robotId: 7 })).to.be.rejectedWith(/Unauthorized/);
      await expect(call(viewer._id, { robotId: 'a/b' })).to.be.rejectedWith(/Unauthorized/);
      await expect(call(viewer._id, { robotId: '' })).to.be.rejectedWith(/Unauthorized/);
      await expect(runPluginMethod('plugin.demo.nope', { userId: viewer._id }, { robotId: ROBOT }))
        .to.be.rejectedWith(/Unauthorized/);
    });

    it('maps plugin errors to Meteor errors', async () => {
      const user = await createUser({ role: ROLE_VIEWER });
      const call = () => runPluginMethod('plugin.demo.echo', { userId: user._id }, { robotId: ROBOT });
      fail = new ValidationError('bad n');
      await expect(call()).to.be.rejectedWith(Meteor.Error, /wrong-parameter/);
      fail = new AuthorizationError('no');
      await expect(call()).to.be.rejectedWith(Meteor.Error, /Unauthorized/);
      fail = new Error('boom');
      sinon.stub(console, 'error');
      await expect(call()).to.be.rejectedWith(Meteor.Error, /internal-error/);
    });

    it('publishes only authorized cursors of the plugin collections', async () => {
      const user = await createUser({ role: ROLE_VIEWER });
      const nobody = await createUser({ id: 'nobody', role: null });
      const [cursor] = await runPluginPublication('plugin.demo.items', { userId: user._id }, { robotId: ROBOT });
      expect((await cursor.fetchAsync()).map((d) => d.v)).to.deep.equal([1]);
      expect(await runPluginPublication('plugin.demo.items', { userId: nobody._id }, { robotId: ROBOT }))
        .to.deep.equal([]);
      sinon.stub(console, 'error');
      expect(await runPluginPublication('plugin.demo.leak', { userId: user._id }, { robotId: ROBOT }))
        .to.deep.equal([]);
    });

    it('reloading plugins does not redefine Meteor endpoints', () => {
      expect(() => load()).not.to.throw();
      expect(Meteor.server.method_handlers['plugin.demo.echo']).to.be.a('function');
      expect(Meteor.server.publish_handlers['plugin.demo.items']).to.be.a('function');
    });

    it('limits time series reads to the plugin fields, range and limit', async () => {
      const user = await createUser({ role: ROLE_VIEWER });
      const endTs = Date.now();
      const startTs = endTs - 3600e3;
      const call = (params) => runPluginMethod(
        'plugin.demo.history', { userId: user._id }, { robotId: ROBOT, startTs, endTs, ...params },
      );
      await call({ fields: ['demo_a'], limit: 1e9 });
      expect(rawQuery.firstCall.args[0]).to.deep.include({
        meta: { robotId: ROBOT, src: 'demo' }, fields: ['demo_a'], limit: 20000, startTs, endTs,
      });
      await expect(call({ fields: ['demo_a'], startTs: undefined })).to.be.rejectedWith(/wrong-parameter/);
      await expect(call({ fields: ['demo_a'], startTs: endTs })).to.be.rejectedWith(/wrong-parameter/);
      await expect(call({ fields: ['demo_a'], startTs: endTs - 25 * 3600e3 }))
        .to.be.rejectedWith(/wrong-parameter/);
      await expect(call({ fields: ['batteryPercentage'] })).to.be.rejectedWith(/wrong-parameter/);
      await expect(call({ fields: ['demo_a.b'] })).to.be.rejectedWith(/wrong-parameter/);
      await expect(call({ fields: [] })).to.be.rejectedWith(/wrong-parameter/);
    });
  });
});
