import { feedbackSchemas } from './feedback-contracts.js';
// Retained application wire snapshot; parity is checked against the optional owner.
import { objectSchema as obj, text, refSchema as ref } from '@rho-workspace/plugin-contracts';
const version = { type: 'integer', minimum: 1 };
const integer = { type: 'integer', minimum: 0 };
const changeId = { type: 'string', pattern: '^[A-Za-z0-9._:@-]{1,128}$' };
export const draftSchema = obj({ documentId: text, version });
export const anchorSchema = { oneOf: [
  obj({ kind: { const: 'document' }, documentId: text, version, from: integer, to: integer }),
  obj({ kind: { const: 'table' }, resource: ref, entities: { type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true, items: text } })
] };
export const inputs = {
  'annotation.create': obj({ annotationId: changeId, expectedVersion: { const: 0 }, changeId, anchor: anchorSchema, draft: draftSchema }),
  'annotation.reply': obj({ annotationId: changeId, expectedVersion: version, changeId, replyTo: text, draft: draftSchema }),
  'annotation.read': obj({ annotationId: changeId }),
  'annotation.list': obj({})
};
export const outputs = { 'annotation.create': feedbackSchemas.AnnotationThreadProfile, 'annotation.reply': feedbackSchemas.AnnotationThreadProfile, 'annotation.read': feedbackSchemas.AnnotationThreadProfile, 'annotation.list': { type: 'array', items: feedbackSchemas.AnnotationThreadProfile } };
