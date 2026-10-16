import * as fs from 'node:fs/promises';
const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const name of Object.keys(manifest.dependencies).filter(n => n.startsWith('@rho-workspace/plugin-'))) {
  if ((await fs.lstat(new URL('../node_modules/' + name, import.meta.url))).isSymbolicLink()) throw new Error('Development plugin override is linked. Use npm run pack:local -- --core BINARY --core-source REPOSITORY to assemble selected immutable plugin artifacts.');
}
await fs.access(new URL('../dist/cli.js', import.meta.url));
