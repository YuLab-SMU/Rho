import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { Ajv } from 'ajv';
import { protocol as legacyProtocol, responseEnvelope as legacyResponse, errorEnvelope as legacyError } from '../dist/legacy-protocol.js';
import { protocol, operations, responses, errorEnvelope, responseEnvelope } from '../dist/protocol.js';
import { protocolArtifacts } from '../scripts/protocol-artifact.mjs';
test('published protocol and captured read-only states conform to the same v1 consumer contract', async () => {
  const published = JSON.parse(await fs.readFile(new URL('../protocol/v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(published, legacyProtocol);
  for (const [name, content] of protocolArtifacts(protocol)) assert.equal(await fs.readFile(new URL('../protocol/' + name, import.meta.url), 'utf8'), content, name);
  assert.deepEqual(Object.keys(operations).sort(), Object.keys(responses).sort());
  const fixtures = JSON.parse(await fs.readFile(new URL('../fixtures/v1/states.json', import.meta.url), 'utf8'));
  assert.equal(fixtures.readOnly, true); assert.equal(fixtures.replay, 'forbidden');
  const ajv = new Ajv({ strict: false, allowUnionTypes: true, allErrors: true });
  for (const fixture of fixtures.cases) {
    const valid = ajv.compile(fixture.envelope.ok ? legacyResponse(fixture.operation) : legacyError);
    assert.ok(valid(fixture.envelope), fixture.state + ': ' + JSON.stringify(valid.errors));
  }
  assert.equal(new Set(fixtures.cases.map(c => c.state)).size, 10);
  const unknown = fixtures.cases.find(c => c.state === 'unknown').envelope.value;
  const partial = fixtures.cases.find(c => c.state === 'partial').envelope.value;
  assert.equal(unknown.execution, 'unknown'); assert.equal(partial.resources[0].coverage.observedRows, 16139);
  assert.equal(partial.resources[0].availability, 'partial'); assert.equal(unknown.domain.state, 'unchecked');
});
test('v2 inert response states conform to the extracted consumer contract and retain real failure/unknown facts', async () => {
  const fixtures = JSON.parse(await fs.readFile(new URL('../fixtures/v2/states.json', import.meta.url), 'utf8'));
  assert.equal(fixtures.apiVersion, '2.0'); assert.equal(fixtures.readOnly, true); assert.equal(fixtures.replay, 'forbidden');
  const ajv = new Ajv({ strict: false, allowUnionTypes: true, allErrors: true });
  for (const fixture of fixtures.cases) {
    const valid = ajv.compile(fixture.envelope.ok ? responseEnvelope(fixture.operation) : errorEnvelope);
    assert.ok(valid(fixture.envelope), fixture.state + ': ' + JSON.stringify(valid.errors));
  }
  assert.equal(new Set(fixtures.cases.map(c => c.state)).size, 10);
  assert.equal(fixtures.cases.find(c => c.state === 'partial').envelope.value.resources[0].coverage.observedRows, 4);
  assert.equal(fixtures.cases.find(c => c.state === 'unknown').envelope.value.execution, 'unknown');
  assert.equal(fixtures.cases.find(c => c.state === 'failed').envelope.value.execution, 'failed');
});
