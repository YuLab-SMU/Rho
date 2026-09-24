import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.argv[2], 'Specify a new directory outside the checkout');
const output = path.join(fs.realpathSync(path.dirname(path.resolve(process.argv[2]))), path.basename(process.argv[2]));
assert.ok(output !== root && !output.startsWith(root + path.sep), 'Use a standalone directory');
fs.mkdirSync(output);
for (const [from, to] of [['plugins/files', '.'], ['plugins/process/api', 'process/api'], ['plugins/process/backend/engine', 'process/backend/engine'], ['crates/plugin-protocol', 'public/plugin-protocol'], ['crates/plugin-sdk', 'public/plugin-sdk']]) {
  fs.cpSync(path.join(root, from), path.join(output, to), { recursive: true, filter: file => !/[\\/](?:target|dist|node_modules)(?:[\\/]|$)/.test(file) });
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
for (const [file, from, to] of [
  ['backend/Cargo.toml', '../../../crates/plugin-sdk', '../public/plugin-sdk'],
  ['backend/engine/Cargo.toml', '../../../process/backend/engine', '../../process/backend/engine'],
]) {
  const location = path.join(output, file), source = fs.readFileSync(location, 'utf8');
  assert.ok(source.includes(from), `Dependency layout changed: ${file}`);
  fs.writeFileSync(location, source.replace(from, to));
}
fs.writeFileSync(path.join(output, 'Cargo.toml'), '[workspace]\nresolver = "3"\nmembers = ["api", "backend", "backend/engine", "backend/owner", "process/api", "process/backend/engine", "public/plugin-protocol", "public/plugin-sdk"]\n');
fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(output, 'Cargo.lock'));
const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], { cwd: root, encoding: 'utf8' }).trim());
const env = { ...process.env, RHO_PLUGIN_CARGO: installed('cargo'), RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'), CARGO_BUILD_JOBS: '1', CARGO_TARGET_DIR: path.join(root, 'target') };
const target = execFileSync(env.RUSTC, ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
assert.ok(target, 'Installed compiler did not identify its target');
const metadata = JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'], { cwd: output, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const packages = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
assert.deepEqual(packages.map(pkg => pkg.name).sort(), ['rho-files-api', 'rho-files-backend', 'rho-files-engine', 'rho-files-owner', 'rho-plugin-protocol', 'rho-plugin-sdk', 'rho-process-api', 'rho-process-engine']);
for (const pkg of packages) for (const dependency of pkg.dependencies) if (dependency.path) {
  assert.ok(dependency.path.startsWith(output + path.sep), `${pkg.name}: dependency leaves standalone source`);
}
execFileSync(process.execPath, [path.join(output, 'build.mjs')], { cwd: output, env, stdio: 'inherit' });
console.log(`Independent Files source and native artifact: ${output}`);
