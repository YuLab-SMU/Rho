#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {root, hash, readJson, saveJson, run, repositories, sourceIdentity, treeFiles, coreArtifact} from './scripts/components.mjs';

const [command = 'status', subject, ...args] = process.argv.slice(2);
const repos = repositories(), local = process.argv.includes('--local');
const target = path.join(root, 'target'); fs.mkdirSync(target, {recursive: true});
switch (command) {
  case 'status': {
    const lock = fs.existsSync(path.join(root, 'rho.lock.json')) ? readJson(path.join(root, 'rho.lock.json')) : {};
    for (const [name, directory] of Object.entries(repos)) {
      if (!fs.existsSync(path.join(directory, '.git'))) { console.log(`${name}: unavailable (${directory})`); continue; }
      const identity = sourceIdentity(directory);
      console.log(`${name}: ${identity.revision.slice(0, 12)}${identity.dirty ? ' + local changes' : ''}${lock[name] && lock[name].revision !== identity.revision ? ' (differs from lock)' : ''} — ${directory}`);
    }
    for (const file of ['target/core.json', 'target/packages.json']) if (fs.existsSync(path.join(root, file))) console.log(`${file}: ${JSON.stringify(readJson(path.join(root, file)))}`);
    break;
  }
  case 'build': {
    if (subject === 'app') { run('npm', ['run', 'build', '--prefix', 'ui']); break; }
    assert.ok(['core', 'plugin'].includes(subject), 'build core | build app | build plugin NAME');
    const directory = subject === 'core' ? repos.core : repos.plugins;
    const before = sourceIdentity(directory);
    if (subject === 'core') {
      run('cargo', ['build', '--locked'], directory);
      assert.equal(sourceIdentity(directory).sha256, before.sha256, 'Core source changed during build');
      const bytes = fs.readFileSync(path.join(directory, 'target/debug/rho')), sha256 = hash(bytes);
      const file = path.join('target/components', sha256, 'rho');
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      fs.writeFileSync(path.join(root, file), bytes, {mode: 0o755});
      saveJson(path.join(target, 'core.json'), {file, bytes: bytes.length, sha256, source: before});
      console.log(`Retained core ${sha256}; ${before.dirty ? 'local override' : before.revision}`);
    } else {
      const name = args[0]; assert.match(name ?? '', /^[a-z][a-z0-9-]*$/);
      const stem = name === 'annotations' ? 'annotation' : name;
      const builder = path.join(directory, `scripts/build-${stem}-plugin.mjs`);
      assert.ok(fs.existsSync(builder), `Unknown plugin: ${name}`);
      run(process.execPath, ['sdk/verify-snapshot.mjs'], directory);
      const parent = fs.mkdtempSync(path.join(target, `${name}-`)), packagePath = path.join(parent, 'package');
      run(process.execPath, [builder, packagePath], directory);
      assert.equal(sourceIdentity(directory).sha256, before.sha256, 'Plugin source changed during build');
      const inventory = treeFiles(packagePath), manifest = readJson(path.join(packagePath, 'plugin.json'));
      const receipts = fs.existsSync(path.join(target, 'packages.json')) ? readJson(path.join(target, 'packages.json')) : {};
      receipts[name] = {directory: path.relative(root, packagePath), plugin: manifest.id, source: before,
        sha256: hash(JSON.stringify(inventory)), target: manifest.backend ? execFileSync('rustc', ['-vV'], {cwd: directory, encoding: 'utf8'}).match(/^host: (.+)$/m)[1] : 'ui-web'};
      saveJson(path.join(target, 'packages.json'), receipts);
      console.log(`Built ${name}; retained core was not rebuilt.`);
    }
    break;
  }
  case 'lock': {
    const core = sourceIdentity(repos.core), plugins = sourceIdentity(repos.plugins);
    assert.ok(!core.dirty && !plugins.dirty, 'Commit component changes before updating the application source lock');
    const sdk = readJson(path.join(root, 'core-sdk.json')), pluginSdk = readJson(path.join(repos.plugins, 'core-sdk.json'));
    assert.equal(sdk.source_revision, core.revision, 'Refresh application SDK first');
    assert.equal(pluginSdk.source_revision, core.revision, 'Refresh plugin SDK first');
    const receipts = fs.existsSync(path.join(target, 'packages.json')) ? readJson(path.join(target, 'packages.json')) : {};
    const packages = {};
    for (const [name, item] of Object.entries(receipts)) {
      assert.equal(item.source.dirty, false, `Commit and rebuild local override ${name} before locking it`);
      assert.equal(hash(JSON.stringify(treeFiles(path.join(root, item.directory)))), item.sha256, `Package changed: ${name}`);
      packages[name] = {source_revision: item.source.revision, sha256: item.sha256, target: item.target};
    }
    saveJson(path.join(root, 'rho.lock.json'), {format: 1, core: {revision: core.revision, sdk_sha256: sdk.sha256},
      plugins: {revision: plugins.revision, sdk_sha256: pluginSdk.sha256}, packages});
    break;
  }
  case 'sdk': {
    assert.equal(subject, 'sync', 'Use sdk sync app | plugins');
    const consumer = args[0]; assert.ok(['app', 'plugins'].includes(consumer));
    const destination = repos[consumer], before = sourceIdentity(repos.core);
    assert.equal(before.dirty, false, 'Commit core changes before exporting dependencies');
    if (fs.existsSync(path.join(destination, 'core-sdk.json'))) run(process.execPath, ['sdk/verify-snapshot.mjs'], destination);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-sdk-sync-'));
    try {
      const snapshot = path.join(temporary, 'snapshot');
      run(process.execPath, [path.join(repos.core, 'scripts/export-sdk.mjs'), snapshot, ...(consumer === 'app' ? ['--javascript-only'] : [])], repos.core);
      const manifest = readJson(path.join(snapshot, 'core-sdk.json'));
      assert.equal(sourceIdentity(repos.core).sha256, before.sha256, 'Core changed while exporting SDK');
      const previous = fs.existsSync(path.join(destination, 'core-sdk.json')) ? readJson(path.join(destination, 'core-sdk.json')) : null;
      const names = new Set(manifest.files.map(file => file.path));
      for (const file of previous?.files ?? []) if (!names.has(file.path)) fs.unlinkSync(path.join(destination, file.path));
      fs.cpSync(snapshot, destination, {recursive: true});
    } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
    break;
  }
  case 'verify': {
    run(process.execPath, ['sdk/verify-snapshot.mjs']);
    const lock = readJson(path.join(root, 'rho.lock.json'));
    assert.equal(readJson(path.join(root, 'core-sdk.json')).sha256, lock.core.sdk_sha256);
    const core = coreArtifact({local});
    const packages = fs.existsSync(path.join(target, 'packages.json')) ? readJson(path.join(target, 'packages.json')) : {};
    for (const [name, item] of Object.entries(packages)) {
      assert.equal(hash(JSON.stringify(treeFiles(path.join(root, item.directory)))), item.sha256, `Package changed: ${name}`);
      if (!local) {
        assert.equal(item.source.dirty, false);
        assert.deepEqual({source_revision: item.source.revision, sha256: item.sha256, target: item.target}, lock.packages?.[name],
          `Package ${name} differs from its explicit lock; run lock to select the new artifact`);
      }
    }
    console.log(`Verified retained core ${core.sha256} and ${Object.keys(packages).length} plugin packages.`);
    break;
  }
  case 'run': {
    const core = coreArtifact({local});
    const project = subject && subject !== '--local' ? path.resolve(subject) : null;
    const state = path.join(target, 'development'); fs.mkdirSync(state, {recursive: true});
    const demo = path.join(state, 'demo');
    if (!fs.existsSync(demo)) fs.cpSync(path.join(root, 'examples/rho-demo'), demo, {recursive: true, errorOnExist: true});
    const launch = ['--database', path.join(state, 'catalog.sqlite'), ...(project ? ['--project', project] : []),
      'workbench', '--assets', path.join(target, 'app-assets'), '--default-project', demo];
    run(core.absolute, launch); break;
  }
  case 'assemble': run(process.execPath, ['scripts/assemble.mjs', ...process.argv.slice(3)]); break;
  default: throw Error('Use status, build core|app|plugin NAME, sdk sync app|plugins, lock, verify, run [PROJECT], or assemble NEW_DIRECTORY [PLUGINS...]');
}
