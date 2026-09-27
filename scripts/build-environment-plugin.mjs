import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function buildEnvironmentPlugin(destination) {
  assert.ok(destination, 'Specify a new package directory outside the checkout');
  const output = path.join(fs.realpathSync(path.dirname(path.resolve(destination))), path.basename(destination));
  assert.ok(output !== root && !output.startsWith(root + path.sep), 'Use an independent source directory');
  fs.mkdirSync(output);
  for (const [from, to] of [['plugins/environment', '.'], ['plugins/r/api', 'r/api'], ['plugins/process/api', 'process/api'], ['plugins/process/backend/engine', 'process/backend/engine'], ['plugins/process/backend/owner', 'process/backend/owner'], ['crates/plugin-protocol', 'public/plugin-protocol'], ['crates/plugin-sdk', 'public/plugin-sdk']])
    fs.cpSync(path.join(root, from), path.join(output, to), {recursive: true, filter: source => !/[\\/](?:target|dist|node_modules|__pycache__)(?:[\\/]|$)/.test(source)});
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  for (const [file, from, to] of [
    ['api/Cargo.toml', '../../../crates/plugin-protocol', '../public/plugin-protocol'],
    ['api/Cargo.toml', '../../process/api', '../process/api'],
    ['backend/owner/Cargo.toml', '../../../process/', '../../process/'],
    ['backend/Cargo.toml', '../../../crates/plugin-sdk', '../public/plugin-sdk'],
    ['backend/Cargo.toml', '../../process/api', '../process/api'],
    ['backend/Cargo.toml', '../../r/api', '../r/api'],
    ['r/api/Cargo.toml', '../../../crates/plugin-protocol', '../../public/plugin-protocol'],
    ['process/backend/owner/Cargo.toml', '../../../../crates/plugin-protocol', '../../../public/plugin-protocol'],
    ['process/api/Cargo.toml', '../../../crates/plugin-protocol', '../../public/plugin-protocol'],
  ]) {
    const location = path.join(output, file), source = fs.readFileSync(location, 'utf8');
    assert.ok(source.includes(from), `Dependency layout changed: ${file}`);
    fs.writeFileSync(location, source.replaceAll(from, to));
  }
  fs.writeFileSync(path.join(output, 'Cargo.toml'), '[workspace]\nresolver = "3"\nmembers = ["api", "r/api", "backend", "backend/owner", "process/api", "process/backend/engine", "process/backend/owner", "public/plugin-protocol", "public/plugin-sdk"]\n');
  fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(output, 'Cargo.lock'));
  const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], {encoding: 'utf8'}).trim());
  const env = {...process.env, RHO_PLUGIN_CARGO: installed('cargo'), RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'), CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4', CARGO_TARGET_DIR: path.join(root, 'target')};
  const target = execFileSync(env.RUSTC, ['-vV'], {encoding: 'utf8'}).match(/^host: (.+)$/m)?.[1]; assert.ok(target);
  const metadata = JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'], {cwd: output, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
  const packages = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
  assert.deepEqual(packages.map(pkg => pkg.name).sort(), ['rho-environment-api', 'rho-environment-backend', 'rho-environment-owner', 'rho-plugin-protocol', 'rho-plugin-sdk', 'rho-process-api', 'rho-process-engine', 'rho-process-owner', 'rho-r-api']);
  for (const pkg of packages) for (const dependency of pkg.dependencies) if (dependency.path) assert.ok(dependency.path.startsWith(output + path.sep), `${pkg.name}: dependency leaves standalone source`);
  execFileSync(process.execPath, [path.join(output, 'build.mjs')], {cwd: output, env, stdio: 'inherit'});
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Independent Environment package: ${buildEnvironmentPlugin(process.argv[2])}`);
