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
 * Constants shared by every runtime entry of the example plugin.
 * CommonJS on purpose: ingest loads it with plain Node.
 */
const { version } = require('../package.json');

exports.PLUGIN_ID = 'example';
exports.VERSION = version;
exports.SDK_RANGE = '^0.3.0';

exports.WIDGET_HELLO = 'example:hello';
exports.KIND_NOTE = 'ExampleNote';
exports.HELLO_SUBTOPIC = 'example/hello';
exports.HELLO_TYPE = 'oro.example.Hello';
exports.PROTO_NAME = 'example.proto';

// Collection (plugin_example_hello) and publication (plugin.example.lastHello)
// with the last Hello message of each robot, written by the ingest entry
exports.HELLO_COLLECTION = 'hello';
exports.PUB_LAST_HELLO = 'lastHello';

// fastest-validator schema for the Hello widget config
exports.HELLO_CONFIG_SCHEMA = {
  $$strict: true,
  text: { type: 'string', empty: false },
};
