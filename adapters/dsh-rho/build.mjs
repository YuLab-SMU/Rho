import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, parse } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// The Agent owner supplies the normalizer and project-local observation store.
// Distribute its built public entry, not a second adapter implementation.
const ownerEntry = fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/dsh-session'));
const observation = await build({ entryPoints: [ownerEntry], outfile: new URL('lib/observe.cjs', import.meta.url).pathname, bundle: true, format: 'cjs', platform: 'node', target: 'node22', metafile: true, legalComments: 'eof' });
const inputs = await Promise.all(Object.keys(observation.metafile.inputs).sort().map(async name => ({ name: name.replace(/^.*\/node_modules\//, 'node_modules/').replace(/^.*\/Rho-plugins\//, 'Rho-plugins/'), sha256: createHash('sha256').update(await readFile(name)).digest('hex') })));
const licenses = new Map();
for (const file of Object.keys(observation.metafile.inputs)) {
  let dir = dirname(resolve(file));
  while (dir !== parse(dir).root) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (!licenses.has(pkg.name)) {
        let license = '';
        for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT', 'license']) {
          try { license = await readFile(join(dir, name), 'utf8'); break; } catch {}
        }
        if (!license) throw new Error('Missing license for ' + pkg.name);
        licenses.set(pkg.name, pkg.name + '@' + pkg.version + ' (' + pkg.license + ')\n' + license);
      }
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    dir = dirname(dir);
  }
}
await writeFile(new URL('lib/observe.LICENSES.txt', import.meta.url), [...licenses].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v).join('\n\n'));
await writeFile(new URL('lib/observe-source.json', import.meta.url), JSON.stringify({ entry: '@rho-workspace/plugin-agent/dsh-session', inputs }, null, 2) + '\n');

await build({
  absWorkingDir: dirname(fileURLToPath(import.meta.url)),
  entryPoints: ['src/client.jsx'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true,
  external: ['react', 'react/jsx-runtime'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-rho",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});
