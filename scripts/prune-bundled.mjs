// Bundled third-party packages arrive as their authors publish them: type declarations, source
// maps, TypeScript sources, tests and documentation beside the JavaScript Node loads. A file costs
// an installation on Windows far more than its bytes (issue #112), so the packer removes those from
// the staged node_modules. First-party packages and license texts stay whole, and so do the
// declarations of packages a first-party declaration names, so the shipped types still resolve.
// A file a package names as an entry (main, bin, exports) is never removed.
//   node scripts/prune-bundled.mjs PACKAGE_DIRECTORY
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const declaration = /\.d\.[cm]?ts$/;
const removable = [/\.(js|cjs|mjs|ts|mts|cts|css)\.map$/, /(?<!\.d)\.(ts|mts|cts|tsx)$/, /\.tsbuildinfo$/, /^tsconfig.*\.json$/, /^\./, /\.(md|markdown)$/i];
const removableDirectories = new Set(['test', 'tests', '__tests__', 'spec', 'benchmark', 'benchmarks', 'example', 'examples', '.github']);
const license = /^(licen[cs]e|copying|notice)/i;
const packageName = specifier => specifier.match(/^(@[^/]+\/[^/]+|[^@./][^/]*)/)?.[1];

async function walk(directory, visit) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file, visit); else await visit(file);
  }
}

// Every installed package, outermost first, with the files beneath it that are its own.
async function packages(modules) {
  const found = [];
  for (const entry of await fs.readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const names = entry.name.startsWith('@') ? (await fs.readdir(path.join(modules, entry.name))).map(n => entry.name + '/' + n) : [entry.name];
    for (const name of names) {
      const root = path.join(modules, name);
      found.push({ name, root });
      try { found.push(...await packages(path.join(root, 'node_modules'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  return found;
}

async function specifiers(file) {
  const text = await fs.readFile(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|reference\s+types\s*=\s*['"]([^'"]+)['"]/g)].map(m => packageName(m[1] ?? m[2])).filter(Boolean);
}

// Export conditions Node itself selects; others (types, source, bun, deno) name files for other tools.
const nodeConditions = new Set(['node', 'import', 'require', 'module-sync', 'default']);
function entries(root, manifest) {
  const targets = [];
  const add = target => { if (typeof target === 'string' && !target.includes('*')) targets.push(path.join(root, target), path.join(root, target + '.js')); };
  const exportsOf = value => {
    if (typeof value === 'string') add(value);
    else if (Array.isArray(value)) value.forEach(exportsOf);
    else if (value) for (const [key, inner] of Object.entries(value)) if (key.startsWith('.') || nodeConditions.has(key)) exportsOf(inner);
  };
  add(manifest.main ?? 'index.js');
  if (typeof manifest.bin === 'string') add(manifest.bin); else Object.values(manifest.bin ?? {}).forEach(add);
  exportsOf(manifest.exports);
  return targets;
}

export async function pruneBundled(packageDirectory) {
  const all = await packages(path.join(packageDirectory, 'node_modules'));
  const owner = file => all.filter(p => file.startsWith(p.root + path.sep)).at(-1);
  const firstParty = p => p.name.startsWith('@rho-workspace/');

  // Declarations reachable from the application's own and the first-party packages' declarations.
  const typed = new Set(), queue = [];
  const named = async file => { for (const name of await specifiers(file)) if (!typed.has(name)) { typed.add(name); queue.push(name); } };
  await walk(path.join(packageDirectory, 'dist'), async file => { if (declaration.test(file)) await named(file); });
  for (const p of all.filter(firstParty)) await walk(p.root, async file => { if (declaration.test(file) && owner(file) === p) await named(file); });
  while (queue.length) {
    const name = queue.shift();
    for (const p of all.filter(p => p.name === name && !firstParty(p))) await walk(p.root, async file => { if (declaration.test(file) && owner(file) === p) await named(file); });
  }

  let removed = 0, kept = 0;
  for (const p of all.filter(p => !firstParty(p))) {
    const protectedFiles = new Set(entries(p.root, JSON.parse(await fs.readFile(path.join(p.root, 'package.json'), 'utf8'))));
    const doomed = [];
    await walk(p.root, async file => {
      if (owner(file) !== p) return;
      const base = path.basename(file), within = path.relative(p.root, file).split(path.sep).slice(0, -1);
      const remove = !license.test(base) && base !== 'package.json' && (within.some(d => removableDirectories.has(d)) || (declaration.test(base) ? !typed.has(p.name) : removable.some(r => r.test(base))));
      if (!remove) { kept++; return; }
      if (protectedFiles.has(file)) throw new Error(p.name + ' names ' + path.relative(p.root, file) + ' as an entry; it cannot be pruned.');
      doomed.push(file);
    });
    for (const file of doomed) { await fs.rm(file); removed++; }
  }
  return { removed, kept, typed: [...typed].filter(name => !name.startsWith('@rho-workspace/') && all.some(p => p.name === name)).sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Select the package directory whose node_modules is pruned.');
  process.stdout.write(JSON.stringify(await pruneBundled(path.resolve(process.argv[2]))) + '\n');
}
