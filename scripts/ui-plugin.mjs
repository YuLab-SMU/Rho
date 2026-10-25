#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readUiPackage } from './ui-selection.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';
export async function createUiPlugin(directory, options = {}) {
  directory = path.resolve(directory);
  const slug = path.basename(directory).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const name = options.name ?? '@example/' + slug, component = options.component ?? 'example.' + slug;
  if (!/^(@[a-z0-9._-]+\/)?[a-z][a-z0-9._-]*$/.test(name) || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(component) || component.startsWith('rho.')) throw new Error('Choose a package name and a component outside the reserved rho. namespace.');
  // The assembled application omits devDependencies. Keep the author toolchain
  // in a shipped data file so an installed SDK can generate the same package.
  const toolchain = JSON.parse(await fs.readFile(path.join(root, 'scripts/ui-toolchain.json'), 'utf8'));
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory); // Never overwrite an existing directory, even an empty one.
  await fs.mkdir(path.join(directory, 'src'));
  const manifest = { format: 'rho.ui-extension/1', plugin: 'documents', component, version: '1.0.0', displayName: 'Document summary', description: 'A view of the current shared document.', entry: './ui', development: './src/ui.tsx', export: 'View',
    propsSchema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' } } }, bindings: { document: 'document' }, requiredOperations: ['document.read'] };
  const source = `import { useEffect, useState } from 'react';
import type { UiViewProps } from '@rho-workspace/local/ui-contract';

export function View({ view, client, projectId, snapshot }: UiViewProps) {
  const documentId = (view.bindings.document as { documentId?: string } | undefined)?.documentId;
  const version = snapshot.documents.find(d => d.id === documentId)?.version;
  const [content, setContent] = useState<string | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setContent(null); setError('');
    if (documentId) client.call('document.read', { projectId, documentId }, abort.signal)
      .then(document => { if (!abort.signal.aborted) setContent(document.content); })
      .catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not read the document.'); });
    return () => abort.abort();
  }, [client, projectId, documentId, version]);
  return <section style={{ padding: 24, overflow: 'auto', height: '100%' }}>
    <h2>{String(view.props.title ?? 'Document summary')}</h2>
    {!documentId ? <p role="status">Bind a document to get started.</p>
      : error ? <p role="alert">{error}</p>
      : content === null ? <p role="status">Reading document…</p>
      : <><p>{[...content].length} characters</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content}</pre></>}
  </section>;
}
`;
  const files = {
    'package.json': json({ name, version: '0.1.0', type: 'module', private: true, description: 'A Rho document view', license: 'UNLICENSED', exports: { './ui': './dist/ui.js', './package.json': './package.json' }, rho: { ui: './rho-ui.json' }, files: ['dist', 'rho-ui.json', 'README.md'],
      scripts: { dev: 'rho-ui dev .', check: 'rho-ui check .', build: 'rho-ui build .' }, peerDependencies: { react: toolchain.react },
      devDependencies: { '@rho-workspace/local': options.sdk ?? 'file:' + root, ...toolchain } }),
    'rho-ui.json': json(manifest),
    'rho-selection.json': json({ format: 'rho.ui-selection/1', packages: [{ package: name, version: '0.1.0', directory: '.' }] }),
    'tsconfig.json': json({ compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, declaration: true, outDir: 'dist', rootDir: 'src', skipLibCheck: true }, include: ['src'] }),
    'src/ui.tsx': source,
    'preview.json': json({ props: { title: 'Research notes' }, bindings: { document: { kind: 'live-document', documentId: 'preview-document' } }, documents: [{ id: 'preview-document', path: 'notes.md', version: 1 }], responses: { 'document.read': { id: 'preview-document', version: 1, content: '# Research notes\n\nDescribe your question here.\n\n保留 Unicode 🧬' } } }),
    '.gitignore': 'node_modules/\ndist/\n*.tgz\n',
    'README.md': '# ' + name + '\n\nRun `npm install`, then `npm run dev`. Edit `src/ui.tsx` and `preview.json`; the preview refreshes automatically. It uses fixture responses and has no project credentials.\n\nRun `npm run check` and `npm run build` before selecting this package in Rho. `rho-selection.json` pins this local package. From the Rho checkout, use `RHO_UI_EXTENSIONS=/absolute/path/to/rho-selection.json npm run build:web`. The new browser build is read at the next service start. Do not restart an existing service without its owner’s authorization.\n\nThe component reuses the Documents owner. It adds no server operations or grants. Rho validates its props and exact bindings, and keeps the shared document buffer. Preview refresh resets local component state; it does not test live save, undo or authorization.\n\nSee the installed Rho `docs/PLUGIN-AUTHORING.md` for the complete workflow.\n'
  };
  for (const [relative, content] of Object.entries(files)) await fs.writeFile(path.join(directory, relative), content);
  return directory;
}
function typecheck(directory, emit) {
  const require = createRequire(path.join(directory, 'package.json'));
  let compiler;
  try { compiler = require.resolve('typescript/bin/tsc'); } catch { throw new Error('Install the plugin development dependencies first: npm install'); }
  const result = spawnSync(process.execPath, [compiler, '-p', path.join(directory, 'tsconfig.json'), ...(!emit ? ['--noEmit'] : [])], { cwd: directory, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Plugin TypeScript check failed.');
}
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { name: { type: 'string' }, component: { type: 'string' }, sdk: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean' } } });
  const [command, target] = positionals;
  if (values.help || !command) { console.log('rho-ui create <new-directory> [--name @scope/view] [--component scope.view] [--sdk file:/path/to/rho.tgz]\nrho-ui dev <directory> [--port 5174]\nrho-ui check <directory>\nrho-ui build <directory>'); return; }
  if (!target || positionals.length !== 2) throw new Error('Supply one plugin directory. Use --help for commands.');
  const directory = path.resolve(target);
  if (command === 'create') { console.log('Created ' + await createUiPlugin(directory, values) + '\nNext: npm install, npm run dev, npm run check, npm run build'); return; }
  if (command === 'dev') { const { preview } = await import('./ui-preview/server.mjs'); await preview(directory, { port: values.port === undefined ? 5174 : Number(values.port) }); return; }
  if (!['check', 'build'].includes(command)) throw new Error('Unknown command: ' + command);
  readUiPackage(directory, { development: true });
  typecheck(directory, command === 'build');
  const entry = readUiPackage(directory, { development: command !== 'build' });
  console.log(JSON.stringify({ checked: true, package: entry.package, version: entry.packageVersion, component: entry.component, ...(command === 'build' ? { entrySha256: entry.entrySha256 } : {}) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(await fs.realpath(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
