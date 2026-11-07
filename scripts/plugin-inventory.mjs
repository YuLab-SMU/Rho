import * as fs from 'node:fs/promises';
import { pluginIds } from '../dist/plugins.js';
import { packageFacts, pluginListing } from '../dist/plugin-inventory.js';
// A finite, descriptive build inventory. Reduced installations keep this copy
// without importing absent owners. It contributes no operations, Skills or grants.
const plugins = [];
for (const id of pluginIds) {
  const { plugin } = await import('@rho-workspace/plugin-' + id);
  const facts = await packageFacts(plugin.package);
  plugins.push({ id, package: plugin.package, version: plugin.version, packageVersion: facts.version, requires: plugin.requires, presentation: plugin.presentation,
    listing: pluginListing(plugin, facts) });
}
await fs.writeFile(new URL('../dist/plugin-inventory.json', import.meta.url), JSON.stringify({ schemaVersion: 1, plugins }, null, 2) + '\n');
