import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pruneBundled } from './prune-bundled.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { core: { type: 'string', multiple: true }, 'core-source': { type: 'string' }, 'core-composition': { type: 'string' }, plugins: { type: 'string' }, destination: { type: 'string' }, 'allow-dirty': { type: 'boolean', default: false }, 'select-plugins': { type: 'string' } } });
if (!values.core?.length || !values['core-source']) throw new Error('Select --core [PLATFORM=]BINARY, once per platform, and --core-source REPOSITORY. The builds must already have completed.');
const pluginRoot = path.resolve(values.plugins ?? path.join(root, '../Rho-plugins'));
const coreRoot = path.resolve(values['core-source']);
const destination = path.resolve(values.destination ?? path.join(root, 'work/package-' + Date.now()));
const stage = path.join(destination, 'stage');
await fs.mkdir(destination, { recursive: true }); await fs.mkdir(stage);
// On Windows npm is a .cmd shim that only a shell can start; npm's own CLI runs under this node
// there: the one npm named when it started this script, else the one installed beside node.
const npmCli = /npm-cli\.js$/.test(process.env.npm_execpath ?? '') ? process.env.npm_execpath : process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : null;
function run(command, args, cwd) {
  if (command === 'npm' && npmCli) [command, args] = [process.execPath, [npmCli, ...args]];
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
const pluginIds = ['documents', 'files', 'r', 'requirements', 'tables', 'media', 'charts', 'agent', 'annotations', 'console', 'kernel', 'figures', 'skills'];
const selected = values['select-plugins'] === undefined ? pluginIds : values['select-plugins'].split(',').filter(Boolean);
if (new Set(selected).size !== selected.length || selected.some(id => !pluginIds.includes(id))) throw new Error('Select unique known plugin IDs.');
process.env.RHO_UI_PLUGINS = selected.join(',');
run('npm', ['run', 'build'], root);
const runtimeIds = (await import(pathToFileURL(path.join(root, 'dist/plugins.js')).href)).pluginIds;
if ([...runtimeIds].sort().join() !== [...pluginIds].sort().join()) throw new Error('The packed plugins differ from the application selection: ' + runtimeIds.join(','));
const application = await source(root, ['src', 'web', 'scripts', 'protocol', 'fixtures', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.web.json', 'vite.config.ts', 'ui-entries.json', 'ui-extensions.json', 'README.md', 'LICENSE', 'docs/HEADLESS.md', 'docs/COLLABORATION.md', 'docs/FRONTEND.md', 'docs/PLUGIN-AUTHORING.md']);
const uiSources=[...new Set((await import('./ui-selection.mjs')).selectedUiEntries().filter(e=>e.extension&&e.directory).map(e=>path.relative(pluginRoot,e.directory)).filter(p=>p&&!p.startsWith('..')&&!path.isAbsolute(p)))];
const plugins = await source(pluginRoot, ['packages/contracts', ...uiSources, ...selected.map(id => 'plugins/' + id), 'scripts', 'package.json', 'package-lock.json', 'LICENSE']);
// The descriptive inventory contains all reviewed owners, including owners
// physically omitted from a reduced package. Freeze those inputs too.
const catalogSource = await source(pluginRoot, ['packages/contracts', ...uiSources, ...pluginIds.map(id => 'plugins/' + id), 'scripts', 'package.json', 'package-lock.json', 'LICENSE']);
// One Core per platform, all built from the selected Core source. Each binary's own header
// must name the platform it is selected for, so a mislabelled build cannot be packed.
function executableTarget(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) return { platform: 'darwin', arch: { 0x0100000c: 'arm64', 0x01000007: 'x64' }[bytes.readUInt32LE(4)], format: 'mach-o' };
  if (bytes.length >= 64 && bytes.readUInt32BE(0) === 0x7f454c46 && bytes[4] === 2 && bytes[5] === 1) {
    const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
    let interpreter = false;
    for (let i = 0; i < count; i++) if (bytes.readUInt32LE(offset + i * size) === 3) interpreter = true;
    return { platform: 'linux', arch: { 0x3e: 'x64', 0xb7: 'arm64' }[bytes.readUInt16LE(18)], format: 'elf', linkage: interpreter ? 'dynamic' : 'static' };
  }
  if (bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d) {
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.length >= pe + 6 && bytes.readUInt32LE(pe) === 0x4550) return { platform: 'win32', arch: { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(pe + 4)], format: 'pe' };
  }
  return null;
}
const cores = [];
for (const selection of values.core) {
  const at = selection.indexOf('='), labelled = at > 0 && /^[a-z0-9]+-[a-z0-9]+$/.test(selection.slice(0, at));
  const platform = labelled ? selection.slice(0, at) : process.platform + '-' + process.arch, file = path.resolve(labelled ? selection.slice(at + 1) : selection);
  const bytes = await fs.readFile(file), target = executableTarget(bytes);
  if (!target || target.platform + '-' + target.arch !== platform) throw new Error('Core ' + file + ' is not a ' + platform + ' executable' + (target ? ' (it is ' + target.platform + '-' + target.arch + ').' : '.'));
  if (cores.some(c => c.platform === platform)) throw new Error('Select one Core per platform: ' + platform);
  const { format, linkage } = target;
  cores.push({ platform, bytes, record: { path: 'vendor/core/' + platform + '/' + (target.platform === 'win32' ? 'rho-core.exe' : 'rho-core'), sha256: sha(bytes), bytes: bytes.length, format, ...(linkage ? { linkage } : {}) } });
}
cores.sort((a, b) => a.platform.localeCompare(b.platform));
let core;
if (values['core-composition']) {
  const accepted = JSON.parse(await fs.readFile(path.resolve(values['core-composition']), 'utf8')), recorded = accepted.core;
  // Compositions before 0.5.2 recorded one artifact, for the platform that packed them.
  const known = recorded.artifacts ?? { [accepted.platform]: { sha256: recorded.artifactSha256, bytes: recorded.bytes } };
  if (recorded.repository !== 'https://github.com/YuLab-SMU/Rho-core' || recorded.localOverride || cores.some(c => known[c.platform]?.sha256 !== c.record.sha256 || known[c.platform]?.bytes !== c.record.bytes)) throw new Error('Selected binary does not match the accepted Core identity.');
  if (run('git', ['rev-parse', recorded.commit + '^{tree}'], coreRoot).trim() !== recorded.tree) throw new Error('Recorded Core tree is unavailable or mismatched.');
  const { artifacts, artifactSha256, bytes, ...identity } = recorded;
  core = { ...identity, buildAssociation: 'Digest-verified accepted public Core binaries reused; no local Core source changes selected.' };
// Core compiles its two contract documents in byte for byte (include_str!), so they are build inputs too.
} else core = { ...await source(coreRoot, ['src', 'Cargo.toml', 'Cargo.lock', 'LICENSE', 'docs/ACTIVITY.md', 'docs/MANAGED-RUN.md']), buildAssociation: 'Explicitly selected local builds of this source, one per platform; no reproducible-build or signing claim.' };
const pluginPacks = JSON.parse(run(process.execPath, [path.join(pluginRoot, 'scripts/pack.mjs'), '--destination', path.join(destination, 'plugins'), '--plugins', selected.join(',')], pluginRoot));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
for (const entry of manifest.files.filter(p => p !== 'vendor')) {
  try { await fs.cp(path.join(root, entry), path.join(stage, entry), { recursive: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
// npm shows the package's README on its page; it is not among `files`, so it is copied here.
await fs.copyFile(path.join(root, 'README.md'), path.join(stage, 'README.md'));
await fs.mkdir(path.join(stage, 'vendor'));
for (const item of pluginPacks.packages) {
  await fs.copyFile(path.join(pluginPacks.destination, item.filename), path.join(stage, 'vendor', item.filename));
}

for (const c of cores) {
  await fs.mkdir(path.join(stage, path.dirname(c.record.path)), { recursive: true });
  await fs.writeFile(path.join(stage, c.record.path), c.bytes, { mode: 0o755 });
}
await fs.writeFile(path.join(stage, 'vendor/CORE-LICENSE'), run('git', ['show', core.commit + ':LICENSE'], coreRoot));
for (const name of Object.keys(manifest.dependencies).filter(name => name.startsWith('@rho-workspace/plugin-'))) delete manifest.dependencies[name];
for (const item of pluginPacks.packages) manifest.dependencies[item.package] = 'file:vendor/' + item.filename;
manifest.bundleDependencies = Object.keys(manifest.dependencies);
delete manifest.devDependencies;
// The staged package is what a registry would receive; the source checkout itself stays private.
delete manifest.private; manifest.publishConfig = { access: 'public' };
manifest.scripts = { 'acceptance:collaboration': 'node scripts/collaboration-acceptance.mjs', 'acceptance:collaboration:agent': 'RHO_COLLAB_MODEL=1 node scripts/collaboration-acceptance.mjs', 'acceptance:ui': 'node scripts/ui-acceptance.mjs', 'acceptance:ui:u2': 'node scripts/u2-ui-acceptance.mjs', acceptance: 'node scripts/acceptance.mjs', recovery: 'node scripts/recovery-acceptance.mjs' };
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
// Agent clients are the person's own installation (--claude/--codex, RHO_CLAUDE/RHO_CODEX or
// PATH). The adapters' native clients are optional platform packages and stay out.
run('npm', ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
// Third-party packages keep the files Node loads, their licenses and the declarations Rho's own
// declarations reach; each further file slows an installation on Windows (prune-bundled.mjs).
const pruned = await pruneBundled(stage);
const web = JSON.parse(await fs.readFile(path.join(stage, 'dist/web/composition.json'), 'utf8'));
const catalogBytes = await fs.readFile(path.join(stage, 'dist/plugin-inventory.json'));
// A candidate packed by CI names the workflow run that built its Cores and packed it.
const e = process.env, build = e.GITHUB_ACTIONS === 'true' ? { system: 'github-actions', workflow: e.GITHUB_WORKFLOW_REF, run: e.GITHUB_SERVER_URL + '/' + e.GITHUB_REPOSITORY + '/actions/runs/' + e.GITHUB_RUN_ID, attempt: Number(e.GITHUB_RUN_ATTEMPT) } : { system: 'local' };
// Everything but Core is platform-neutral JavaScript, so the package serves each Core's platform.
const composition = { schemaVersion: 2, platforms: cores.map(c => c.platform), packedOn: process.platform + '-' + process.arch, node: process.version, build, application: { repository: 'https://github.com/YuLab-SMU/Rho', ...application }, plugins: { repository: 'https://github.com/YuLab-SMU/Rho-plugins', ...plugins, selected, uiSources, packages: pluginPacks.packages.map(({ files, ...item }) => item) }, catalog: { path: 'dist/plugin-inventory.json', sha256: sha(catalogBytes), bytes: catalogBytes.length, source: catalogSource, scope: 'Descriptive inventory of the reviewed owners; contributes no runtime entry or authority.' }, core: { repository: 'https://github.com/YuLab-SMU/Rho-core', ...core, artifacts: Object.fromEntries(cores.map(c => [c.platform, c.record])) }, web, productionLockSha256: sha(await fs.readFile(path.join(stage, 'package-lock.json'))), bundledPruning: { declarationsKept: pruned.typed, scope: 'Third-party declarations, source maps, TypeScript sources, tests, examples, documentation and tool configuration; license texts, entries and first-party packages kept.' }, agentClients: { bundled: false, selection: ['--claude/--codex', 'RHO_CLAUDE/RHO_CODEX', 'PATH'] }, distribution: 'unsigned-local-npm-tarball', registryPublication: 'not-performed' };
await fs.writeFile(path.join(stage, 'vendor/composition.json'), JSON.stringify(composition, null, 2) + '\n');
const result = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], stage))[0];
if (result.files.some(f => path.isAbsolute(f.path) || f.path.split('/').includes('..'))) throw new Error('Package contains a path outside the assembled root.');
for (const required of [...cores.map(c => c.record.path), 'README.md', 'skills/rho/SKILL.md', 'protocol/index.json', 'fixtures/states.json', 'dist/web/index.html', 'dist/web/composition.json', 'dist/web/licenses.md', ...web.assets.map(a => 'dist/web/' + a.path), ...pluginPacks.packages.map(p => 'node_modules/' + p.package + '/dist/index.js')]) if (!result.files.some(f => f.path === required)) throw new Error('Package is missing ' + required);
for (const [id, dependency] of [['tables', 'csv-parse'], ['agent', '@modelcontextprotocol/sdk'], ['agent', '@agentclientprotocol/sdk'], ['agent', '@agentclientprotocol/claude-agent-acp'], ['agent', '@agentclientprotocol/codex-acp'], ['agent', '@openai/codex']]) {
  if (result.files.some(f => f.path === 'node_modules/' + dependency + '/package.json') !== selected.includes(id)) throw new Error('Optional dependency did not follow its plugin: ' + dependency);
}
if (result.files.some(f => /(^|\/)node_modules\/(@openai\/codex-|@anthropic-ai\/claude-agent-sdk-)[^/]+\//.test(f.path))) throw new Error('A native Agent client entered the package.');
if (result.files.some(f => f.path.endsWith('.node'))) throw new Error('A native Node addon entered the package; it would bind the package to the packing platform.');
const firstParty = file => !file.startsWith('node_modules/') || file.startsWith('node_modules/@rho-workspace/');
// The project Rho ships (example/) is an ordinary project with its own R scripts; besides it only
// the Notebook's runner and the R file its sessions source to describe plots enter.
const shippedR = file => ['node_modules/@rho-workspace/plugin-kernel/runners/runner.R', 'node_modules/@rho-workspace/plugin-figures/r/figures.R'].includes(file) || file.startsWith('example/');
if (result.files.some(f => (firstParty(f.path) && /(^|\/)examples\//.test(f.path)) || (/\.R$/.test(f.path) && !shippedR(f.path)) || f.path.includes('@rho-workspace/headless'))) throw new Error('An aggregate package or project recipe leaked into the application.');
const artifact = path.join(destination, result.filename);
const report = { ...composition, artifact: { filename: result.filename, bytes: result.size, sha256: sha(await fs.readFile(artifact)), integrity: result.integrity, files: result.entryCount } };
await fs.writeFile(path.join(destination, 'composition.json'), JSON.stringify(report, null, 2) + '\n');
await fs.writeFile(path.join(destination, 'SHA256SUMS'), report.artifact.sha256 + '  ' + result.filename + '\n');
process.stdout.write(JSON.stringify({ artifact, manifest: path.join(destination, 'composition.json'), sha256: report.artifact.sha256, files: result.entryCount }) + '\n');
