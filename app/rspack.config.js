/**
 * Copyright 2026 InOrbit, Inc.
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

const { defineConfig } = require("@meteorjs/rspack");

// The plugin SDK and plugins (oro-plugin-*): npm packages, `file:` deps in
// development, that ship untranspiled sources (JSX, CommonJS)
const PLUGIN_PACKAGES = /[\\/]node_modules[\\/]oro-plugin-[^\\/]+[\\/]/;

/**
 * Rspack configuration for Meteor projects.
 *
 * Provides typed flags on the `Meteor` object, such as:
 * - `Meteor.isClient` / `Meteor.isServer`
 * - `Meteor.isDevelopment` / `Meteor.isProduction`
 * - …and other flags available
 *
 * Use these flags to adjust your build settings based on environment.
 */
module.exports = defineConfig((Meteor) => {
  return {
    ignoreWarnings: [
      // fastest-validator uses `new Function(...)` to compile schemas, which
      // rspack flags as a critical dynamic dependency. The behavior is
      // intentional, so silence the warning only for this library.
      {
        module: /[\\/]fastest-validator[\\/]/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
    ],
    resolve: {
      alias: {
        // Handlebars' main entry uses the deprecated Node `require.extensions`
        // API to register a loader for .handlebars/.hbs files, which rspack
        // can't statically analyze. The precompiled dist build omits that
        // loader while still exposing the full compiler API we use.
        handlebars: "handlebars/dist/handlebars.js",
      },
      // Keep `file:` deps (plugins, the plugin SDK; symlinked from ../plugins and
      // ../packages) under node_modules instead of their real path, so they
      // resolve and build exactly as when installed from a registry.
      symlinks: false,
    },
    // The persistent cache treats node_modules as immutable (keyed by package
    // version), so edits to the symlinked plugin sources would be ignored.
    experiments: {
      cache: {
        snapshot: { unmanagedPaths: [PLUGIN_PACKAGES] },
      },
    },
    module: {
      rules: [
        // Meteor's swc rule skips node_modules; compile plugin packages too.
        // `isModule: 'unknown'` keeps CommonJS files (the SDK, plugins' shared/)
        // as CommonJS: on the client swc injects ESM helper imports otherwise,
        // which leaves them with no exports.
        {
          test: /\.(?:c?js|jsx)$/i,
          include: PLUGIN_PACKAGES,
          loader: "builtin:swc-loader",
          options: { ...Meteor.swcConfigOptions, isModule: "unknown" },
        },
        // Plugins import their .proto files as text and register them at runtime
        {
          test: /\.proto$/i,
          type: "asset/source",
        },
        // Add support for importing SVGs as React components
        {
          test: /\.svg$/i,
          issuer: /\.[jt]sx?$/,
          use: ["@svgr/webpack"],
        },
        // react-calendar-timeline 0.30 declares `sideEffects: false` in its
        // package.json, which causes the bundler to tree-shake CSS imports.
        // Force its stylesheets to be retained.
        {
          test: /[\\/]react-calendar-timeline[\\/].*\.css$/,
          sideEffects: true,
        },
      ],
    },
  };
});
