import * as fs from 'node:fs/promises';
const plugin = new URL('../node_modules/@rho-workspace/headless', import.meta.url);
if ((await fs.lstat(plugin)).isSymbolicLink()) throw new Error('Development plugin override is linked. Use npm run pack:local -- --core BINARY --core-source REPOSITORY to assemble immutable artifacts.');
await fs.access(new URL('../dist/cli.js', import.meta.url));
