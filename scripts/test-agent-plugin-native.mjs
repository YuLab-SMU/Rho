// Run the native Agent scheduler outside the checkout using only public package sources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-native-')));
try {
  for (const source of ['api', 'backend/owner', 'backend/store', 'backend/client', 'backend/native']) {
    const destination = path.join(output, 'plugins/agent', source);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.cpSync(path.join(root, 'plugins/agent', source), destination, {recursive: true});
  }
  for (const source of ['crates/plugin-protocol', 'plugins/r/api']) {
    fs.cpSync(path.join(root, source), path.join(output, source), {recursive: true});
  }
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(output, 'Cargo.lock'));
  fs.writeFileSync(path.join(output, 'Cargo.toml'), '[workspace]\nresolver = "3"\nmembers = ["plugins/agent/api", "plugins/agent/backend/owner", "plugins/agent/backend/store", "plugins/agent/backend/client", "plugins/agent/backend/native", "crates/plugin-protocol", "plugins/r/api"]\n');
  const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], {encoding: 'utf8'}).trim());
  const env = {...process.env, RHO_PLUGIN_CARGO: installed('cargo'), RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'), CARGO_TARGET_DIR: path.join(root, 'target')};
  const target = execFileSync(env.RUSTC, ['-vV'], {encoding: 'utf8'}).match(/^host: (.+)$/m)?.[1];
  assert.ok(target);
  // Cargo prunes the copied production lock to this independent workspace.
  const metadata = JSON.parse(execFileSync(env.RHO_PLUGIN_CARGO, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'], {cwd: output, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
  const packages = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
  assert.deepEqual(packages.map(pkg => pkg.name).sort(), ['rho-agent-api', 'rho-agent-client', 'rho-agent-native', 'rho-agent-owner', 'rho-agent-store', 'rho-plugin-protocol', 'rho-r-api']);
  for (const pkg of metadata.packages) {
    if (!pkg.source) assert.ok(pkg.manifest_path.startsWith(output + path.sep), `${pkg.name}: source leaves the independent package`);
    for (const dependency of pkg.dependencies) if (dependency.path)
      assert.ok(dependency.path.startsWith(output + path.sep), `${pkg.name}: dependency leaves the independent package`);
  }
  execFileSync(env.RHO_PLUGIN_CARGO, ['test', '-p', 'rho-agent-native', '--lib', '--locked', '--offline'], {cwd: output, env, stdio: 'inherit'});
  console.log('Independent native Agent scheduling, receipt recovery and connection cleanup passed without private core source or a core database connection.');
} finally {
  fs.rmSync(output, {recursive: true, force: true});
}
