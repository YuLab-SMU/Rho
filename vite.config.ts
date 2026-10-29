import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { selectedUiEntries, contributionMetadata } from './scripts/ui-selection.mjs';
const chosen = selectedUiEntries();
const buildInputs: string[] = [];
function inputs(dir: string) { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) e.isDirectory() ? inputs(path.join(dir, e.name)) : buildInputs.push(path.join(dir, e.name)); }
inputs('web');
// Rho-owned entries (the Agent map) have no separate package; their source is under web.
for (const entry of chosen) if (entry.package) inputs(entry.extension ? path.dirname(entry.source) : 'node_modules/' + entry.package + '/dist');
const rendererHash = createHash('sha256');
rendererHash.update(JSON.stringify(chosen.map(({ source, directory, ...entry }) => entry)));
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
      if (id === '\0virtual:rho-ui-registry') return chosen.map((e, i) => e.extension
        ? `import { ${e.extension.export} as View${i} } from ${JSON.stringify(path.resolve(e.source))};\nconst e${i} = { ...${JSON.stringify(contributionMetadata(e))}, View: View${i} };`
        : 'import { entry as e' + i + ' } from ' + JSON.stringify(path.resolve(e.source)) + ';').join('\n') + '\nexport const registry = { entries: [' + chosen.map((_, i) => 'e' + i).join(',') + '] };';
    },
  }],
  base: '/',
  oxc: { jsx: { runtime: 'automatic' } },
  // Linked owner UI entries must share the shell's single React/CodeMirror/grid instance.
  resolve: { dedupe: ['react', 'react-dom', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@lezer/common', '@lezer/highlight', 'ag-grid-community', 'ag-grid-react'] },
  // Fonts stay files: the page's policy loads fonts only from the service.
  build: { assetsInlineLimit: (file: string) => /\.(woff2?|ttf)$/.test(file) ? false : undefined, outDir: process.env.RHO_WEB_OUTPUT ? path.resolve(process.env.RHO_WEB_OUTPUT) : '../dist/web', emptyOutDir: true, manifest: true, sourcemap: false, license: { fileName: 'licenses.md' } },
});
