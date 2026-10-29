import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { selectedUiEntries } from './ui-selection.mjs';
const root = new URL('../', import.meta.url), output = process.env.RHO_WEB_OUTPUT ? pathToFileURL(path.resolve(process.env.RHO_WEB_OUTPUT) + path.sep) : new URL('../dist/web/', import.meta.url);
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
const chosen = selectedUiEntries();
const optional = [...(chosen.some(e => e.plugin === 'documents') ? ['@codemirror/state', '@codemirror/view'] : []), ...(chosen.some(e => e.plugin === 'tables') ? ['ag-grid-community', 'ag-grid-react'] : [])];
for (const name of [...optional, 'react', 'react-dom', 'scheduler', 'vite', 'typescript']) {
  const manifest = JSON.parse(await fs.readFile(new URL('node_modules/' + name + '/package.json', root), 'utf8'));
  dependencies.push({ name, version: manifest.version, license: manifest.license });
}
const ownerEntries = await Promise.all(chosen.map(async entry => {
  if (entry.extension) {
    const { source, directory, ...record } = entry;
    return record;
  }
  // A Rho-owned entry is built from this checkout's source at the application version.
  if (!entry.package) return { ...entry, package: JSON.parse(await fs.readFile(new URL('package.json', root), 'utf8')).name, packageVersion: JSON.parse(await fs.readFile(new URL('package.json', root), 'utf8')).version, entrySha256: hash(await fs.readFile(new URL(entry.source, root))) };
  const folder = new URL('node_modules/' + entry.package + '/', root);
  const pkg = JSON.parse(await fs.readFile(new URL('package.json', folder), 'utf8'));
  const bytes = await fs.readFile(new URL(pkg.exports[entry.entry], folder));
  return { ...entry, packageVersion: pkg.version, entrySha256: hash(bytes) };
}));
const renderer = JSON.parse(await fs.readFile(new URL('renderer.json', output), 'utf8'));
const record = { format: 'rho.web-build/1', uiProtocol: '0.1-draft', rendererBuild: renderer.rendererBuild, ownerEntries, selection: [...new Set(chosen.filter(e => e.package).map(e => e.plugin))].join(',') || 'shell-only', applicationEntries: chosen.filter(e => !e.package).map(e => e.plugin), dependencies, assets: inventory, assetsSha256: hash(JSON.stringify(inventory)), licenses: 'licenses.md', node: process.version };
await fs.writeFile(new URL('composition.json', output), JSON.stringify(record, null, 2) + '\n');
console.log('Browser assets: ' + inventory.length + ' / SHA-256 ' + record.assetsSha256);
