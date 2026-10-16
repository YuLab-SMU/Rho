import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { core: { type: 'string' }, 'core-source': { type: 'string' }, plugins: { type: 'string' }, destination: { type: 'string' }, 'allow-dirty': { type: 'boolean', default: false }, 'select-plugins': { type: 'string' } } });
if (!values.core || !values['core-source']) throw new Error('Select --core BINARY and --core-source REPOSITORY. The build must already have completed.');
const pluginRoot = path.resolve(values.plugins ?? path.join(root, '../Rho-plugins'));
const coreRoot = path.resolve(values['core-source']);
const destination = path.resolve(values.destination ?? path.join(root, 'work/package-' + Date.now()));
const stage = path.join(destination, 'stage');
await fs.mkdir(destination, { recursive: true }); await fs.mkdir(stage);
function run(command, args, cwd) {
  const p = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (p.status !== 0) throw new Error(command + ' failed: ' + p.stderr.slice(-2000));
  return p.stdout;
}
const sha = b => createHash('sha256').update(b).digest('hex');
async function source(directory, paths, committedFiles = []) {
  const commit = run('git', ['rev-parse', 'HEAD'], directory).trim();
  const tree = run('git', ['rev-parse', 'HEAD^{tree}'], directory).trim();
  const changed = run('git', ['status', '--porcelain', '--', ...paths], directory).trim();
  if (changed && !values['allow-dirty']) throw new Error('Selected build inputs have uncommitted changes. Commit them or select the explicit --allow-dirty development override.');
  const names = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...paths, ...committedFiles], directory).split('\0').filter(Boolean).sort();
  const inventory = [];
  for (const relative of names) {
    try {
      const file = path.join(directory, relative), stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error('Build inputs must be ordinary files: ' + relative);
      inventory.push({ path: relative, sha256: sha(committedFiles.includes(relative) ? run('git', ['show', 'HEAD:' + relative], directory) : await fs.readFile(file)) });
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return { commit, tree, buildInputsSha256: sha(JSON.stringify(inventory)), localOverride: changed ? 'explicit-dirty-build-inputs' : null };
}
run('npm', ['run', 'build'], root);
const pluginIds = ['documents', 'files', 'r', 'requirements', 'tables', 'media', 'charts', 'agent'];
const selected = values['select-plugins'] === undefined ? pluginIds : values['select-plugins'].split(',').filter(Boolean);
if (new Set(selected).size !== selected.length || selected.some(id => !pluginIds.includes(id))) throw new Error('Select unique known plugin IDs.');
const application = await source(root, ['src', 'scripts', 'protocol', 'fixtures', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'docs/HEADLESS.md']);
const plugins = await source(pluginRoot, ['packages/contracts', ...selected.map(id => 'plugins/' + id), 'scripts', 'package.json', 'package-lock.json', 'LICENSE']);
const core = await source(coreRoot, ['src', 'Cargo.toml', 'Cargo.lock', 'LICENSE']);
const pluginPacks = JSON.parse(run(process.execPath, [path.join(pluginRoot, 'scripts/pack.mjs'), '--destination', path.join(destination, 'plugins'), '--plugins', selected.join(',')], pluginRoot));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
for (const entry of manifest.files.filter(p => p !== 'vendor')) {
  try { await fs.cp(path.join(root, entry), path.join(stage, entry), { recursive: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
await fs.mkdir(path.join(stage, 'vendor'));
for (const item of pluginPacks.packages) {
  await fs.copyFile(path.join(pluginPacks.destination, item.filename), path.join(stage, 'vendor', item.filename));
}

const binary = await fs.readFile(path.resolve(values.core));
await fs.writeFile(path.join(stage, 'vendor/rho-core'), binary, { mode: 0o755 });
await fs.copyFile(path.join(coreRoot, 'LICENSE'), path.join(stage, 'vendor/CORE-LICENSE'));
for (const name of Object.keys(manifest.dependencies).filter(name => name.startsWith('@rho-workspace/plugin-'))) delete manifest.dependencies[name];
for (const item of pluginPacks.packages) manifest.dependencies[item.package] = 'file:vendor/' + item.filename;
manifest.bundleDependencies = Object.keys(manifest.dependencies);
delete manifest.devDependencies;
manifest.scripts = { acceptance: 'node scripts/acceptance.mjs', recovery: 'node scripts/recovery-acceptance.mjs' };
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
const composition = { schemaVersion: 1, platform: process.platform + '-' + process.arch, node: process.version, application: { repository: 'https://github.com/YuLab-SMU/Rho', ...application }, plugins: { repository: 'https://github.com/YuLab-SMU/Rho-plugins', ...plugins, selected, packages: pluginPacks.packages.map(({ files, ...item }) => item) }, core: { repository: 'https://github.com/YuLab-SMU/Rho-core', ...core, artifactSha256: sha(binary), bytes: binary.length, buildAssociation: 'Explicitly selected local build; no reproducible-build or signing claim.' }, productionLockSha256: sha(await fs.readFile(path.join(stage, 'package-lock.json'))), distribution: 'unsigned-local-npm-tarball', registryPublication: 'not-performed' };
await fs.writeFile(path.join(stage, 'vendor/composition.json'), JSON.stringify(composition, null, 2) + '\n');
const result = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], stage))[0];
if (result.files.some(f => path.isAbsolute(f.path) || f.path.split('/').includes('..'))) throw new Error('Package contains a path outside the assembled root.');
for (const required of ['vendor/rho-core', 'protocol/v1.json', 'protocol/v2.json', ...pluginPacks.packages.map(p => 'node_modules/' + p.package + '/dist/index.js')]) if (!result.files.some(f => f.path === required)) throw new Error('Package is missing ' + required);
for (const [id, dependency] of [['tables', 'csv-parse'], ['agent', '@modelcontextprotocol/sdk']]) {
  if (result.files.some(f => f.path === 'node_modules/' + dependency + '/package.json') !== selected.includes(id)) throw new Error('Optional dependency did not follow its plugin: ' + dependency);
}
if (result.files.some(f => /(^|\/)examples\//.test(f.path) || /\.R$/.test(f.path) || f.path.includes('@rho-workspace/headless'))) throw new Error('An aggregate package or project recipe leaked into the application.');
const artifact = path.join(destination, result.filename);
const report = { ...composition, artifact: { filename: result.filename, bytes: result.size, sha256: sha(await fs.readFile(artifact)), integrity: result.integrity, files: result.entryCount } };
await fs.writeFile(path.join(destination, 'composition.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ artifact, manifest: path.join(destination, 'composition.json'), sha256: report.artifact.sha256, files: result.entryCount }) + '\n');
