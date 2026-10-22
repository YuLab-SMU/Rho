import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import entries from './ui-entries.json';
const selected = process.env.RHO_UI_PLUGINS?.split(',') ?? entries.map(e => e.plugin);
// Rho-owned entries are part of the application selection; RHO_UI_OMIT drops one explicitly.
const omitted = process.env.RHO_UI_OMIT?.split(',') ?? [];
const chosen = entries.filter(e => e.package ? selected.includes(e.plugin) : !omitted.includes(e.plugin));
const buildInputs: string[] = [];
function inputs(dir: string) { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) e.isDirectory() ? inputs(path.join(dir, e.name)) : buildInputs.push(path.join(dir, e.name)); }
inputs('web');
// Rho-owned entries (the Agent map) have no separate package; their source is under web.
for (const entry of chosen) if (entry.package) inputs('node_modules/' + entry.package + '/dist');
const rendererHash = createHash('sha256');
for (const file of [...buildInputs, 'src/ui-contract.ts', 'src/browser.ts', 'package-lock.json']) rendererHash.update(file).update(fs.readFileSync(file));
const rendererBuild = rendererHash.digest('hex');
export default defineConfig({
  define: { 'import.meta.env.VITE_RHO_RENDERER_BUILD': JSON.stringify(rendererBuild) },
  root: 'web',
  plugins: [{
    name: 'rho-trusted-owner-ui',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'renderer.json', source: JSON.stringify({ rendererBuild }) + '\n' }); },
    resolveId(id) { if (id === 'virtual:rho-ui-registry' || id === 'virtual:rho-ui-registry-meta') return '\0' + id; },
    load(id) {
      if (id === '\0virtual:rho-ui-registry-meta') return 'export const rendered = ' + JSON.stringify(chosen.map(e => ({ component: e.component, version: e.version }))) + ';';
      if (id === '\0virtual:rho-ui-registry') return chosen.map((e, i) => 'import { entry as e' + i + ' } from ' + JSON.stringify(path.resolve(e.source)) + ';').join('\n') + '\nexport const registry = { entries: [' + chosen.map((_, i) => 'e' + i).join(',') + '] };';
    },
  }],
  base: '/',
  oxc: { jsx: { runtime: 'automatic' } },
  // Linked owner UI entries must share the shell's single React/CodeMirror/grid instance.
  resolve: { dedupe: ['react', 'react-dom', '@codemirror/state', '@codemirror/view', 'ag-grid-community', 'ag-grid-react'] },
  build: { outDir: '../dist/web', emptyOutDir: true, manifest: true, sourcemap: false, license: { fileName: 'licenses.md' } },
});
