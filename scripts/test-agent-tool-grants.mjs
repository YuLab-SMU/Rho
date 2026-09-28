// Compare published optional grants with the exact public owner contracts.
// This performs no activation, native command, model call or scientific work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = owner => JSON.parse(fs.readFileSync(path.join(root, 'plugins', owner, 'plugin.json'), 'utf8'));
const key = capability => `${capability.id}@${capability.version}`;
const agent = read('agent');
const grants = new Map(agent.optional_requires.map(grant => [key(grant.capability), grant]));
assert.equal(grants.size, agent.optional_requires.length, 'Optional grants must be unique');
const expected = new Set(['plugins.inspect@1', 'operation.get@1', 'plugins.delegated_operation@1', 'resources.read@1']);
assert.deepEqual(grants.get('resources.read@1')?.scopes, ['resources.read']);
const studio = new Map(read('studio').requires.map(grant => [key(grant.capability), grant]));
const core = [
  'host.core_contract', 'plugins.list', 'plugins.branches', 'plugins.branch_head', 'plugins.source_tree',
  'plugins.read_source', 'plugins.check_source', 'plugins.compare', 'plugins.instances', 'plugins.instance',
  'scenarios.list', 'scenarios.get', 'plugins.branch', 'plugins.checkpoint', 'plugins.advance_branch',
  'plugins.remove', 'scenarios.checkpoint', 'plugins.preview', 'plugins.release', 'plugins.reconcile_references',
  'windows.layout', 'windows.scenario', 'windows.update_layout', 'views.inspect', 'views.close', 'plugins.build',
  'plugins.activate', 'views.open', 'windows.open_view', 'scenarios.prepare', 'scenarios.apply',
];
const separateScopes = new Map([
  ['host.core_contract@1', ['plugins.read']], ['plugins.advance_branch@1', ['plugins.write']],
  ['plugins.remove@1', ['plugins.write']], ['plugins.reconcile_references@1', ['plugins.run']],
  ['windows.update_layout@1', ['plugins.run']],
]);
for (const id of core) {
  const name = id + '@1', scopes = separateScopes.get(name) ?? studio.get(name)?.scopes;
  assert.ok(scopes, `No public grant expectation for ${name}`);
  assert.ok(!expected.has(name), `Duplicate native declaration ${name}`);
  expected.add(name);
  assert.deepEqual(grants.get(name)?.scopes.toSorted(), scopes.toSorted(), `Native tool declaration differs: ${name}`);
  assert.ok(!agent.requires.some(grant => key(grant.capability) === name), `Core tools must remain optional: ${name}`);
}
let count = 0;
for (const owner of ['r', 'files', 'process', 'remote', 'environment', 'editor']) {
  const manifest = read(owner);
  for (const capability of manifest.capabilities) {
    const name = key(capability.capability);
    if (!['query', 'operation'].includes(capability.kind)) {
      assert.ok(!grants.has(name), `Native tools must not acquire ${capability.kind} grant ${name}`);
      continue;
    }
    assert.ok(!expected.has(name), `Public providers declare the same tool version: ${name}`);
    expected.add(name);
    assert.deepEqual(grants.get(name)?.scopes.toSorted(), capability.required_scopes.toSorted(),
      `Agent's optional grant must match the public ${owner} contract: ${name}`);
    assert.ok(!agent.requires.some(requirement => key(requirement.capability) === name),
      `Scientific tools must remain optional: ${name}`);
    count++;
  }
}
assert.deepEqual([...grants.keys()].sort(), [...expected].sort(), 'Unexpected or missing native tool grants');
console.log(`Agent optional grants match ${count} scientific and ${core.length} native management Query/Operation contracts; Control and Runtime remain excluded.`);
