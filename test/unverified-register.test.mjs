import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A register of gaps is only worth keeping if the gaps are reproducible. Every dead path
// named here must be asserted by a check that runs, so "still broken" is a measurement.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const register = await fs.readFile(path.join(root, 'docs/UNVERIFIED.md'), 'utf8');
const read = file => fs.readFile(path.join(root, file), 'utf8');

test('each dead path names the check that reproduces it', async () => {
  const dead = register.split('## Dead paths')[1].split('##')[0];
  assert.match(dead, /artifact-not-presentable/, 'the artifact gap is named');
  assert.match(dead, /document\.save/, 'the save boundary is named');
  // The artifact gap is asserted by the execution acceptance.
  const execution = await read('scripts/execution-acceptance.mjs');
  assert.match(execution, /artifact-not-presentable/, 'acceptance:execution records the gap');
  // The save boundary is asserted by the person acceptance.
  const person = await read('scripts/person-files-acceptance.mjs');
  assert.match(person, /Saving to disk is an Agent step/, 'acceptance:person asserts the boundary');
});

test('the register does not claim a check that is missing', async () => {
  for (const command of [...register.matchAll(/`(acceptance:[a-z-]+|test:[a-z-]+)`/g)].map(match => match[1])) {
    const scripts = JSON.parse(await read('package.json')).scripts;
    assert.ok(scripts[command], `${command} is a script that exists`);
  }
});
