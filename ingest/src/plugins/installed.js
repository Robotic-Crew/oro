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
 * Plugins bundled into ingest. Enabling one at runtime is done through
 * settings (`plugins.enabled`).
 */
import examplePlugin from 'oro-plugin-example/ingest';
import intrinsicPlugin from 'oro-plugin-intrinsic/ingest';
import robotmodelPlugin from 'oro-plugin-robotmodel/ingest';

export default [examplePlugin, intrinsicPlugin, robotmodelPlugin];
