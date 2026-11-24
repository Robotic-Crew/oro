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
 * Server side of oro-plugin-intrinsic: widget types, publications, the
 * perception image method and indexes.
 */
import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import chai from 'chai';
// ORO modules
import { resetDatabase } from '../setup';
import { createUser } from '../configAPI';
import OroRoles, { ROLE_VIEWER } from '../../roles';
import {
  createPluginRegistryForTests, setPluginRegistryForTests, getPluginRegistry,
} from '../../../lib/plugins/registry';
import { loadServerPlugins } from '../../plugins';
import { runPluginPublication, runPluginMethod } from '../../plugins/endpoints';

if (!Meteor.isTest) throw new Error('This is TEST code only');
const { expect } = chai;

const coll = (name) => MongoInternals.defaultRemoteCollectionDriver().mongo.db
  .collection(`plugin_intrinsic_${name}`);

describe('oro-plugin-intrinsic (server)', () => {
  let viewer;
  const run = (name, params = {}) => runPluginPublication(
    `plugin.intrinsic.${name}`, { userId: viewer._id }, { robotId: 'cell-1', ...params },
  );
  const fetch = async (name, params) => {
    const cursors = await run(name, params);
    expect(cursors).to.have.length(1);
    return cursors[0].fetchAsync();
  };

  const call = (name, params = {}) => runPluginMethod(
    `plugin.intrinsic.${name}`, { userId: viewer._id }, { robotId: 'cell-1', ...params },
  );

  beforeEach(async () => {
    await resetDatabase();
    await new OroRoles().createDefaultRoles();
    const registry = createPluginRegistryForTests();
    setPluginRegistryForTests(registry);
    loadServerPlugins({ registry, enabled: ['intrinsic'] });
    viewer = await createUser({ role: ROLE_VIEWER });
  });

  afterEach(() => setPluginRegistryForTests(undefined));

  after(resetDatabase);

  it('registers its widget types', () => {
    expect(getPluginRegistry().getWidgetTypes().map((w) => w.type)).to.deep.equal([
      'intrinsic:execution', 'intrinsic:cycleTimeline', 'intrinsic:perception',
    ]);
  });

  it('publishes the latest execution, without runningSince', async () => {
    await coll('executions').insertMany([
      { _id: 'cell-1', status: 'running', runningSince: [{ nodeId: 'a', ts: 1 }] },
      { _id: 'cell-2', status: 'idle' },
    ]);
    expect(await fetch('execution')).to.deep.equal([{ _id: 'cell-1', status: 'running' }]);
  });

  it('publishes the latest steps of the robot, newest first, capped', async () => {
    const createdAt = new Date();
    await coll('execution_steps').insertMany([
      ...Array.from({ length: 510 }, (_, i) => ({ robotId: 'cell-1', endTs: i, createdAt })),
      { robotId: 'cell-2', endTs: 9999, createdAt },
    ]);
    const steps = await fetch('steps', { limit: 3 });
    expect(steps.map((s) => s.endTs)).to.deep.equal([509, 508, 507]);
    expect(steps[0]).to.not.have.property('createdAt');
    expect(await fetch('steps', { limit: 10000 })).to.have.length(500);
    expect(await fetch('steps')).to.have.length(500);
  });

  it('publishes the latest perception results, capped at 20', async () => {
    await coll('perception_results').insertMany(
      Array.from({ length: 25 }, (_, i) => ({ robotId: 'cell-1', ts: i, createdAt: new Date() })),
    );
    const results = await fetch('perception', { limit: 50 });
    expect(results).to.have.length(20);
    expect(results[0].ts).to.equal(24);
    expect((await fetch('perception', { limit: 2 })).map((r) => r.ts)).to.deep.equal([24, 23]);
  });

  it('publishes perception results without their image data', async () => {
    const createdAt = new Date();
    await coll('perception_results').insertMany([
      { _id: 'r1', robotId: 'cell-1', ts: 1, createdAt, image: { mime: 'image/png', size: 3, data: 'AAAA' } },
      { _id: 'r2', robotId: 'cell-1', ts: 2, createdAt, image: null },
    ]);
    const results = await fetch('perception');
    expect(results.map((r) => r._id)).to.deep.equal(['r2', 'r1']);
    expect(results[1].image).to.deep.equal({ mime: 'image/png', size: 3 });
  });

  it('publishes the latest perception results by arrival time', async () => {
    await coll('perception_results').insertMany([
      { _id: 'old', robotId: 'cell-1', ts: 9999, createdAt: new Date(1000) },
      { _id: 'new', robotId: 'cell-1', ts: 1, createdAt: new Date(2000) },
    ]);
    expect((await fetch('perception', { limit: 1 })).map((r) => r._id)).to.deep.equal(['new']);
  });

  it('returns the image of a perception result of the robot', async () => {
    await coll('perception_results').insertMany([
      { _id: 'r1', robotId: 'cell-1', ts: 1, image: { mime: 'image/png', size: 3, data: 'AAAA' } },
      { _id: 'r2', robotId: 'cell-1', ts: 2, image: null },
      { _id: 'r3', robotId: 'cell-2', ts: 3, image: { mime: 'image/png', size: 3, data: 'BBBB' } },
    ]);
    expect(await call('perceptionImage', { resultId: 'r1' })).to.deep.equal({ mime: 'image/png', data: 'AAAA' });
    expect(await call('perceptionImage', { resultId: 'r2' })).to.equal(null);
    expect(await call('perceptionImage', { resultId: 'missing' })).to.equal(null);
    // Another robot's result, asked through a robot the user can view
    expect(await call('perceptionImage', { resultId: 'r3' })).to.equal(null);
  });

  it('rejects malformed perception result ids', async () => {
    for (const resultId of [undefined, 42, '', { $ne: null }, 'a'.repeat(65), 'r1"; x']) {
      let error;
      try {
        await call('perceptionImage', { resultId });
      } catch (err) {
        error = err;
      }
      expect(error, String(resultId)).to.have.property('error', 'wrong-parameter');
    }
  });

  it('denies the perception image to anonymous users', async () => {
    await expect(runPluginMethod(
      'plugin.intrinsic.perceptionImage', { userId: null }, { robotId: 'cell-1', resultId: 'r1' },
    )).to.be.rejectedWith(/Unauthorized/);
  });

  it('creates its indexes on start, with TTLs', async () => {
    await getPluginRegistry().start(() => ({ log: { info() {}, warn() {}, error() {} } }));
    const steps = await coll('execution_steps').indexes();
    expect(steps.map((ix) => ix.key)).to.deep.include({ robotId: 1, endTs: -1 });
    expect(steps.find((ix) => ix.key.createdAt === 1).expireAfterSeconds).to.equal(14 * 24 * 3600);
    const perception = await coll('perception_results').indexes();
    expect(perception.map((ix) => ix.key)).to.deep.include({ robotId: 1, createdAt: -1 });
    expect(perception.find((ix) => ix.key.createdAt === 1 && !ix.key.robotId).expireAfterSeconds)
      .to.equal(14 * 24 * 3600);
  });

  it('publishes nothing to anonymous users', async () => {
    expect(await runPluginPublication('plugin.intrinsic.execution', { userId: null }, { robotId: 'cell-1' }))
      .to.deep.equal([]);
  });
});
