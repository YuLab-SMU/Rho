# Build

Run `node build.mjs` inside this directory using an existing Node.js 22 or newer.
There are no third-party dependencies or install steps. The build copies the
first-party HTML source to `dist/index.html` without changing it.

After building, run `rho plugins --store /path/to/test-store snapshot . --target ui-web`.
Snapshotting and importing do not execute this build recipe.
