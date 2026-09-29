// Portable local delivery. Installation uses the same ordinary plugin repository;
// Workbench startup never calls this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {defaultPlugins, verifyPluginSet, installPluginSet} from './plugin-set.mjs';

export const bundleFiles = ['rho', 'rho-bundle.mjs', 'plugin-set.mjs', 'plugin-set.json', 'GETTING-STARTED.md', 'LICENSE', 'LICENSES.md'];
export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const maxFileBytes = 512 * 1024 * 1024;
function fields(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected/missing bundle fields');
}
export function regular(file, limit = maxFileBytes) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit, `Invalid or oversized bundle file: ${file}`);
  return stat;
}
export function arm64Executable(file) {
  regular(file);
  const descriptor = fs.openSync(file, 'r'), header = Buffer.alloc(16);
  try { assert.equal(fs.readSync(descriptor, header, 0, 16, 0), 16); }
  finally { fs.closeSync(descriptor); }
  assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'Expected a macOS 64-bit executable');
  assert.equal(header.readUInt32LE(4), 0x0100000c, 'Expected a macOS arm64 executable');
  assert.equal(header.readUInt32LE(12), 2, 'Expected MH_EXECUTE');
  fs.accessSync(file, fs.constants.X_OK);
}
export function deliveryIndex(directory) {
  const file = path.join(directory, 'plugin-set.json'); regular(file, 65536);
  const set = JSON.parse(fs.readFileSync(file));
  assert.equal(set.profile, 'rho-default', 'Bundle requires the default sixteen-plugin set');
  assert.deepEqual(set.packages.map(p => p.plugin).sort(), [...defaultPlugins].sort());
  for (const entry of set.packages) {
    assert.match(entry.file, /^[a-z0-9][a-z0-9._-]*\.rho-plugin$/);
    assert.ok(entry.artifacts.length > 0, 'Every delivered plugin needs a built artifact');
    assert.ok(entry.artifacts.every(a => ['ui-web', 'aarch64-apple-darwin'].includes(a.target)), 'Artifact does not match the bundle target');
  }
  return set;
}
function manifestAt(directory) {
  regular(path.join(directory, 'rho-bundle.json'), 65536);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'rho-bundle.json')));
  fields(manifest, ['format', 'target', 'kind', 'assembly_checkout', 'core_source_commit', 'files']);
  assert.equal(manifest.format, 1);
  assert.equal(manifest.target, 'aarch64-apple-darwin');
  assert.equal(manifest.kind, 'local-development');
  fields(manifest.assembly_checkout, ['commit', 'dirty']);
  assert.match(manifest.assembly_checkout.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof manifest.assembly_checkout.dirty, 'boolean');
  // A retained core binary's source commit cannot be inferred from this checkout.
  assert.equal(manifest.core_source_commit, null);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === bundleFiles.length + 16);
  const names = new Set();
  for (const entry of manifest.files) {
    fields(entry, ['file', 'bytes', 'sha256', 'executable']);
    assert.ok(bundleFiles.includes(entry.file) || /^[a-z0-9][a-z0-9._-]*\.rho-plugin$/.test(entry.file), 'File must be a known contained basename');
    assert.ok(!names.has(entry.file), 'Duplicate bundle file'); names.add(entry.file);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= maxFileBytes);
    assert.match(entry.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(entry.executable, entry.file === 'rho');
  }
  for (const file of bundleFiles) assert.ok(names.has(file), `Missing bundle file: ${file}`);
  return manifest;
}
function pinned(directory, work) {
  assert.equal(process.platform, 'darwin', 'This local preview supports macOS only');
  assert.equal(process.arch, 'arm64', 'This local preview supports Apple Silicon only');
  const root = fs.realpathSync(directory), manifest = manifestAt(root);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-bundle-verified-'));
  try {
    for (const entry of manifest.files) {
      const source = path.join(root, entry.file), destination = path.join(staging, entry.file);
      assert.equal(regular(source).size, entry.bytes, 'Bundle file size changed');
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
      assert.equal(regular(destination).size, entry.bytes);
      assert.equal(sha256(fs.readFileSync(destination)), entry.sha256, 'Bundle file digest changed');
      fs.chmodSync(destination, entry.executable ? 0o700 : 0o600);
    }
    const set = deliveryIndex(staging);
    assert.deepEqual(manifest.files.map(e => e.file).sort(), [...bundleFiles, ...set.packages.map(e => e.file)].sort());
    for (const entry of set.packages) {
      const file = manifest.files.find(file => file.file === entry.file);
      assert.equal(file.bytes, entry.bytes); assert.equal(file.sha256, entry.sha256);
    }
    arm64Executable(path.join(staging, 'rho'));
    return work({root: staging, manifest});
  } finally { fs.rmSync(staging, {recursive: true, force: true}); }
}
export function verifyBundle({directory}) {
  return pinned(directory, ({root, manifest}) => ({status: 'verified', manifest,
    plugins: verifyPluginSet({rho: path.join(root, 'rho'), directory: root})}));
}
export function installBundle({directory, database}) {
  assert.ok(typeof database === 'string' && path.isAbsolute(database), 'Choose an explicit absolute database path');
  return pinned(directory, ({root, manifest}) => ({...installPluginSet({rho: path.join(root, 'rho'), directory: root, database}),
    core_sha256: manifest.files.find(file => file.file === 'rho').sha256}));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Use an existing Node.js 22 or newer');
    const [command, ...args] = process.argv.slice(2), options = {};
    assert.ok(['verify', 'install'].includes(command), 'Usage: node rho-bundle.mjs verify|install [--bundle DIRECTORY] [--database ABSOLUTE_PATH]');
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(['--bundle', ...(command === 'install' ? ['--database'] : [])].includes(args[i]) &&
        !(args[i] in options) && args[i + 1] && !args[i + 1].startsWith('--'), 'Invalid or duplicate bundle option');
      options[args[i]] = args[i + 1];
    }
    const directory = options['--bundle'] ?? path.dirname(fileURLToPath(import.meta.url));
    const result = command === 'verify' ? verifyBundle({directory}) : installBundle({directory, database: options['--database']});
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({error: error.message, installation: error.installation ?? null})); process.exitCode = 1;
  }
}
