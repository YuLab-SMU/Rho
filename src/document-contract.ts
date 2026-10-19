// Wire mirror of the selected Documents owner contract; parity is tested.
// Describing an absent owner must not import or activate that owner.
import { objectSchema as obj, text, version as digest } from '@rho-workspace/plugin-contracts';
const positive = { type: 'integer', minimum: 1 };
const integer = { type: 'integer', minimum: 0 };
const identity = { type: 'string', pattern: '^[A-Za-z0-9._:@-]{1,128}$' };
const nullableDigest = { anyOf: [digest, { type: 'null' }] };
export const receiptSchema = obj({ changeId: identity, requestDigest: digest, kind: { enum: ['edit', 'undo', 'save', 'abandon-save'] }, author: text, revision: positive, version: positive, at: text });
const change = obj({ changeId: identity, expectedRevision: integer });
export const pendingSaveSchema = obj({ requestDigest: digest, author: text, expectedDiskDigest: nullableDigest, contentDigest: digest, at: text, change }, ['requestDigest', 'author', 'expectedDiskDigest', 'contentDigest', 'at']);
const original = { id: digest, path: text, version: positive, content: { type: 'string' }, diskDigest: nullableDigest, dirty: { type: 'boolean' }, author: text, acknowledgedAt: text, undo: { type: 'array', items: obj({ content: { type: 'string' }, group: text, author: text }) } };
// The added facts are optional in old archives/fixtures, present in new owner replies.
export const documentSchema = obj({ ...original, revision: integer, receipts: { type: 'array', items: receiptSchema }, retainedFromRevision: positive, pendingSave: pendingSaveSchema, receipt: receiptSchema }, Object.keys(original));
const conditional = (properties: Record<string, unknown>) => ({ ...obj({ ...properties, changeId: identity, expectedRevision: integer }, Object.keys(properties)), dependencies: { changeId: ['expectedRevision'], expectedRevision: ['changeId'] } });
export const operationContracts = {
  'document.open': { inputSchema: obj({ path: text }), outputSchema: documentSchema, requires: [], effect: 'document' },
  'document.read': { inputSchema: obj({ documentId: digest }), outputSchema: documentSchema, requires: [], effect: 'read' },
  'document.edit': { inputSchema: conditional({ documentId: digest, expectedVersion: positive, edits: { type: 'array', items: obj({ from: integer, to: integer, insert: { type: 'string' } }), minItems: 1, maxItems: 1000 }, undoGroup: identity }), outputSchema: documentSchema, requires: [], effect: 'document' },
  'document.undo': { inputSchema: conditional({ documentId: digest, expectedVersion: positive }), outputSchema: documentSchema, requires: [], effect: 'document' },
  'document.save': { inputSchema: conditional({ documentId: digest, expectedVersion: positive, expectedDiskDigest: nullableDigest }), outputSchema: documentSchema, requires: [], effect: 'document' },
  'document.abandonSave': { inputSchema: obj({ documentId: digest, expectedVersion: positive, pendingRequestDigest: digest, changeId: identity, expectedRevision: integer }), outputSchema: documentSchema, requires: [], effect: 'document' }
} as const;
