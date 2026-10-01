// Routine checks reuse the main workspace; source independence is an explicit audit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareAnnotationSource} from './build-annotation-plugin.mjs';

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
    // Exercise the actual package layout and its rewritten public SDK dependency.
    const {output: packageRoot, env: packageEnv} = prepareAnnotationSource(path.join(output, 'package'));
    if (independent) execFileSync(cargo, ['test', '-p', 'rho-annotation-store', '--test', 'annotations', '--locked', '--offline'], {cwd: packageRoot, env: packageEnv, stdio: 'inherit'});
    console.log(sourceOnly ? 'Annotation native package public source closure passed (six local crates); no compilation ran.' : 'Independent annotation owner/store checks passed; no Host or Agent source used.');
  } finally { fs.rmSync(output, {recursive: true, force: true}); }
}
