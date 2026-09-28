// Run the native Agent transport outside the checkout using only public source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-native-')));
try {
  fs.cpSync(path.join(root, 'plugins/agent'), output, {
    recursive: true,
    filter: source => !/[\\/](?:target|dist|node_modules)(?:[\\/]|$)/.test(source),
  });
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(output, 'Cargo.lock'));
  fs.writeFileSync(path.join(output, 'Cargo.toml'), '[workspace]\nresolver = "3"\nmembers = ["api", "backend/client"]\n');
  const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], {encoding: 'utf8'}).trim());
  const env = {...process.env, RHO_PLUGIN_CARGO: installed('cargo'), RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'), CARGO_TARGET_DIR: path.join(root, 'target')};
  const target = execFileSync(env.RUSTC, ['-vV'], {encoding: 'utf8'}).match(/^host: (.+)$/m)?.[1];
  assert.ok(target);
  // Cargo prunes the copied production lock to this independent workspace.
  const metadata = JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'], {cwd: output, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
  const packages = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
  assert.deepEqual(packages.map(pkg => pkg.name).sort(), ['rho-agent-api', 'rho-agent-client']);
  for (const pkg of metadata.packages) {
    if (!pkg.source) assert.ok(pkg.manifest_path.startsWith(output + path.sep), `${pkg.name}: source leaves the independent package`);
    for (const dependency of pkg.dependencies) if (dependency.path)
      assert.ok(dependency.path.startsWith(output + path.sep), `${pkg.name}: dependency leaves the independent package`);
  }
  execFileSync(env.RHO_PLUGIN_CARGO, ['test', '-p', 'rho-agent-client', '--lib', '--locked', '--offline'], {cwd: output, env, stdio: 'inherit'});
  execFileSync(process.execPath, [path.join(output, 'generate-sdk.mjs'), '--check'], {cwd: output, env, stdio: 'inherit'});
  console.log('Independent Agent transport protocol/recovery tests and public schemas passed without private core source.');
} finally {
  fs.rmSync(output, {recursive: true, force: true});
}
