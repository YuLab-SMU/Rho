import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function buildProcessPlugin(destination, {workspace = true} = {}) {
  assert.ok(destination, 'Specify a new package directory outside the checkout');
  const output = path.join(fs.realpathSync(path.dirname(path.resolve(destination))), path.basename(destination));
  assert.ok(output !== root && !output.startsWith(root + path.sep), 'Use an independent source directory');
  fs.mkdirSync(output);
  for (const [from, to] of [['plugins/process', '.'], ['crates/process-engine', 'public/process-engine'], ['crates/plugin-protocol', 'public/plugin-protocol'], ['crates/plugin-sdk', 'public/plugin-sdk']])
    fs.cpSync(path.join(root, from), path.join(output, to), {recursive: true, filter: source => !/[\\/](?:target|dist|node_modules)(?:[\\/]|$)/.test(source)});
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  for (const [file, from, to] of [
    ['backend/owner/Cargo.toml', '../../../../crates/process-engine', '../../public/process-engine'],
    ['api/Cargo.toml', '../../../crates/plugin-protocol', '../public/plugin-protocol'],
    ['backend/owner/Cargo.toml', '../../../../crates/plugin-protocol', '../../public/plugin-protocol'],
    ['backend/Cargo.toml', '../../../crates/plugin-sdk', '../public/plugin-sdk'],
  ]) {
    const location = path.join(output, file), source = fs.readFileSync(location, 'utf8');
    assert.ok(source.includes(from), `Dependency layout changed: ${file}`);
    fs.writeFileSync(location, source.replace(from, to));
  }
  fs.writeFileSync(path.join(output, 'Cargo.toml'), '[workspace]\nresolver = "3"\nmembers = ["api", "backend", "public/process-engine", "backend/owner", "public/plugin-protocol", "public/plugin-sdk"]\n');
  fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(output, 'Cargo.lock'));
  const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], {encoding: 'utf8'}).trim());
  const env = {...process.env, RHO_PLUGIN_CARGO: installed('cargo'), RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'),
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '1', CARGO_TARGET_DIR: path.join(root, 'target')};
  const target = execFileSync(env.RUSTC, ['-vV'], {encoding: 'utf8'}).match(/^host: (.+)$/m)?.[1];
  assert.ok(target, 'Installed compiler did not identify its target');
  const metadata = JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'], {cwd: output, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
  const packages = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
  assert.deepEqual(packages.map(pkg => pkg.name).sort(), ['rho-plugin-protocol', 'rho-plugin-sdk', 'rho-process-api', 'rho-process-backend', 'rho-process-engine', 'rho-process-owner']);
  for (const pkg of packages) for (const dependency of pkg.dependencies) if (dependency.path)
    assert.ok(dependency.path.startsWith(output + path.sep), `${pkg.name}: dependency leaves standalone source`);
  if (workspace) execFileSync(env.RHO_PLUGIN_CARGO, ['build', '-p', 'rho-process-backend', '--bins', '--locked', '--offline'], {cwd: root, env, stdio: 'inherit'});
  execFileSync(process.execPath, [path.join(output, 'build.mjs'), ...(workspace ? ['--reuse-native'] : [])], {cwd: output, env, stdio: 'inherit'});
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length <= 4 && process.argv.slice(3).every(arg => ['--workspace', '--independent'].includes(arg)),
    'Usage: node scripts/build-process-plugin.mjs DEST [--workspace | --independent]');
  const workspace = !process.argv.includes('--independent');
  console.log(`${workspace ? 'Workspace-built' : 'Independent'} Process package: ${buildProcessPlugin(process.argv[2], {workspace})}`);
}
