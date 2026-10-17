import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url), output = new URL('../dist/web/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inventory = [];
async function walk(directory, prefix = '') {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await walk(new URL(entry.name + '/', directory), relative + '/');
    else if (relative !== 'composition.json') {
      const bytes = await fs.readFile(new URL(entry.name, directory));
      inventory.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
}
await walk(output);
const dependencies = [];
for (const name of ['react', 'react-dom', 'scheduler', 'dockview', 'dockview-core', 'dockview-react', 'vite', 'typescript']) {
  const manifest = JSON.parse(await fs.readFile(new URL('node_modules/' + name + '/package.json', root), 'utf8'));
  dependencies.push({ name, version: manifest.version, license: manifest.license });
}
const record = { format: 'rho.web-build/1', uiProtocol: '0.1-draft', ownerEntries: [], selection: 'U1 shell; no functional renderer selected', dependencies, assets: inventory, assetsSha256: hash(JSON.stringify(inventory)), licenses: 'licenses.md', node: process.version };
await fs.writeFile(new URL('composition.json', output), JSON.stringify(record, null, 2) + '\n');
console.log('Browser assets: ' + inventory.length + ' / SHA-256 ' + record.assetsSha256);
