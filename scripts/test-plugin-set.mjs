// Real frozen CLI/repository acceptance. No Cargo, UI compilation or user catalog.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {packagePluginSet, verifyPluginSet, installPluginSet, pluginCommand} from './plugin-set.mjs';

const root = path.resolve(import.meta.dirname, '..');
const rho = fs.realpathSync(process.env.RHO_TEST_BINARY ?? path.join(root, 'target/debug/rho'));
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const originalHost = hash(fs.readFileSync(rho));
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-plugin-set-test-')));
const database = path.join(directory, 'installed', 'host.sqlite');
const destination = path.join(directory, 'delivery');
const input = path.join(directory, 'input.json');
const report = {directory, host_sha256: originalHost, checks: [], completed: false};
const evidence = process.env.RHO_PLUGIN_SET_EVIDENCE ?? path.join(directory, 'result.json');
const command = (...args) => pluginCommand(rho, database, ...args);
async function startupWithoutPlugins(selectedDatabase = database, projectName = 'project') {
  const project = path.join(directory, projectName); fs.mkdirSync(project);
  const host = spawn(rho, ['--database', selectedDatabase, '--project', project, '--plugins-only', 'workbench'], {stdio: ['ignore', 'pipe', 'pipe']});
  const exit = new Promise(resolve => host.once('exit', (code, signal) => resolve({code, signal})));
  const deadline = async (promise, ms) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Owned Host timeout')), ms);})]); }
    finally { clearTimeout(timer); }
  };
  let output = '', errors = '';
  try {
    await deadline(new Promise((resolve, reject) => {
      host.once('error', reject);
      host.stderr.on('data', bytes => { errors += String(bytes).replace(/token=[a-z0-9]+/g, 'token=[redacted]'); });
      host.stdout.on('data', bytes => { output += bytes; if (/http:\/\/127\.0\.0\.1:\d+\//.test(output)) resolve(); });
      exit.then(result => reject(Error(`Owned Host exited: ${JSON.stringify(result)} ${errors}`)));
    }), 60000);
    assert.equal(pluginCommand(rho, selectedDatabase, 'list').total, 0, 'Workbench startup must not silently reinstall removed packages');
    host.kill('SIGINT');
    assert.equal((await deadline(exit, 30000)).code, 0);
  } finally {
    if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await deadline(exit, 5000); }
  }
}
try {
  const packages = [];
  for (const version of ['1.0.0', '2.0.0']) {
    const source = path.join(directory, `source-${version}`);
    fs.cpSync(path.join(root, 'plugins/example-inspector'), source, {recursive: true,
      filter: file => !/[\\/](dist|node_modules|target)([\\/]|$)/.test(file)});
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json')));
    manifest.version = version;
    fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest));
    fs.mkdirSync(path.join(source, 'dist'));
    fs.copyFileSync(path.join(source, 'src/index.html'), path.join(source, 'dist/index.html'));
    packages.push({directory: source, target: 'ui-web'});
  }
  fs.writeFileSync(input, JSON.stringify({name: 'Ordinary coexisting revisions', profile: 'rho-default', packages}));
  assert.throws(() => packagePluginSet({rho, input, destination}), /sixteen/);
  assert.equal(fs.existsSync(destination), false, 'Incomplete default selection fails before assembly');
  fs.writeFileSync(input, JSON.stringify({name: 'Ordinary coexisting revisions', profile: 'custom', packages}));
  const set = packagePluginSet({rho, input, destination});
  assert.equal(set.packages.length, 2);
  assert.equal(set.packages[0].plugin, set.packages[1].plugin);
  assert.notEqual(set.packages[0].revision, set.packages[1].revision);
  assert.throws(() => packagePluginSet({rho, input, destination}), /EEXIST/);
  report.checks.push('default profile requires all sixteen plugins; assembly preserves coexisting source revisions and refuses overwrite');
  assert.equal(verifyPluginSet({rho, directory: destination}).status, 'verified');
  assert.equal(command('list').total, 0);
  const indexPath = path.join(destination, 'plugin-set.json');
  const indexBytes = fs.readFileSync(indexPath);
  const secondPath = path.join(destination, set.packages[1].file), secondBytes = fs.readFileSync(secondPath);
  const rejectBeforeImport = () => {
    assert.throws(() => installPluginSet({rho, directory: destination, database}));
    assert.equal(command('list').total, 0);
    assert.equal(fs.existsSync(path.join(path.dirname(database), 'plugins-v1')), false);
  };
  fs.writeFileSync(secondPath, 'damaged'); rejectBeforeImport();
  fs.writeFileSync(secondPath, secondBytes);
  // A matching outer checksum is not permission to bypass ordinary archive validation.
  const forged = JSON.parse(secondBytes); forged.revision.manifest.name = 'Forged source bytes';
  const forgedBytes = Buffer.from(JSON.stringify(forged)); fs.writeFileSync(secondPath, forgedBytes);
  const forgedSet = structuredClone(set); forgedSet.packages[1].bytes = forgedBytes.length;
  forgedSet.packages[1].sha256 = hash(forgedBytes); fs.writeFileSync(indexPath, JSON.stringify(forgedSet));
  rejectBeforeImport();
  fs.writeFileSync(secondPath, secondBytes); fs.writeFileSync(indexPath, indexBytes);
  const escape = structuredClone(set); escape.packages[1].file = '../escape.rho-plugin';
  fs.writeFileSync(indexPath, JSON.stringify(escape)); rejectBeforeImport(); fs.writeFileSync(indexPath, indexBytes);
  const external = path.join(directory, 'outside.rho-plugin'); fs.writeFileSync(external, secondBytes);
  fs.unlinkSync(secondPath); fs.symlinkSync(external, secondPath); rejectBeforeImport();
  fs.unlinkSync(secondPath); fs.writeFileSync(secondPath, secondBytes);
  report.checks.push('damaged later archive, forged source with matching outer checksum, path escape and symlink refused before any destination import');
  const lostReplyCli = path.join(directory, 'lost-reply.cjs');
  fs.writeFileSync(lostReplyCli, `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nconst result=spawnSync(${JSON.stringify(rho)},args,{encoding:'utf8'});\nif(result.status===0&&args.includes('import'))process.exit(42);\nprocess.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);\n`, {mode: 0o700});
  const lostDatabase = path.join(directory, 'lost-catalog', 'host.sqlite');
  assert.throws(() => installPluginSet({rho: lostReplyCli, directory: destination, database: lostDatabase}), error => {
    assert.equal(error.installation.status, 'import_outcome_unknown');
    assert.equal(error.installation.pending_revision, set.packages[0].revision);
    assert.equal(error.installation.imported.length, 0); return true;
  });
  assert.equal(pluginCommand(rho, lostDatabase, 'list').total, 1, 'Lost acknowledgement does not undo a committed import');
  assert.equal(installPluginSet({rho, directory: destination, database: lostDatabase}).status, 'installed');
  assert.equal(pluginCommand(rho, lostDatabase, 'list').total, 2);
  report.checks.push('lost import acknowledgement retains the attempted revision; explicit retry completes without duplicates');
  assert.equal(installPluginSet({rho, directory: destination, database}).status, 'installed');
  assert.equal(command('list').total, 2);
  assert.equal(installPluginSet({rho, directory: destination, database}).status, 'installed');
  assert.equal(command('list').total, 2, 'Explicit retry does not duplicate revisions');
  assert.equal(command('instances').recorded.total, 0, 'Installation does not activate any instance');
  for (const entry of set.packages) command('remove', entry.revision);
  await startupWithoutPlugins();
  assert.equal(verifyPluginSet({rho, directory: destination}).status, 'verified');
  assert.equal(command('list').total, 0, 'Read-only verification does not reinstall');
  assert.equal(installPluginSet({rho, directory: destination, database}).status, 'installed');
  assert.equal(command('list').total, 2, 'Only explicit installation restores removed packages');
  report.checks.push('ordinary import, idempotent explicit retry, no activation, removal, empty Host startup without reinstall and explicit restoration');
  report.packages = set.packages;
  if (process.env.RHO_PLUGIN_SET_PACKAGE) {
    const delivery = fs.realpathSync(process.env.RHO_PLUGIN_SET_PACKAGE);
    const deliverySet = JSON.parse(fs.readFileSync(path.join(delivery, 'plugin-set.json')));
    assert.equal(deliverySet.profile, 'rho-default');
    const fullDatabase = path.join(directory, 'full-catalog', 'host.sqlite');
    const full = (...args) => pluginCommand(rho, fullDatabase, ...args);
    const installed = installPluginSet({rho, directory: delivery, database: fullDatabase});
    assert.equal(installed.status, 'installed');
    assert.equal(installed.imported.length, 16); assert.equal(full('list').total, 16);
    const originals = deliverySet.packages.map(entry => full('inspect', entry.revision));
    assert.equal(full('instances').recorded.total, 0);
    for (const entry of deliverySet.packages) full('remove', entry.revision);
    await startupWithoutPlugins(fullDatabase, 'full-delivery-project');
    assert.equal(full('list').total, 0);
    assert.equal(installPluginSet({rho, directory: delivery, database: fullDatabase}).status, 'installed');
    for (const [index, entry] of deliverySet.packages.entries()) {
      const restored = full('inspect', entry.revision);
      assert.deepEqual(restored, originals[index]);
      // Inspect returns only catalog metadata, not the manifest. Export the
      // restored package to verify all source, grants and artifacts byte-for-byte.
      const exported = path.join(directory, `restored-${entry.file}`);
      full('export', entry.revision, exported);
      assert.equal(hash(fs.readFileSync(exported)), entry.sha256,
        'Restoration retains the entire original archive, including capability/permission declarations');
    }
    report.full_set = {directory: delivery, digest: installed.digest, packages: deliverySet.packages,
      total_archive_bytes: deliverySet.packages.reduce((sum, entry) => sum + entry.bytes, 0),
      all_removed: true, empty_host_started: true, silent_reinstall: false, restored_exact_contracts: true};
  }
  report.completed = true;
} catch (error) { report.error = error.stack; throw error; }
finally {
  assert.equal(hash(fs.readFileSync(rho)), originalHost);
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({completed: report.completed, evidence}));
}
