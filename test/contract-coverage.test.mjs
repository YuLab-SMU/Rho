import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { operations } from '../dist/protocol.js';

// Every published operation must reach a handler. The service answers an unpublished
// or unimplemented operation with a distinguishable refusal, so a contract that
// grows an operation without a handler fails here instead of at a caller's first use.
test('every published operation is handled, never left to the uninstalled fallback', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-coverage-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: path.resolve('../Rho-core/target/debug/rho-core'), rscript: 'Rscript' }).start();
  try {
    const client = new RhoClient({ url: service.url, token: service.adminToken });
    const project = await client.call('project.create', { name: 'coverage' });
    const unhandled = [];
    for (const method of Object.keys(operations).sort()) {
      // A minimal request: a project identity plus any field the schema requires.
      // Whatever the operation does with it, the answer must come from a handler —
      // either a value or a stated business condition — not from "not installed".
      const body = { projectId: project.id };
      const required = operations[method]?.required ?? [];
      for (const field of required) if (!(field in body)) body[field] = placeholder(field);
      try { await client.call(method, body); }
      catch (error) {
        const message = String(error?.message ?? '');
        if (/has not been installed/.test(message)) unhandled.push(method);
      }
    }
    assert.deepEqual(unhandled, []);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

// Enough of a value to satisfy the schema's shape; the operation itself decides what
// the value means. This is deliberately generic: an operation that needs real state
// answers with a business refusal, which is the point of the check.
function placeholder(field) {
  const identities = ['projectId', 'taskId', 'compositionId', 'viewId', 'annotationId', 'skillId', 'sessionId', 'externalSessionId', 'operationId', 'documentId', 'bindingId', 'adapterId', 'target', 'changeId', 'submissionId', 'deliveryId', 'fetchId', 'source', 'destination', 'path', 'name', 'externalSessionId', 'role', 'intent', 'stream', 'query', 'message'];
  if (field === 'format') return 1;
  if (field === 'method') return 'protocol.describe';
  if (field === 'body') return {};
  if (field === 'expectedVersion' || field === 'offset') return 0;
  if (field === 'limit' || field === 'maxBytes' || field === 'maxPoints') return 1;
  if (field === 'expectedDigest') return '0'.repeat(64);
  if (field === 'resource') return { id: 'r', version: '0'.repeat(64) };
  if (field === 'left' || field === 'right' || field === 'baseline' || field === 'shrinkage') return { id: 'r', version: '0'.repeat(64) };
  if (field === 'requirements') return [];
  if (field === 'events' || field === 'operations' || field === 'selectionIds' || field === 'methods' || field === 'enabled' || field === 'items' || field === 'remove' || field === 'next') return [];
  if (field === 'declaration') return { path: 'x.txt', kind: 'file', format: { mimeType: 'text/plain' } };
  if (field === 'edits') return [{ from: 0, to: 0, insert: '' }];
  if (field === 'scope') return { kind: 'caller' };
  if (field === 'selection') return null;
  if (field === 'input') return { script: { kind: 'disk', path: 'x.R', digest: '0'.repeat(64) }, args: [] };
  if (field === 'action') return 'r.execute';
  if (field === 'actionVersion') return '0.2.0';
  if (field === 'draft') return { documentId: 'd', version: 1 };
  if (field === 'anchor') return { kind: 'document', documentId: 'd', version: 1, from: 0, to: 0 };
  if (field === 'submission' || field === 'delivery') return {};
  return '0'.repeat(64);
}
