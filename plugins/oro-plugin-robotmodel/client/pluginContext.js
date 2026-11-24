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
 * The plugin's client context (core services) and collections, set once in
 * register(ctx) and read by the widget's modules.
 */
import { COLLECTIONS } from '../shared';

let context = null;
let collections = null;

export const setPluginContext = (ctx) => {
  context = ctx;
  collections = {
    models: ctx.createCollection(COLLECTIONS.MODELS),
    assignments: ctx.createCollection(COLLECTIONS.ASSIGNMENTS),
    jointStates: ctx.createCollection(COLLECTIONS.JOINT_STATES),
    scenes: ctx.createCollection(COLLECTIONS.SCENES),
  };
};

export const getPluginContext = () => {
  if (!context) throw new Error('[plugin:robotmodel] used before register()');
  return context;
};

export const getCollections = () => {
  getPluginContext();
  return collections;
};
