// Compile-time contract checks.
//
// This file is never run. It is compiled by `tsc -p tsconfig.types.json`, so a call
// the contract does not permit fails the build. Every `@ts-expect-error` must still
// be an error: if a change makes one of these calls legal, TypeScript reports the
// now-unused directive and this check fails too. The positive cases at the end prove
// the types are usable, not merely restrictive.
import { RhoClient } from '../../src/client.js';
import { BrowserClient } from '../../src/browser.js';
import type { RhoInput, RhoMethod, RhoOutput } from '../../src/contract.generated.js';
import { readOperation } from '../../src/operation-request.js';

const client = new RhoClient({ url: 'http://127.0.0.1:1', token: 't' });

// --- method names -----------------------------------------------------------
// A method the contract does not publish is not a call at all.
// @ts-expect-error - 'document.write' is not a published operation
void client.call('document.write', { projectId: 'p', documentId: 'd' });
// @ts-expect-error - a bare string is not accepted where a method is required
void client.call('document.read' as string, { projectId: 'p', documentId: 'd' });

// --- inputs -----------------------------------------------------------------
// @ts-expect-error - document.read needs documentId
void client.call('document.read', { projectId: 'p' });
// @ts-expect-error - document.read takes no path
void client.call('document.read', { projectId: 'p', documentId: 'd', path: 'a.md' });
// @ts-expect-error - expectedVersion is a number
void client.call('document.edit', { projectId: 'p', documentId: 'd', expectedVersion: '1', edits: [{ from: 0, to: 0, insert: 'x' }], undoGroup: 'g' });
// @ts-expect-error - an edit is from/to/insert, not a patch string
void client.call('document.edit', { projectId: 'p', documentId: 'd', expectedVersion: 1, edits: ['x'], undoGroup: 'g' });
// @ts-expect-error - a required project identity cannot be omitted
void client.call('project.runs', {});
// @ts-expect-error - the task-map target must be a string
void client.call('task.map.present', { projectId: 'p', expectedVersion: 0, changeId: 'c', target: 3 });
// @ts-expect-error - capability.configure enables plugin ids, not objects
void client.call('capability.configure', { projectId: 'p', expectedVersion: 0, changeId: 'c', enabled: [{ id: 'documents' }] });

// --- results ----------------------------------------------------------------
// A caller cannot name the type it wants back; the contract decides.
const read = await client.call('document.read', { projectId: 'p', documentId: 'd' });
read.content.toUpperCase();
read.revision?.toFixed();
// @ts-expect-error - a document reply has no `mimeType`
read.mimeType;
const runs = await client.call('project.runs', { projectId: 'p' });
runs.runs[0].execution.toLowerCase();
// @ts-expect-error - a run summary carries no request body
runs.runs[0].request;

// --- browser client uses the same contract ----------------------------------
const browser = new BrowserClient({ url: 'http://127.0.0.1:1', token: 't', expiresAt: '', methods: [] });
// @ts-expect-error - the browser client rejects an unpublished method too
void browser.call('document.saveAll', {});
const page = await browser.call('data.page', { projectId: 'p', resource: { id: 'r', version: 'v' }, offset: 0, limit: 10 });
page.rows.length;
// @ts-expect-error - a table page has no `entities`
page.entities;

// --- the dynamic boundary stays narrow --------------------------------------
// An untrusted name is still acceptable where its value is checked; after the check
// the pair is typed, and elsewhere the body remains `unknown`.
const dynamic: string = 'document.read';
const accepted = readOperation(dynamic, { projectId: 'p', documentId: 'd' });
if (accepted.ok) {
  const method: RhoMethod = accepted.request.method;
  method.toLowerCase();
}
// A body that does not match the named operation comes back as a rejection, not as
// an accepted request: the reader never invents the missing field.
const rejected = readOperation('document.read', { projectId: 'p' });
if (rejected.ok) {
  // @ts-expect-error - the missing documentId cannot be read from a rejected request
  rejected.request.body.documentId.toUpperCase();
}

// --- usable in both directions ----------------------------------------------
const input: RhoInput<'document.save'> = { projectId: 'p', documentId: 'd', expectedVersion: 1, expectedDiskDigest: null };
const output: RhoOutput<'document.save'>['path'] = client.connection.url;
void input; void output;
