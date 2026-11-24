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
 * MQTT stand-in for plugin tests: its own proto root, and the listeners
 * plugins register, keyed by subtopic.
 */
import { loadSync, parse } from 'protobufjs';

export default function makePluginMqtt({ coreSubtopics = [] } = {}) {
  const root = loadSync('src/shared/oro.proto');
  const listeners = {};
  return {
    root,
    listeners,
    addProtoSource: (source) => parse(source, root),
    registerListener: (subtopic, cb) => { listeners[subtopic] = cb; },
    listenerSubtopics: () => coreSubtopics,
    lookupType: (name) => root.lookupType(name),
  };
}
