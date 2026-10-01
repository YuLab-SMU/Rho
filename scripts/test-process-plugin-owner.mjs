import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], {encoding: 'utf8'}).trim());
const cargo = installed('cargo');
const env = {...process.env, RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'),
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4', CARGO_TARGET_DIR: path.join(root, 'target')};
const target = execFileSync(env.RUSTC, ['-vV'], {encoding: 'utf8'}).match(/^host: (.+)$/m)?.[1];
assert.ok(target, 'The installed compiler did not identify its target');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-process-owner-')));
let complete = false;
try {
  const sources = ['plugins/process/api', 'crates/process-engine', 'plugins/process/backend/owner', 'crates/plugin-protocol'];
  for (const source of sources) fs.cpSync(path.join(root, source), path.join(temporary, source), {
    recursive: true, filter: file => !/[\\/](?:target|node_modules|dist)(?:[\\/]|$)/.test(file),
  });
  fs.writeFileSync(path.join(temporary, 'Cargo.toml'), `[workspace]\nresolver = "3"\nmembers = ${JSON.stringify(sources)}\n`);
  fs.copyFileSync(path.join(root, 'Cargo.lock'), path.join(temporary, 'Cargo.lock'));
  const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--offline', '--filter-platform', target, '--format-version', '1'],
    {cwd: temporary, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
  const members = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
  assert.deepEqual(members.map(pkg => pkg.name).sort(), ['rho-plugin-protocol', 'rho-process-api', 'rho-process-engine', 'rho-process-owner']);
  for (const pkg of members) for (const dep of pkg.dependencies) if (dep.path)
    assert.ok(dep.path.startsWith(temporary + path.sep), `${pkg.name}: dependency leaves standalone source`);
  execFileSync(cargo, ['test', '-p', 'rho-process-owner', '--lib', '--locked', '--offline'],
    {cwd: temporary, env, stdio: 'inherit'});
  complete = true;
  console.log('Independent process owner and native recovery passed without private core source.');
} finally {
  if (complete) fs.rmSync(temporary, {recursive: true, force: true});
  else console.error(`Independent process source retained at ${temporary}`);
}
