import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.argv[2], 'Specify a new directory outside the checkout');
assert.ok(process.argv.slice(3).every(arg => ['--workspace', '--independent'].includes(arg)) && process.argv.length <= 4,
  'Usage: node scripts/build-files-plugin.mjs DEST [--workspace | --independent]');
const workspaceBuild = !process.argv.includes('--independent');
const output = path.join(fs.realpathSync(path.dirname(path.resolve(process.argv[2]))), path.basename(process.argv[2]));
assert.ok(output !== root && !output.startsWith(root + path.sep), 'Use a standalone directory');
fs.mkdirSync(output);
for (const [from, to] of [['plugins/agent/sdk/component-input','public/agent-input'],['plugins/files', '.'], ['crates/process-engine', 'public/process-engine'], ['crates/plugin-protocol', 'public/plugin-protocol'], ['crates/plugin-sdk', 'public/plugin-sdk'], ['sdk/plugin-ui', 'public/plugin-ui'], ['sdk/plugin-protocol', 'public/plugin-protocol']]) {
  fs.cpSync(path.join(root, from), path.join(output, to), { recursive: true, filter: file => !/[\\/](?:target|dist|node_modules)(?:[\\/]|$)/.test(file) });
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
for (const [file, from, to] of [
  ['backend/Cargo.toml', '../../../crates/plugin-sdk', '../public/plugin-sdk'],
  ['backend/engine/Cargo.toml', '../../../../crates/process-engine', '../../public/process-engine'],
]) {
  const location = path.join(output, file), source = fs.readFileSync(location, 'utf8');
  assert.ok(source.includes(from), `Dependency layout changed: ${file}`);
  fs.writeFileSync(location, source.replace(from, to));
}
fs.writeFileSync(path.join(output, 'Cargo.toml'), '[workspace]\nresolver = "3"\nmembers = ["api", "backend", "backend/engine", "backend/owner", "public/process-engine", "public/plugin-protocol", "public/plugin-sdk"]\n');
fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(output, 'Cargo.lock'));
const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], { cwd: root, encoding: 'utf8' }).trim());
const env = { ...process.env, RHO_PLUGIN_CARGO: installed('cargo'), RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'), RHO_PLUGIN_NODE_MODULES: path.join(root, 'ui/node_modules'), CARGO_BUILD_JOBS: '1', CARGO_TARGET_DIR: path.join(root, 'target') };
const target = execFileSync(env.RUSTC, ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
assert.ok(target, 'Installed compiler did not identify its target');
const metadata = JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'], { cwd: output, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const packages = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
assert.deepEqual(packages.map(pkg => pkg.name).sort(), ['rho-files-api', 'rho-files-backend', 'rho-files-engine', 'rho-files-owner', 'rho-plugin-protocol', 'rho-plugin-sdk', 'rho-process-engine']);
for (const pkg of packages) for (const dependency of pkg.dependencies) if (dependency.path) {
  assert.ok(dependency.path.startsWith(output + path.sep), `${pkg.name}: dependency leaves standalone source`);
}
if (workspaceBuild) {
  // Rapid iteration reuses Cargo's primary checkout cache. The delivered source
  // closure and immutable artifact still go through normal repository capture.
  // This mode is integration evidence, not independent-source build acceptance.
  execFileSync(env.RHO_PLUGIN_CARGO, ['build', '--locked', '-p', 'rho-files-backend', '--bins'], { cwd: root, env, stdio: 'inherit' });
  execFileSync(path.join(root, 'target/debug/export-files-manifest'), [path.join(output, 'plugin.json')], { cwd: root, env, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(output, 'build-ui.mjs')], { cwd: output, env, stdio: 'inherit' });
  fs.copyFileSync(path.join(root, 'target/debug/rho-files-backend'), path.join(output, 'dist/rho-files-backend'));
  fs.chmodSync(path.join(output, 'dist/rho-files-backend'), 0o755);
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), 'Package source cannot contain symlinks');
    if (['target', 'dist', 'node_modules', '.git'].includes(entry.name)) return [];
    const location = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(location) : [path.relative(output, location).split(path.sep).join('/')];
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'plugin.json'), 'utf8'));
  manifest.source.files = walk(output).filter(file => file !== 'plugin.json' && !manifest.source.lockfiles.includes(file)).sort();
  fs.writeFileSync(path.join(output, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
} else execFileSync(process.execPath, [path.join(output, 'build.mjs')], { cwd: output, env, stdio: 'inherit' });
console.log(`${workspaceBuild ? 'Workspace-built' : 'Independent'} Files source and native artifact: ${output}`);
