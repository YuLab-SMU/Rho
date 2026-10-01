import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export function run(command, args, cwd = root, env = process.env) {
  execFileSync(command, args, {cwd, env, stdio: 'inherit'});
}
export function repositories() {
  const local = fs.existsSync(path.join(root, '.rho-dev.json')) ? readJson(path.join(root, '.rho-dev.json')) : {};
  return {app: root,
    core: path.resolve(root, process.env.RHO_CORE_REPO ?? local.core ?? '../Rho-core'),
    plugins: path.resolve(root, process.env.RHO_PLUGINS_REPO ?? local.plugins ?? '../Rho-plugins')};
}
export function sourceIdentity(directory) {
  const git = (...args) => execFileSync('git', args, {cwd: directory, encoding: 'utf8'});
  const names = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))].sort();
  const files = names.map(name => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return [name, null];
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Source must be a regular file: ${name}`);
    return [name, stat.mode & 0o111, hash(fs.readFileSync(file))];
  });
  return {revision: git('rev-parse', 'HEAD').trim(), dirty: Boolean(git('status', '--porcelain').trim()),
    sha256: hash(JSON.stringify(files))};
}
export function treeFiles(directory) {
  const files = [];
  function visit(relative) {
    const file = path.join(directory, relative), stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink(), `Artifact contains a symlink: ${relative}`);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.posix.join(relative, name));
    else {
      assert.ok(stat.isFile()); const bytes = fs.readFileSync(file);
      files.push({path: relative, bytes: bytes.length, sha256: hash(bytes), executable: Boolean(stat.mode & 0o111)});
    }
  }
  visit(''); return files;
}
export function applicationInputs() {
  const trees = ['ui/src', 'sdk'].map(directory => [directory, treeFiles(path.join(root, directory))]);
  const files = ['ui/index.html', 'ui/vite.config.ts', 'ui/tsconfig.json', 'ui/package.json',
    'ui/package-lock.json', 'scripts/client.mjs'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]);
  return hash(JSON.stringify({trees, files}));
}
export function coreArtifact({local = false} = {}) {
  const receipt = readJson(path.join(root, 'target/core.json'));
  const file = path.resolve(root, receipt.file);
  assert.equal(hash(fs.readFileSync(file)), receipt.sha256, 'Retained core binary changed');
  if (!local) {
    const lock = readJson(path.join(root, 'rho.lock.json'));
    assert.equal(receipt.source.revision, lock.core.revision, 'Core differs from lock; select --local explicitly or build the pinned revision');
    assert.equal(receipt.source.dirty, false, 'Core has local changes; select --local explicitly');
  }
  return {...receipt, absolute: file};
}
