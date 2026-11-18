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
 * Unit tests for ingest plugin loading (src/plugins), using oro-plugin-example.
 */
import mongoUnit from 'mongo-unit';
import { expect } from 'chai';
import { loadSync, parse } from 'protobufjs';
// ORO modules
import MongoManager from '../src/mongo';
import { loadIngestPlugins, startIngestPlugins } from '../src/plugins';

const settingsWith = (enabled) => ({ plugins: { enabled, config: {} } });

// MQTT stand-in with its own proto root, capturing listeners
const makeMqtt = () => {
  const root = loadSync('src/shared/oro.proto');
  const listeners = {};
  return {
    root,
    listeners,
    addProtoSource: (source) => parse(source, root),
    registerListener: (subtopic, cb) => { listeners[subtopic] = cb; },
    registerSystemListener: () => {},
    publish: async () => {},
    lookupType: (name) => root.lookupType(name),
  };
};

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
});
