import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { declarationSchema as file } from '@rho-workspace/plugin-files/contract';
import { declarationSchema as table } from '@rho-workspace/plugin-tables/contract';
import { declarationSchema as media } from '@rho-workspace/plugin-media/contract';
import { declarationSchema as object, createExecutionInputSchema } from '@rho-workspace/plugin-r/contract';
import { requirementsSchema } from '@rho-workspace/plugin-requirements/contract';
import { documentSummarySchema as ownerSummary } from '@rho-workspace/plugin-documents/operations';
import { operationContracts as ownerDocumentOperations } from '@rho-workspace/plugin-documents/operations';
import { ownerContracts } from '../dist/contracts/owners.generated.js';
import { operations, protocol, responses } from '../dist/protocol.js';

const run = promisify(execFile);

test('the wire vocabulary is the committed owner snapshot, not a second definition', () => {
  // The snapshot records where each schema came from. These are the facts Rho keeps
  // a copy of only so an absent owner is still describable.
  const documents = ownerContracts.selected.documents;
  assert.deepEqual(documents.documentSummarySchema, ownerSummary);
  assert.deepEqual(documents.operationContracts, ownerDocumentOperations);
  for (const owner of ['files', 'r', 'requirements', 'tables', 'media', 'charts', 'agent']) {
    const provenance = ownerContracts.provenance[owner];
    assert.equal(provenance.package, '@rho-workspace/plugin-' + owner);
    assert.match(provenance.entrySha256, /^[a-f0-9]{64}$/);
    assert.equal(provenance.entry, './operations');
  }
  // The composed execution input is the owner function's result over owner declarations.
  const declarations = { oneOf: [file, table, media, object] };
  const composed = createExecutionInputSchema(declarations, requirementsSchema);
  assert.deepEqual(ownerContracts.selected.execution.input, composed);
  assert.deepEqual(protocol.definitions.executionInput, composed);
  assert.deepEqual(protocol.definitions.declaration, file);
  assert.deepEqual(protocol.definitions.requirements, requirementsSchema);
});

test('a stale owner snapshot fails the generation check instead of drifting silently', async () => {
  // `--check` writes nothing; it compares the committed snapshot with the selected
  // owner entries and reports every difference it finds.
  const { stdout } = await run(process.execPath, ['scripts/contract-owners.mjs', '--check'], { cwd: new URL('..', import.meta.url).pathname });
  assert.match(stdout, /Owner contract snapshot is current/);
});

test('every served operation has an owner or an application handler, never neither', () => {
  // The contract is assembled from the snapshot plus the application's own
  // operations. A method that is in neither place would be published without a
  // definition, so the two sources together must name every operation exactly once.
  const ownerMethods = new Set(Object.keys(ownerContracts.selected.documents.operationContracts));
  for (const owner of ['files', 'r', 'requirements', 'tables', 'media', 'charts', 'agent']) {
    for (const method of Object.keys(ownerContracts.selected[owner].operationContracts ?? {})) {
      assert.ok(!ownerMethods.has(method), method + ' is declared by two owners');
      ownerMethods.add(method);
    }
  }
  for (const method of Object.keys(operations)) {
    assert.ok(operations[method]?.properties !== undefined || operations[method]?.oneOf, method + ' has no input definition');
    assert.ok(responses[method] !== undefined, method + ' has no response definition');
  }
});

test('owner contract entry provenance remains package-relative in source checkouts',async()=>{
 const {ownerContracts}=await import('../dist/contracts/owners.generated.js');
 for(const p of Object.values(ownerContracts.provenance))if(p.entryPath){assert.ok(p.entryPath.startsWith(p.package+'/'));assert.ok(!p.entryPath.includes('Projects/'));assert.ok(!p.entryPath.includes('candidate-checkouts/'));}
});
