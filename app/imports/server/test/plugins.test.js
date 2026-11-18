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
 * widget types in dashboards, ConfigAPI kinds and protos.
 */
import { Meteor } from 'meteor/meteor';
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
const setup = async (enabled) => {
  const registry = createPluginRegistryForTests();
  setPluginRegistryForTests(registry);
  loadServerPlugins({ registry, enabled });
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
});
