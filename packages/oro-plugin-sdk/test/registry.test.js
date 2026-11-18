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

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry, definePlugin, PluginError, SDK_VERSION } = require('..');

const PROTO = 'syntax = "proto3";\npackage oro.demo;\nmessage Hello { string text = 1; }\n';

function plugin(overrides = {}) {
  return {
    id: 'demo',
    version: '1.0.0',
    sdkRange: `^${SDK_VERSION}`,
    register() {},
    ...overrides,
  };
}

function throwsPluginError(fn, pattern) {
  assert.throws(fn, (err) => err instanceof PluginError && pattern.test(err.message));
}

test('definePlugin validates and freezes', () => {
  const p = definePlugin(plugin());
  assert.ok(Object.isFrozen(p));
  throwsPluginError(() => definePlugin(plugin({ id: 'Bad-Id' })), /Invalid plugin id/);
  throwsPluginError(() => definePlugin(plugin({ version: '1.0' })), /Invalid version/);
  throwsPluginError(() => definePlugin(plugin({ sdkRange: '>=0.1' })), /Invalid sdkRange/);
  throwsPluginError(() => definePlugin(plugin({ register: null })), /register/);
  throwsPluginError(() => definePlugin(plugin({ start: 1 })), /start/);
});

test('createRegistry rejects unknown runtimes', () => {
  throwsPluginError(() => createRegistry({ runtime: 'browser' }), /Unknown runtime/);
});

test('loads enabled plugins in enabled order, skips the rest, then freezes', () => {
  const calls = [];
  const reg = createRegistry({ runtime: 'server' });
  reg.load({
    plugins: [
      plugin({ id: 'aa', register: () => calls.push('aa') }),
      plugin({ id: 'bb', register: () => calls.push('bb') }),
      plugin({ id: 'cc', register: () => calls.push('cc') }),
    ],
    enabled: ['cc', 'aa'],
  });
  assert.deepEqual(calls, ['cc', 'aa']);
  assert.deepEqual(reg.getPlugins().map((p) => p.id), ['cc', 'aa']);
  assert.equal(reg.isLoaded(), true);
  throwsPluginError(() => reg.load({ plugins: [], enabled: [] }), /already loaded/);
});

test('ctx merges core services with registration functions', () => {
  let seen;
  const reg = createRegistry({ runtime: 'server' });
  reg.load({
    plugins: [plugin({ register: (ctx) => { seen = ctx; } })],
    enabled: ['demo'],
    makeContext: (p) => ({ pluginId: p.id, settings: { a: 1 } }),
  });
  assert.equal(seen.pluginId, 'demo');
  assert.deepEqual(seen.settings, { a: 1 });
  assert.equal(typeof seen.registerConfigKind, 'function');
});

test('rejects unknown, duplicate and twice-enabled plugins', () => {
  throwsPluginError(
    () => createRegistry({ runtime: 'server' }).load({ plugins: [plugin()], enabled: ['nope'] }),
    /not installed.*Installed: demo/
  );
  throwsPluginError(
    () => createRegistry({ runtime: 'server' }).load({ plugins: [plugin(), plugin()], enabled: [] }),
    /Duplicate plugin id/
  );
  throwsPluginError(
    () => createRegistry({ runtime: 'server' }).load({ plugins: [plugin()], enabled: ['demo', 'demo'] }),
    /enabled twice/
  );
});

test('rejects plugins whose sdkRange excludes this SDK', () => {
  throwsPluginError(
    () => createRegistry({ runtime: 'server' }).load({
      plugins: [plugin({ sdkRange: '^99.0.0' })],
      enabled: ['demo'],
    }),
    /Requires oro-plugin-sdk \^99\.0\.0/
  );
});

test('widget types: namespaced, unique, not reserved', () => {
  const load = (register, reserved = []) =>
    createRegistry({ runtime: 'client', reservedWidgetTypes: reserved }).load({
      plugins: [plugin({ register })],
      enabled: ['demo'],
    });
  const factory = () => null;
  throwsPluginError(
    () => load((ctx) => ctx.registerWidget({ type: 'hello', label: 'H', factory })),
    /must be 'demo:<name>'/
  );
  throwsPluginError(
    () => load((ctx) => ctx.registerWidget({ type: 'other:hello', label: 'H', factory })),
    /must be 'demo:<name>'/
  );
  throwsPluginError(
    () => load((ctx) => {
      ctx.registerWidget({ type: 'demo:hello', label: 'H', factory });
      ctx.registerWidget({ type: 'demo:hello', label: 'H', factory });
    }),
    /already registered/
  );
  throwsPluginError(
    () => load((ctx) => ctx.registerWidget({ type: 'demo:hello', label: 'H', factory }), ['demo:hello']),
    /reserved by core/
  );
  throwsPluginError(
    () => load((ctx) => ctx.registerWidget({ type: 'demo:hello', label: 'H' })),
    /factory/
  );
  throwsPluginError(
    () => load((ctx) => ctx.registerWidget({ type: 'demo:hello', factory })),
    /label/
  );
});

test('client widgets are exposed through getters', () => {
  const factory = () => 'rendered';
  const reg = createRegistry({ runtime: 'client' });
  reg.load({
    plugins: [plugin({ register: (ctx) => ctx.registerWidget({ type: 'demo:hello', label: 'Hello', scope: 'robot', factory }) })],
    enabled: ['demo'],
  });
  assert.equal(reg.getWidgetFactories()['demo:hello'], factory);
  assert.deepEqual(reg.getWidgetTypes(), [{ type: 'demo:hello', label: 'Hello', scope: 'robot', pluginId: 'demo' }]);
  assert.ok(Object.isFrozen(reg.getWidgetTypes()));
});

test('server widget types with config converters', () => {
  const reg = createRegistry({ runtime: 'server' });
  const configToSpec = (c) => c;
  reg.load({
    plugins: [plugin({
      register: (ctx) => {
        ctx.registerWidgetType({ type: 'demo:hello', label: 'Hello', configConverter: { configToSpec, configSchema: { text: 'string' } } });
        ctx.registerWidgetType({ type: 'demo:plain', label: 'Plain' });
      },
    })],
    enabled: ['demo'],
  });
  assert.deepEqual(reg.getWidgetTypes().map((w) => w.type), ['demo:hello', 'demo:plain']);
  assert.equal(reg.getWidgetConfigConverters()['demo:hello'].configToSpec, configToSpec);
  assert.equal(reg.getWidgetConfigConverters()['demo:plain'], undefined);

  throwsPluginError(
    () => createRegistry({ runtime: 'server' }).load({
      plugins: [plugin({ register: (ctx) => ctx.registerWidgetType({ type: 'demo:x', label: 'X', configConverter: { configToSpec: 1 } }) })],
      enabled: ['demo'],
    }),
    /configToSpec/
  );
});

test('config kinds: format, reserved, duplicates across plugins', () => {
  const createHandler = () => ({});
  const reg = createRegistry({ runtime: 'server', reservedKinds: () => ['Robot'] });
  reg.load({
    plugins: [plugin({ register: (ctx) => ctx.registerConfigKind({ kind: 'DemoNote', createHandler }) })],
    enabled: ['demo'],
  });
  assert.equal(reg.getConfigKinds().DemoNote, createHandler);

  const load = (plugins, enabled) =>
    createRegistry({ runtime: 'server', reservedKinds: () => ['Robot'] }).load({ plugins, enabled });
  throwsPluginError(
    () => load([plugin({ register: (ctx) => ctx.registerConfigKind({ kind: 'robot', createHandler }) })], ['demo']),
    /Invalid config kind/
  );
  throwsPluginError(
    () => load([plugin({ register: (ctx) => ctx.registerConfigKind({ kind: 'Robot', createHandler }) })], ['demo']),
    /reserved by core/
  );
  throwsPluginError(
    () => load(
      [
        plugin({ id: 'aa', register: (ctx) => ctx.registerConfigKind({ kind: 'Shared', createHandler }) }),
        plugin({ id: 'bb', register: (ctx) => ctx.registerConfigKind({ kind: 'Shared', createHandler }) }),
      ],
      ['aa', 'bb']
    ),
    /already registered by plugin aa/
  );
});

test('protos must use the plugin package and no imports', () => {
  const load = (source) =>
    createRegistry({ runtime: 'ingest' }).load({
      plugins: [plugin({ register: (ctx) => ctx.registerProto({ name: 'demo.proto', source }) })],
      enabled: ['demo'],
    });
  const reg = createRegistry({ runtime: 'ingest' });
  reg.load({
    plugins: [plugin({ register: (ctx) => ctx.registerProto({ name: 'demo.proto', source: PROTO }) })],
    enabled: ['demo'],
  });
  assert.deepEqual(reg.getProtos(), [{ pluginId: 'demo', name: 'demo.proto', source: PROTO }]);

  throwsPluginError(() => load(PROTO.replace('oro.demo', 'oro')), /package oro\.demo/);
  throwsPluginError(() => load(PROTO.replace('oro.demo', 'oro.other')), /package oro\.demo/);
  throwsPluginError(() => load(`import "oro.proto";\n${PROTO}`), /import/);
});

test('registration functions are runtime specific', () => {
  const tryIn = (runtime, register) =>
    createRegistry({ runtime }).load({ plugins: [plugin({ register })], enabled: ['demo'] });
  throwsPluginError(
    () => tryIn('ingest', (ctx) => ctx.registerWidget({ type: 'demo:a', label: 'A', factory() {} })),
    /not available in the ingest runtime/
  );
  throwsPluginError(
    () => tryIn('client', (ctx) => ctx.registerConfigKind({ kind: 'Demo', createHandler() {} })),
    /not available in the client runtime/
  );
  throwsPluginError(
    () => tryIn('server', (ctx) => ctx.registerWidget({ type: 'demo:a', label: 'A', factory() {} })),
    /not available in the server runtime/
  );
});

test('registering after load (e.g. from start) throws', async () => {
  let saved;
  const reg = createRegistry({ runtime: 'ingest' });
  reg.load({
    plugins: [plugin({
      register: (ctx) => { saved = ctx; },
      start: async () => saved.registerProto({ name: 'late.proto', source: PROTO }),
    })],
    enabled: ['demo'],
  });
  await assert.rejects(reg.start(), /registration closed/);
});

test('reading the registry before a non-empty load trips the load-order guard', () => {
  const reg = createRegistry({ runtime: 'client' });
  assert.deepEqual(reg.getWidgetFactories(), {});
  throwsPluginError(() => reg.load({ plugins: [plugin()], enabled: ['demo'] }), /read before plugins were loaded/);

  const empty = createRegistry({ runtime: 'client' });
  empty.getWidgetTypes();
  empty.load({ plugins: [plugin()], enabled: [] });
  assert.equal(empty.isLoaded(), true);
});

test('start runs hooks sequentially, in load order, once', async () => {
  const order = [];
  const reg = createRegistry({ runtime: 'ingest' });
  await assert.rejects(reg.start(), /before load/);
  reg.load({
    plugins: [
      plugin({ id: 'aa', start: async (ctx) => { await new Promise((r) => setTimeout(r, 10)); order.push(`aa:${ctx.tag}`); } }),
      plugin({ id: 'bb' }),
      plugin({ id: 'cc', start: async (ctx) => order.push(`cc:${ctx.tag}`) }),
    ],
    enabled: ['aa', 'bb', 'cc'],
  });
  await reg.start((p) => ({ tag: p.id }));
  assert.deepEqual(order, ['aa:aa', 'cc:cc']);
  await assert.rejects(reg.start(), /already started/);
});
