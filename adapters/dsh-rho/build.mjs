import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(path.join(root, 'package.json'));
const packages = ['files', 'tables', 'media', 'contracts'];
const sha = data => createHash('sha256').update(data).digest('hex');
const selected = await Promise.all(packages.map(async name => {
  const entry = require.resolve('@rho-workspace/plugin-' + name);
  const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(entry), '../package.json'), 'utf8'));
  return { name: metadata.name, version: metadata.version, entrySha256: sha(await fs.readFile(entry)) };
}));
const base = { bundle: true, metafile: true, logLevel: 'info', absWorkingDir: here, nodePaths: [path.join(root, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' } };
await fs.mkdir(path.join(here, 'lib'), { recursive: true });
const host = await build({ ...base, entryPoints: ['src/host.ts'], outfile: 'lib/index.cjs', platform: 'node', target: 'node22', format: 'cjs' });
await build({ ...base, entryPoints: ['src/store.ts'], outfile: 'lib/store.mjs', platform: 'node', target: 'node22', format: 'esm' });
const client = await build({ ...base, entryPoints: ['src/client.tsx'], outfile: 'lib/client.js', platform: 'browser', target: 'es2022', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-rho",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});
const source = directory => ({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(), tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: directory, encoding: 'utf8' }).trim(), localOverride: !!execFileSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' }).trim() });
const artifacts = await Promise.all(['index.cjs', 'client.js'].map(async name => ({ name, sha256: sha(await fs.readFile(path.join(here, 'lib', name))) })));
const inputs = await Promise.all([...new Set([...Object.keys(host.metafile.inputs), ...Object.keys(client.metafile.inputs)])].sort().map(async file => ({ file, sha256: sha(await fs.readFile(path.resolve(here, file))) })));
const notices = [];
const dependencyRoots = new Set(inputs.filter(input => input.file.includes('/node_modules/')).map(input => {
  const absolute = path.resolve(here, input.file), index = absolute.lastIndexOf('/node_modules/') + '/node_modules/'.length;
  const parts = absolute.slice(index).split('/'), count = parts[0].startsWith('@') ? 2 : 1;
  return absolute.slice(0, index) + parts.slice(0, count).join('/');
}));
for (const directory of [...dependencyRoots].sort()) {
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const license = (await fs.readdir(directory)).find(file => /^LICENSE(\.txt|\.md)?$/i.test(file));
  if (!license) throw new Error('Missing bundled dependency license: ' + metadata.name);
  notices.push(`${metadata.name} ${metadata.version}\n\n${await fs.readFile(path.join(directory, license), 'utf8')}`);
}
await fs.writeFile(path.join(here, 'lib/THIRD_PARTY_LICENSES.txt'), notices.join('\n\n---\n\n'));
await fs.copyFile(path.join(root, 'LICENSE'), path.join(here, 'LICENSE'));
await fs.writeFile(path.join(here, 'lib/composition.json'), JSON.stringify({ dsh: '0.2.1-rc.5', rho: source(root), plugins: source(path.resolve(root, '../Rho-plugins')), selected, inputs, artifacts }, null, 2) + '\n');
