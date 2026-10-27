import { objectSchema as obj } from '@rho-workspace/plugin-contracts';
const text = { type: 'string' }, count = { type: 'integer', minimum: 0 };
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const array = (items: object, maxItems: number) => ({ type: 'array', items, maxItems });
export function projectWorkSchema(observation: object) {
  return obj({
    projectId: text, cursor: count, observedAt: text,
    notes: obj({ path: text, documentId: text, version: count, dirty: { type: 'boolean' } }, ['path']),
    sessions: array(obj({
      id: text, source: { enum: ['acp', 'claude-cli', 'native-transcript', 'external-acp'] }, sessionId: nullable(text),
      title: text, agent: text, connected: { type: 'boolean' }, lastMessage: text, omittedMessageChars: count, pendingPermissions: count, state: text, conversationId: text, streamId: text, principal: nullable(text),
      version: count, cursor: count, droppedEvents: count, retainedFrom: count,
      observation: nullable(observation), operationIds: array(text, 256), resourceRefs: array(obj({ id: text, version: text }), 256)
    }, ['id', 'source', 'sessionId', 'title', 'state', 'observation', 'operationIds', 'resourceRefs']), 80),
    files: array(obj({ path: text, state: { enum: ['observed', 'missing', 'unavailable', 'changed', 'file-byte-limit'] }, observedAt: text, bytes: count, sha256: text,
      references: array(obj({ session: text, tool: text }), 32) }, ['path', 'state', 'observedAt', 'references']), 16),
    native: obj({ state: { enum: ['available', 'unavailable'] }, message: text }),
    omitted: obj({ conversations: count, fileReferences: count, external: count })
  });
}
