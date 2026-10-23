import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { Ajv } from 'ajv';
import { protocol, operations, responses, errorEnvelope, responseEnvelope } from '../dist/protocol.js';
import { baseProtocol } from '../dist/protocol-base.js';
import { protocolArtifacts } from '../scripts/protocol-artifact.mjs';
test('the published artifact is exactly the one served contract, regenerated from source', async () => {
  // The artifact is derived, so the on-disk bytes are checked against its generator
  // instead of being kept as a second hand-maintained copy.
  for (const [name, content] of protocolArtifacts(protocol)) assert.equal(await fs.readFile(new URL('../protocol/' + name, import.meta.url), 'utf8'), content, name);
  const published = JSON.parse(await fs.readFile(new URL('../protocol/index.json', import.meta.url), 'utf8'));
  assert.equal(published.format, 'rho.protocol-index/1');
  assert.equal(published.apiVersion, protocol.apiVersion);
  assert.deepEqual(Object.keys(operations).sort(), Object.keys(responses).sort());
  // Exactly one contract is published: a baseline second dialect would reappear as
  // another artifact root or its own version constant.
  const roots = (await fs.readdir(new URL('../protocol/', import.meta.url))).filter(name => name.endsWith('.json'));
  assert.deepEqual(roots, ['index.json']);
  assert.equal(baseProtocol.apiVersion, undefined);
  assert.equal(baseProtocol.transport, undefined);
  assert.equal('errorEnvelope' in baseProtocol, false);
});
test('inert response states conform to the served contract and retain real failure/unknown facts', async () => {
  const fixtures = JSON.parse(await fs.readFile(new URL('../fixtures/states.json', import.meta.url), 'utf8'));
  assert.equal(fixtures.apiVersion, '2.0'); assert.equal(fixtures.readOnly, true); assert.equal(fixtures.replay, 'forbidden');
  const ajv = new Ajv({ strict: false, allowUnionTypes: true, allErrors: true });
  for (const fixture of fixtures.cases) {
    const valid = ajv.compile(fixture.envelope.ok ? responseEnvelope(fixture.operation) : errorEnvelope);
    assert.ok(valid(fixture.envelope), fixture.state + ': ' + JSON.stringify(valid.errors));
  }
  assert.equal(new Set(fixtures.cases.map(c => c.state)).size, 11);
  assert.equal(fixtures.cases.find(c => c.state === 'partial').envelope.value.resources[0].coverage.observedRows, 4);
  assert.equal(fixtures.cases.find(c => c.state === 'unknown').envelope.value.execution, 'unknown');
  assert.equal(fixtures.cases.find(c => c.state === 'failed').envelope.value.execution, 'failed');
  // Retained evidence is re-read through the current contract rather than kept as
  // a second frozen dialect.
  const retained = fixtures.cases.find(c => c.state === 'partial-retained').envelope.value.resources[0];
  assert.equal(retained.coverage.observedRows, 16139);
  assert.equal(retained.availability, 'partial');
  assert.equal(fixtures.cases.find(c => c.state === 'unknown').envelope.value.domain.state, 'unchecked');
});
