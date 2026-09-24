# Build Plots independently

The package requires an existing Node.js runtime and the dependency versions in
`package.json` and `dependencies.lock`. `node build.mjs` checks them, compiles the
public TypeScript sources and emits an immutable `dist` artifact with third-party
notices. Set `RHO_PLUGIN_NODE_MODULES` to an existing dependency directory when
there is no local `node_modules`. No tool or dependency is installed automatically.

The source bundle includes `public/plugin-ui`, `public/plugin-protocol` and
`public/r-protocol`. It imports no private core source. In the Rho checkout,
`node scripts/build-plots-plugin.mjs /absolute/new/external/directory` assembles
and builds that independent package. Import/checkpoint it through the ordinary
plugin CLI and explicitly activate its selected artifact.
