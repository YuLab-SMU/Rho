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
const entries = JSON.parse(await fs.readFile(new URL('ui-entries.json', root), 'utf8'));
const chosen = entries.filter(e => process.env.RHO_UI_PLUGINS === undefined || process.env.RHO_UI_PLUGINS.split(',').includes(e.plugin));
const optional = [...(chosen.some(e => e.plugin === 'documents') ? ['@codemirror/state', '@codemirror/view'] : []), ...(chosen.some(e => e.plugin === 'tables') ? ['ag-grid-community', 'ag-grid-react'] : [])];
for (const name of [...optional, 'react', 'react-dom', 'scheduler', 'dockview', 'dockview-core', 'dockview-react', 'vite', 'typescript']) {
  const manifest = JSON.parse(await fs.readFile(new URL('node_modules/' + name + '/package.json', root), 'utf8'));
  dependencies.push({ name, version: manifest.version, license: manifest.license });
}
const ownerEntries = await Promise.all(chosen.map(async entry => {
  const folder = new URL('node_modules/' + entry.package + '/', root);
  const pkg = JSON.parse(await fs.readFile(new URL('package.json', folder), 'utf8'));
  const bytes = await fs.readFile(new URL(pkg.exports[entry.entry], folder));
  return { ...entry, packageVersion: pkg.version, entrySha256: hash(bytes) };
}));
const record = { format: 'rho.web-build/1', uiProtocol: '0.1-draft', ownerEntries, selection: chosen.map(e => e.plugin).join(',') || 'shell-only', dependencies, assets: inventory, assetsSha256: hash(JSON.stringify(inventory)), licenses: 'licenses.md', node: process.version };
await fs.writeFile(new URL('composition.json', output), JSON.stringify(record, null, 2) + '\n');
console.log('Browser assets: ' + inventory.length + ' / SHA-256 ' + record.assetsSha256);
