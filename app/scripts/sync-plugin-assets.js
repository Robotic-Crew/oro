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
 * Copies each installed plugin's `public/` directory to `public/plugins/<id>/`,
 * where Meteor serves it at `/plugins/<id>/...`. The plugin id comes from the
 * `oroPlugin.id` field of the plugin's package.json, and must match the
 * package name (`oro-plugin-<id>`).
 *
 * Only plugins the app depends on directly are synced, `public/plugins/` is
 * rebuilt from scratch each run (removed plugins leave nothing behind), and
 * symlinks are skipped so nothing outside the plugin's `public/` is copied.
 *
 * Everything synced is served WITHOUT login: don't put private assets in a
 * plugin's `public/`.
 *
 * Runs on `postinstall`; run `npm run sync-plugin-assets` after editing a
 * plugin asset. Plain Node, no dependencies.
 */
const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(APP_DIR, 'node_modules');
const TARGET_DIR = path.join(APP_DIR, 'public', 'plugins');
const PLUGIN_ID_RE = /^[a-z][a-z0-9]{1,31}$/;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
};

const notSymlink = (src) => !fs.lstatSync(src).isSymbolicLink();

const main = () => {
  fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  if (!fs.existsSync(NODE_MODULES)) return;
  const appPkg = readJson(path.join(APP_DIR, 'package.json')) || {};
  const deps = Object.keys(appPkg.dependencies || {}).filter((name) => name.startsWith('oro-plugin-'));
  const synced = [];
  for (const name of deps) {
    const pkgDir = path.join(NODE_MODULES, name);
    const id = readJson(path.join(pkgDir, 'package.json'))?.oroPlugin?.id;
    if (!id) continue;
    if (!PLUGIN_ID_RE.test(id) || name !== `oro-plugin-${id}`) {
      console.warn(`sync-plugin-assets: ${name} has an invalid oroPlugin.id ${JSON.stringify(id)}; skipped`);
      continue;
    }
    const publicDir = fs.realpathSync(pkgDir) + path.sep + 'public';
    if (!fs.existsSync(publicDir) || !fs.lstatSync(publicDir).isDirectory()) continue;
    fs.mkdirSync(TARGET_DIR, { recursive: true });
    fs.cpSync(publicDir, path.join(TARGET_DIR, id), { recursive: true, filter: notSymlink });
    synced.push(id);
  }
  if (synced.length) console.log(`sync-plugin-assets: ${synced.join(', ')} -> public/plugins/`);
};

main();
