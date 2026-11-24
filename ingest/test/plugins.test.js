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
 * Unit tests for ingest plugin loading (src/plugins), using oro-plugin-example
 * and inline plugins.
 */
import mongoUnit from 'mongo-unit';
import { expect } from 'chai';
import { definePlugin, SDK_VERSION } from 'oro-plugin-sdk';
// ORO modules
import MongoManager from '../src/mongo';
import { loadIngestPlugins, startIngestPlugins } from '../src/plugins';
import TimeSeriesStore from '../src/shared/timeseriesStore';
import { COLLECTIONS } from '../src/shared/constants';
import makeMqtt from './mocks/pluginMqtt';

const settingsWith = (enabled) => ({ plugins: { enabled, config: {} } });

describe('Ingest plugins', () => {
  beforeEach(async () => {
    await mongoUnit.drop();
  });

  it('loads the example plugin, which stores Hello messages in its collection', async () => {
    const mqtt = makeMqtt();
    const settings = settingsWith(['example']);
    const registry = loadIngestPlugins({ settings, addProtoSource: mqtt.addProtoSource });
    expect(registry.getPlugins().map((p) => p.id)).to.deep.equal(['example']);

    const mongo = new MongoManager();
    await startIngestPlugins(registry, { mqtt, mongo, settings });
    expect(mqtt.listeners).to.have.property('example/hello');

    const Hello = mqtt.lookupType('oro.example.Hello');
    const msg = Hello.encode({ text: 'hi', ts: 1712870181770 }).finish();
    await mqtt.listeners['example/hello']('r1', msg);

    const doc = await mongo.getCollection('plugin_example_hello').findOne({ _id: 'r1' });
    expect(doc).to.include({ text: 'hi', ts: 1712870181770 });
  });

  it('registers nothing when no plugin is enabled', async () => {
    const mqtt = makeMqtt();
    const settings = settingsWith([]);
    const registry = loadIngestPlugins({ settings, addProtoSource: mqtt.addProtoSource });
    await startIngestPlugins(registry, { mqtt, mongo: new MongoManager(), settings });
    expect(registry.getPlugins()).to.be.empty;
    expect(mqtt.listeners).to.be.empty;
    expect(() => mqtt.lookupType('oro.example.Hello')).to.throw();
  });

  it('fails on an enabled plugin that is not installed', () => {
    const mqtt = makeMqtt();
    expect(() => loadIngestPlugins({
      settings: settingsWith(['nope']),
      addProtoSource: mqtt.addProtoSource,
    })).to.throw(/plugin:nope.*not installed/);
  });

  it('lets plugins write their own time series fields only', async () => {
    let ctx;
    const plugin = definePlugin({
      id: 'demo',
      version: '1.0.0',
      sdkRange: `^${SDK_VERSION}`,
      register() {},
      async start(startCtx) { ctx = startCtx; },
    });
    const mqtt = makeMqtt();
    const settings = settingsWith(['demo']);
    const registry = loadIngestPlugins({ settings, plugins: [plugin], addProtoSource: mqtt.addProtoSource });
    const mongo = new MongoManager();
    const runtime = await startIngestPlugins(registry, { mqtt, mongo, settings });

    const ts = Date.now() - 1000;
    await ctx.timeseries.write({ robotId: 'r1', ts, fields: { demo_a: 1, demo_b: 2 } });
    // Far-future robot clocks are stamped now
    await ctx.timeseries.write({ robotId: 'r1', ts: Date.now() + 3600e3, fields: { demo_a: 3 } });
    await runtime.flushTimeseries();
    const store = new TimeSeriesStore({ db: mongo.db, collectionName: COLLECTIONS.TIMESERIES });
    const rows = await store.rawQuery({ meta: { robotId: 'r1', src: 'demo' }, fields: ['demo_a', 'demo_b'] });
    expect(rows[0]).to.deep.equal({ ts, fields: { demo_a: 1, demo_b: 2 } });
    expect(rows).to.have.length(2);
    expect(rows[1].ts).to.be.at.most(Date.now());
    // Core queries (no src) don't see plugin points
    expect(await store.rawQuery({ meta: { robotId: 'r1' }, fields: ['demo_a'] })).to.be.empty;
    await runtime.stop();

    for (const fields of [{ batteryPercentage: 1 }, { 'demo_a.b': 1 }, {}]) {
      let error;
      try {
        await ctx.timeseries.write({ robotId: 'r1', ts, fields });
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(fields)).to.match(/start with 'demo_'/);
    }
    expect(ctx.db.collection('things').collectionName).to.equal('plugin_demo_things');
  });

  describe('MQTT listeners', () => {
    const startDemo = async ({ coreSubtopics = [] } = {}) => {
      let ctx;
      const plugin = definePlugin({
        id: 'demo',
        version: '1.0.0',
        sdkRange: `^${SDK_VERSION}`,
        register() {},
        async start(startCtx) { ctx = startCtx; },
      });
      const mqtt = makeMqtt({ coreSubtopics });
      const settings = settingsWith(['demo']);
      const registry = loadIngestPlugins({ settings, plugins: [plugin], addProtoSource: mqtt.addProtoSource });
      const runtime = await startIngestPlugins(registry, { mqtt, mongo: new MongoManager(), settings });
      await runtime.stop();
      return { ctx, mqtt };
    };

    it('only exposes listeners and type lookup', async () => {
      const { ctx } = await startDemo();
      expect(Object.keys(ctx.mqtt).sort()).to.deep.equal(['lookupType', 'registerListener']);
    });

    it('refuses core and system subtopics, allows others', async () => {
      const { ctx, mqtt } = await startDemo({ coreSubtopics: ['ros/odom'] });
      expect(() => ctx.mqtt.registerListener('ros/odom', () => {})).to.throw(/belongs to core/);
      expect(() => ctx.mqtt.registerListener('system/x', () => {})).to.throw(/invalid subtopic/);
      expect(() => ctx.mqtt.registerListener('demo/#', () => {})).to.throw(/invalid subtopic/);
      expect(() => ctx.mqtt.registerListener('demo/a', () => {}, { maxBytes: 0 })).to.throw(/maxBytes/);
      ctx.mqtt.registerListener('demo/a', () => {});
      ctx.mqtt.registerListener('ros/joint_states', () => {});
      expect(mqtt.listeners).to.have.keys('demo/a', 'ros/joint_states');
    });

    it('drops oversized messages and contains listener errors', async () => {
      const { ctx, mqtt } = await startDemo();
      const seen = [];
      ctx.mqtt.registerListener('demo/a', (robotId, msg) => { seen.push(msg.length); }, { maxBytes: 4 });
      ctx.mqtt.registerListener('demo/b', () => { throw new Error('boom'); });
      await mqtt.listeners['demo/a']('r1', Buffer.alloc(4));
      await mqtt.listeners['demo/a']('r1', Buffer.alloc(5));
      expect(seen).to.deep.equal([4]);
      await mqtt.listeners['demo/b']('r1', Buffer.alloc(1)); // doesn't throw
    });
  });
});
