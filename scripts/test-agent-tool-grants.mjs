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
const expected = new Set(['plugins.inspect@1', 'operation.get@1', 'plugins.delegated_operation@1']);
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
console.log(`Agent optional grants match ${count} exact public Query/Operation contracts; Control and Runtime remain excluded.`);
