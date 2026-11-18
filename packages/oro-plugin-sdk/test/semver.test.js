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
const { satisfies } = require('..');

test('exact versions', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
});

test('caret on >=1.0.0 allows minor and patch bumps', () => {
  assert.equal(satisfies('1.9.0', '^1.2.3'), true);
  assert.equal(satisfies('1.2.2', '^1.2.3'), false);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
});

test('caret on 0.x pins the minor, on 0.0.x pins the patch', () => {
  assert.equal(satisfies('0.1.5', '^0.1.0'), true);
  assert.equal(satisfies('0.2.0', '^0.1.0'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
});

test('tilde allows patch bumps only', () => {
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
});

test('star matches anything valid; garbage matches nothing', () => {
  assert.equal(satisfies('3.4.5', '*'), true);
  assert.equal(satisfies('1.2', '*'), false);
  assert.equal(satisfies('1.2.3', '>=1.0.0'), false);
  assert.equal(satisfies('1.2.3', undefined), false);
});
