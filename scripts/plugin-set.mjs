// Distribution assembly only. Every archive uses the ordinary CLI repository;
// this tool is never called by Workbench startup or plugin activation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const defaultPlugins = ['agent', 'annotations', 'console', 'editor', 'environment',
  'files', 'help', 'manager', 'objects', 'packages', 'plots', 'process', 'r', 'remote',
  'studio', 'viewer'].map(id => `org.rho.${id}`);
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxArchiveBytes = Math.floor(256 * 1024 * 1024 * 4 / 3) + 16 * 1024 * 1024;
function fields(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected/missing fields');
}
function read(file, limit) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, `Invalid or oversized file: ${file}`);
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length <= limit, `File grew past its limit: ${file}`);
  return bytes;
}
function profile(name, entries) {
  assert.ok(['custom', 'rho-default'].includes(name), 'Unknown plugin-set profile');
  assert.ok(entries.length > 0 && entries.length <= 64, 'Select 1–64 package revisions');
  if (name === 'rho-default') assert.deepEqual(entries.map(p => p.plugin).sort(), [...defaultPlugins].sort(),
    'The default delivery requires exactly the sixteen ordinary feature plugins');
}
export function pluginCommand(rho, database, ...args) {
  return JSON.parse(execFileSync(rho, ['--database', database, 'plugins', ...args],
    {encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024})).result;
}
function archiveEntry(file, filename) {
  const bytes = read(file, maxArchiveBytes), archive = JSON.parse(bytes);
  return {file: filename, bytes: bytes.length, sha256: hash(bytes),
    plugin: archive.revision.manifest.id, revision: archive.revision.id,
    artifacts: archive.artifacts.map(a => ({id: a.id, target: a.target}))};
}

export function packagePluginSet({rho, input, destination}) {
  rho = fs.realpathSync(rho);
  input = path.resolve(input);
  const config = JSON.parse(read(input, 65536));
  fields(config, ['name', 'profile', 'packages']);
  assert.ok(typeof config.name === 'string' && config.name.trim() && config.name.length <= 128, 'Name the set');
  assert.ok(Array.isArray(config.packages), 'Supply package directories');
  const sources = config.packages.map(item => {
    fields(item, ['directory', 'target']);
    assert.ok(typeof item.directory === 'string' && typeof item.target === 'string' && item.target, 'Supply a directory and target');
    const directory = fs.realpathSync(path.resolve(path.dirname(input), item.directory));
    return {...item, directory, plugin: JSON.parse(read(path.join(directory, 'plugin.json'), 256 * 1024)).id};
  });
  profile(config.profile, sources);
  destination = path.resolve(destination);
  fs.mkdirSync(destination); // Never replace an earlier set or partial attempt.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-plugin-set-pack-'));
  try {
    const database = path.join(staging, 'assembly.sqlite');
    const packages = [], revisions = new Set();
    for (const [index, source] of sources.entries()) {
      const installed = pluginCommand(rho, database, 'snapshot', source.directory, '--target', source.target);
      assert.ok(!revisions.has(installed.revision), 'Select each source revision once');
      revisions.add(installed.revision);
      const file = `${String(index + 1).padStart(2, '0')}.rho-plugin`;
      const location = path.join(destination, file);
      pluginCommand(rho, database, 'export', installed.revision, location);
      assert.equal(pluginCommand(rho, database, 'validate', location).revision, installed.revision);
      packages.push(archiveEntry(location, file));
    }
    const set = {format: 1, name: config.name.trim(), profile: config.profile,
      assembly_cli_sha256: hash(fs.readFileSync(rho)), packages};
    profile(set.profile, packages);
    fs.copyFileSync(fileURLToPath(import.meta.url), path.join(destination, 'plugin-set.mjs'));
    fs.writeFileSync(path.join(destination, 'plugin-set.json'), JSON.stringify(set, null, 2) + '\n', {flag: 'wx'});
    return set;
  } finally { fs.rmSync(staging, {recursive: true, force: true}); }
}

// Pin validated bytes in our private staging directory before any destination
// catalog write, so a changed delivery directory cannot alter a later import.
function prepare(rho, directory, staging) {
  const root = fs.realpathSync(directory);
  const bytes = read(path.join(root, 'plugin-set.json'), 65536);
  const set = JSON.parse(bytes);
  fields(set, ['format', 'name', 'profile', 'assembly_cli_sha256', 'packages']);
  assert.equal(set.format, 1, 'Unsupported plugin-set format');
  assert.ok(typeof set.name === 'string' && set.name.trim() && set.name.length <= 128);
  assert.match(set.assembly_cli_sha256, digestPattern);
  assert.ok(Array.isArray(set.packages));
  profile(set.profile, set.packages);
  const names = new Set(), revisions = new Set();
  for (const entry of set.packages) {
    fields(entry, ['file', 'bytes', 'sha256', 'plugin', 'revision', 'artifacts']);
    assert.match(entry.file, /^[a-z0-9][a-z0-9._-]*\.rho-plugin$/, 'Archive must be a contained basename');
    assert.ok(!names.has(entry.file) && !revisions.has(entry.revision), 'Duplicate archive or revision');
    names.add(entry.file); revisions.add(entry.revision);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= maxArchiveBytes);
    assert.match(entry.sha256, digestPattern); assert.match(entry.revision, digestPattern);
    const source = path.join(root, entry.file), pinned = path.join(staging, entry.file);
    const content = read(source, maxArchiveBytes);
    assert.equal(content.length, entry.bytes, 'Archive size changed');
    assert.equal(hash(content), entry.sha256, 'Archive digest changed');
    fs.writeFileSync(pinned, content, {flag: 'wx', mode: 0o600});
    assert.deepEqual(archiveEntry(pinned, entry.file), entry, 'Index differs from the archive');
    const validated = pluginCommand(rho, path.join(staging, 'validation.sqlite'), 'validate', pinned);
    assert.equal(validated.valid, true); assert.equal(validated.revision, entry.revision);
  }
  return {set, digest: hash(bytes)};
}
export function verifyPluginSet({rho, directory}) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-plugin-set-verify-'));
  try { const {set, digest} = prepare(fs.realpathSync(rho), directory, staging);
    return {status: 'verified', digest, packages: set.packages};
  } finally { fs.rmSync(staging, {recursive: true, force: true}); }
}
export function installPluginSet({rho, directory, database}) {
  assert.ok(typeof database === 'string' && path.isAbsolute(database), 'Select an explicit absolute database path');
  rho = fs.realpathSync(rho);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-plugin-set-install-'));
  const report = {status: 'validating', imported: [], pending_revision: null};
  try {
    const {set, digest} = prepare(rho, directory, staging);
    report.digest = digest; report.status = 'importing';
    for (const entry of set.packages) {
      report.pending_revision = entry.revision;
      const installed = pluginCommand(rho, database, 'import', path.join(staging, entry.file));
      assert.equal(installed.revision, entry.revision);
      report.imported.push(installed);
      report.pending_revision = null;
    }
    report.status = 'installed';
    return report;
  } catch (error) {
    // A CLI timeout or lost reply may occur after its transaction committed.
    // Preserve the attempted revision instead of reporting a clean rollback.
    report.status = report.pending_revision ? 'import_outcome_unknown' : 'failed';
    error.installation = report; throw error;
  } finally { fs.rmSync(staging, {recursive: true, force: true}); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2), options = {};
    const allowed = {pack: ['rho', 'input', 'out'], verify: ['rho', 'set'], install: ['rho', 'set', 'database']}[command];
    assert.ok(allowed, 'Usage: plugin-set.mjs pack|verify|install --rho PATH [--input JSON --out NEW_DIR | --set DIR [--database ABSOLUTE_PATH]]');
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index].slice(2), value = args[index + 1];
      assert.ok(args[index].startsWith('--') && allowed.includes(name) && !(name in options) && value && !value.startsWith('--'), 'Invalid or repeated option');
      options[name] = value;
    }
    assert.deepEqual(Object.keys(options).sort(), [...allowed].sort(), 'Supply every required option');
    const result = command === 'pack' ? packagePluginSet({rho: options.rho, input: options.input, destination: options.out})
      : command === 'verify' ? verifyPluginSet({rho: options.rho, directory: options.set})
      : installPluginSet({rho: options.rho, directory: options.set, database: options.database});
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({error: error.message, installation: error.installation ?? null}));
    process.exitCode = 1;
  }
}
