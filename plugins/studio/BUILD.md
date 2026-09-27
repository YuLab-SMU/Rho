# Build Plugin Studio

Use the included source and public SDKs with an already installed Node.js and
TypeScript 6.0.3 compiler. Run `node build.mjs` with `tsc` on PATH, or set
`RHO_PLUGIN_TSC` to the absolute existing TypeScript compiler JavaScript file.
The build does not install dependencies. It emits browser modules and copies
HTML/CSS to `dist/`. Snapshot this directory with the public core CLI, selecting
the `ui-web` artifact when activating the plugin.

For development in the Rho repository, `node scripts/build-studio-plugin.mjs
/absolute/new/directory` assembles this package plus the public protocol/UI SDK
source outside the checkout, then builds with the existing client TypeScript.
The assembled manifest inventories all source files and ships their license.
