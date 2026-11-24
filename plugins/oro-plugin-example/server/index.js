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

import { definePlugin } from 'oro-plugin-sdk';
import protoSource from '../proto/example.proto';
import {
  PLUGIN_ID, VERSION, SDK_RANGE, WIDGET_HELLO, KIND_NOTE, PROTO_NAME, HELLO_CONFIG_SCHEMA,
  HELLO_COLLECTION, PUB_LAST_HELLO,
} from '../shared';

/**
 * ConfigAPI handler for the `ExampleNote` kind: a free-text note per id, stored
 * in the plugin's own collection (plugin_example_notes).
 */
function createNoteHandler(ctx, notes) {
  const { errors, auth } = ctx;

  const assertAuthorized = async (user) => {
    if (!user || !(await auth.canConfigureFleet(user))) {
      throw new errors.AuthorizationError('Unauthorized');
    }
  };
  const idOf = (configObject) => {
    const id = String(configObject?.metadata?.id || '');
    // Same as core's ID_PATTERN: ids end up in Mongo queries and URLs
    if (!/^[a-zA-Z0-9_-]{1,255}$/.test(id)) {
      throw new errors.ValidationError('metadata.id must match /^[a-zA-Z0-9_-]+$/');
    }
    return id;
  };

  return {
    isGlobalConfig: () => false,

    list: async ({ id = null, user, format } = {}) => {
      await assertAuthorized(user);
      const docs = await notes.find(id ? { _id: id } : {}).fetchAsync();
      if (format === 'short') {
        return docs.map((doc) => ({ id: doc._id, label: doc.text }));
      }
      return docs.map((doc) => ({
        apiVersion: 'v0.1',
        kind: KIND_NOTE,
        metadata: { id: doc._id },
        spec: { text: doc.text },
      }));
    },

    apply: async ({ configObject, user }) => {
      await assertAuthorized(user);
      const id = idOf(configObject);
      const text = configObject?.spec?.text;
      if (typeof text !== 'string' || !text) {
        throw new errors.SchemaError('ExampleNote spec.text must be a non-empty string');
      }
      await notes.upsertAsync({ _id: id }, { $set: { text } });
    },

    clear: async ({ configObject, user }) => {
      await assertAuthorized(user);
      await notes.removeAsync({ _id: idOf(configObject) });
    },
  };
}

export default definePlugin({
  id: PLUGIN_ID,
  version: VERSION,
  sdkRange: SDK_RANGE,
  register(ctx) {
    ctx.registerProto({ name: PROTO_NAME, source: protoSource });
    ctx.registerWidgetType({
      type: WIDGET_HELLO,
      label: 'Hello (example)',
      scope: 'robot',
      configConverter: {
        configToSpec: (config) => ({ text: config?.text }),
        specToConfig: (spec) => ({ text: spec?.text }),
        configSchema: HELLO_CONFIG_SCHEMA,
      },
    });
    const notes = ctx.createCollection('notes');
    ctx.registerConfigKind({
      kind: KIND_NOTE,
      // Core checks this before every list/apply/clear; the handler checks again
      access: 'fleet.configure',
      createHandler: () => createNoteHandler(ctx, notes),
    });
    // Core checks the caller can view `robotId` before the handler runs
    const hello = ctx.createCollection(HELLO_COLLECTION);
    ctx.registerPublication({
      name: PUB_LAST_HELLO,
      access: 'robot.view',
      handler: async ({ robotId }) => hello.find({ _id: robotId }),
    });
  },
});
