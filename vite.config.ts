import { defineConfig } from 'vite';
import path from 'node:path';
import entries from './ui-entries.json';
const selected = process.env.RHO_UI_PLUGINS?.split(',') ?? entries.map(e => e.plugin);
const chosen = entries.filter(e => selected.includes(e.plugin));
export default defineConfig({
  root: 'web',
  plugins: [{
    name: 'rho-trusted-owner-ui',
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
