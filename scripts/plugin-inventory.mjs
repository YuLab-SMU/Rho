import * as fs from 'node:fs/promises';
// A finite, descriptive build inventory. Reduced installations keep this copy
// without importing absent owners. It contributes no operations, Skills or grants.
const plugins = [];
for (const id of ['documents', 'files', 'r', 'requirements', 'tables', 'media', 'charts', 'agent', 'annotations']) {
  const { plugin } = await import('@rho-workspace/plugin-' + id);
  plugins.push({ id, package: plugin.package, version: plugin.version, requires: plugin.requires, presentation: plugin.presentation,
    listing: {
      actions: plugin.operations.map(operation => ({ presentation: operation.presentation })),
      views: (plugin.components ?? []).map(view => ({ id: view.id, version: view.version, ui: view.ui, presentation: view.presentation })),
      skills: plugin.skills.map(skill => ({ id: skill.id, version: skill.version, digest: skill.digest, presentation: skill.presentation })),
    } });
}
await fs.writeFile(new URL('../dist/plugin-inventory.json', import.meta.url), JSON.stringify({ schemaVersion: 1, plugins }, null, 2) + '\n');
