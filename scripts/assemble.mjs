import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root, readJson, saveJson, sourceIdentity, hash, treeFiles, coreArtifact, applicationInputs} from './components.mjs';
import {packagePluginSet} from './plugin-set.mjs';

const [destination, ...names] = process.argv.slice(2);
assert.ok(destination && names.length, 'Usage: node dev.mjs assemble NEW_DIRECTORY PLUGIN...');
assert.ok(new Set(names).size === names.length && names.every(name => /^[a-z][a-z0-9-]*$/.test(name)));
const output = path.resolve(destination), core = coreArtifact(), lock = readJson(path.join(root, 'rho.lock.json'));
const receipts = readJson(path.join(root, 'target/packages.json'));
const assets = readJson(path.join(root, 'target/app-assets.json'));
assert.equal(assets.inputs, applicationInputs(), 'Application source changed; rebuild its assets');
assert.deepEqual(treeFiles(path.join(root, 'target/app-assets')), assets.files, 'Application assets changed after building');
const packages = names.map(name => {
  const item = receipts[name]; assert.ok(item, `Build ${name} first`);
  assert.equal(item.source.dirty, false, `Commit and rebuild ${name} before assembly`);
  assert.deepEqual({source_revision: item.source.revision, sha256: item.sha256, target: item.target}, lock.packages?.[name],
    `Plugin artifact differs from its selected lock: ${name}`);
  const directory = path.join(root, item.directory);
  assert.equal(hash(JSON.stringify(treeFiles(directory))), item.sha256, `Package bytes changed: ${name}`);
  return {directory, target: item.target};
});
fs.mkdirSync(output); // A new combination never replaces an old one.
fs.copyFileSync(core.absolute, path.join(output, 'rho')); fs.chmodSync(path.join(output, 'rho'), 0o755);
fs.cpSync(path.join(root, 'target/app-assets'), path.join(output, 'assets'), {recursive: true});
const input = path.join(output, 'assembly-input.json');
saveJson(input, {name: 'Rho development', profile: 'custom', packages});
const set = packagePluginSet({rho: path.join(output, 'rho'), input, destination: path.join(output, 'plugins')});
fs.unlinkSync(input);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
fs.writeFileSync(path.join(output, 'README.md'), '# Rho development composition\n\nRun the included rho with an explicit project/database and `workbench --assets /absolute/composition/assets`.\nImport selected plugin archives with the included plugin-set.mjs installer when intended. Import does not activate instances.\nThis is an unsigned local development composition; it is not an installed or published application.\n');
saveJson(path.join(output, 'composition.json'), {format: 1, application: sourceIdentity(root), source_lock: lock,
  core: {source: core.source, sha256: core.sha256, bytes: core.bytes}, plugins: set.packages, files: treeFiles(output)});
console.log(`Assembled ${output} from ${names.length} exact plugin artifacts; no component was rebuilt or installed.`);
