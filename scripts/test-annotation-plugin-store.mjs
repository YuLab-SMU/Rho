// Routine checks reuse the main workspace; source independence is an explicit audit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(args.every(arg => ['--source-check', '--independent'].includes(arg)), 'Unknown annotation test argument');
assert.ok(args.length <= 1, 'Select one annotation test mode');
const sourceOnly = args.includes('--source-check');
const independent = args.includes('--independent');
const installed = name => fs.realpathSync(execFileSync('rustup', ['which', name], {encoding: 'utf8'}).trim());
const cargo = installed('cargo');
const env = {...process.env, RUSTC: installed('rustc'), RUSTDOC: installed('rustdoc'), CARGO_TARGET_DIR: path.join(root, 'target')};
if (!sourceOnly && !independent) {
  execFileSync(cargo, ['test', '-p', 'rho-annotation-store', '--test', 'annotations', '--locked'], {cwd: root, env, stdio: 'inherit'});
} else {
  const output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-annotation-source-')));
  try {
    for (const source of ['api', 'backend/owner', 'backend/store']) {
      const destination = path.join(output, 'plugins/annotations', source);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.cpSync(path.join(root, 'plugins/annotations', source), destination, {recursive: true});
    }
    for (const file of ['LICENSE', 'Cargo.lock']) fs.copyFileSync(path.join(root, file), path.join(output, file));
    fs.writeFileSync(path.join(output, 'Cargo.toml'), '[workspace]\nresolver = "3"\nmembers = ["plugins/annotations/api", "plugins/annotations/backend/owner", "plugins/annotations/backend/store"]\n');
    // Metadata prunes only the copied lock. It does not compile or mutate the repository lock.
    const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--offline', '--format-version', '1'], {cwd: output, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));
    const local = metadata.packages.filter(pkg => !pkg.source);
    assert.deepEqual(local.map(pkg => pkg.name).sort(), ['rho-annotation-api', 'rho-annotation-owner', 'rho-annotation-store']);
    for (const pkg of local) {
      assert.ok(pkg.manifest_path.startsWith(output + path.sep), `${pkg.name}: manifest escapes public source`);
      for (const dep of pkg.dependencies) if (dep.path) assert.ok(dep.path.startsWith(output + path.sep), `${pkg.name}: dependency escapes public source`);
    }
    if (independent) execFileSync(cargo, ['test', '-p', 'rho-annotation-store', '--test', 'annotations', '--locked', '--offline'], {cwd: output, env, stdio: 'inherit'});
    console.log(sourceOnly ? 'Annotation public source closure passed; no compilation ran.' : 'Independent annotation owner/store checks passed; no Host or Agent source used.');
  } finally { fs.rmSync(output, {recursive: true, force: true}); }
}
