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
 * ConfigAPI kinds contributed by plugins. Core enforces the kind's declared
 * access policy on every call before the plugin handler runs, so a plugin that
 * forgets its own check can't leak or change config.
 */
import { CONFIG_KIND_ACCESS } from 'oro-plugin-sdk';
import OroRoles from '../roles';
import { AuthorizationError } from '../../shared/configAPI';
import { RESOURCE_SINGLETONS, ACCESS_LEVEL_CONFIGURE, isSystemUser } from '../../shared/roles';

// Handler operations that act as a user: ({ user, ... }) => ...
const GATED_OPERATIONS = ['list', 'apply', 'clear', 'delete', 'get'];

export const canConfigureFleet = async (user) => Boolean(user?._id) && (
  isSystemUser(user) || new OroRoles().canAccessSystemElement(
    user._id, RESOURCE_SINGLETONS.FLEET, ACCESS_LEVEL_CONFIGURE,
  )
);

const POLICIES = {
  [CONFIG_KIND_ACCESS.FLEET_CONFIGURE]: canConfigureFleet,
};

/**
 * Wraps a plugin kind handler so each user operation checks `access` first.
 * Unknown policies deny everything.
 */
export const wrapPluginKindHandler = ({ kind, access, pluginId }, handler) => {
  const allowed = POLICIES[access] || (async () => false);
  const wrapped = Object.create(handler);
  GATED_OPERATIONS.forEach((op) => {
    if (typeof handler[op] !== 'function') return;
    wrapped[op] = async (args = {}, ...rest) => {
      if (!(await allowed(args?.user))) {
        throw new AuthorizationError(`Unauthorized (${kind}, plugin ${pluginId})`);
      }
      return handler[op](args, ...rest);
    };
  });
  return wrapped;
};
