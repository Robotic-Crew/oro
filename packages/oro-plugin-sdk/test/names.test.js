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
const {
  PluginError,
  pluginCollectionName,
  pluginEndpointName,
  pluginFieldPrefix,
} = require('..');

test('pluginCollectionName', () => {
  assert.equal(pluginCollectionName('demo', 'joint_states'), 'plugin_demo_joint_states');
  assert.throws(() => pluginCollectionName('demo', 'Bad'), PluginError);
  assert.throws(() => pluginCollectionName('demo', ''), PluginError);
  assert.throws(() => pluginCollectionName('Demo', 'x'), PluginError);
});

test('pluginEndpointName', () => {
  assert.equal(pluginEndpointName('demo', 'jointHistory'), 'plugin.demo.jointHistory');
  assert.throws(() => pluginEndpointName('demo', 'a.b'), PluginError);
  assert.throws(() => pluginEndpointName('demo', 'Upper'), PluginError);
});

test('pluginFieldPrefix', () => {
  assert.equal(pluginFieldPrefix('robotmodel'), 'robotmodel_');
  assert.throws(() => pluginFieldPrefix('x'), PluginError);
});
