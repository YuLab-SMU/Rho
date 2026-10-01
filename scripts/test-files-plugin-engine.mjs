import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], { cwd: root, encoding: 'utf8' }).trim());
const cargo = installed('cargo');
const env = { ...process.env, RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'), CARGO_BUILD_JOBS: '1', CARGO_TARGET_DIR: path.join(root, 'target') };
const target = execFileSync(env.RUSTC, ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
assert.ok(target, 'The installed compiler did not identify its native target');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-independent-files-')));
let complete = false;
try {
  for (const part of ['plugins/files/api', 'plugins/files/backend/engine', 'plugins/files/backend/owner', 'crates/process-engine', 'crates/plugin-protocol']) {
    fs.cpSync(path.join(root, part), path.join(temporary, part), {
      recursive: true, filter: file => !/[\\/](?:target|node_modules|dist)(?:[\\/]|$)/.test(file),
    });
  }
  fs.writeFileSync(path.join(temporary, 'Cargo.toml'), '[workspace]\nresolver = "3"\nmembers = ["plugins/files/api", "plugins/files/backend/engine", "plugins/files/backend/owner", "crates/process-engine", "crates/plugin-protocol"]\n');
  fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(temporary, 'Cargo.lock'));
  // Resolve only this standalone closure offline. Subsequent compilation is locked.
  const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'], { cwd: temporary, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const members = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
  assert.deepEqual(members.map(pkg => pkg.name).sort(), ['rho-files-api', 'rho-files-engine', 'rho-files-owner', 'rho-plugin-protocol', 'rho-process-engine']);
  for (const pkg of members) for (const dep of pkg.dependencies) if (dep.path) {
    assert.ok(dep.path.startsWith(temporary + path.sep), `${pkg.name}: dependency leaves standalone source`);
  }
  execFileSync(cargo, ['test', '-p', 'rho-files-engine', '-p', 'rho-files-owner', '-p', 'rho-process-engine', '--lib', '--tests', '--locked', '--offline'], { cwd: temporary, env, stdio: 'inherit' });
  complete = true;
  console.log('Independent Files/Git and process supervision passed without private core source.');
} finally {
  if (complete) fs.rmSync(temporary, { recursive: true, force: true });
  else console.error(`Independent Files source retained at ${temporary}`);
}
