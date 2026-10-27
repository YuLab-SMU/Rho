import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectWork } from '../dist/project-work.js';
import { validateResponse, responseProblems } from '../dist/contract-runtime.js';

test('project work links source identities without merging native evidence, cursors or resource versions', async () => {
  const work = await projectWork({ project: { id: 'p', root: '/unused' }, cursor: 29,
    conversations: { sessions: [{ conversationId: 'c-a', backend: 'claude-acp', sessionId: 'same-text', principal: 'agent:a', title: 'A task', state: 'completed', version: 4, observation: null }], omitted: 2 },
    documents: [{ id: 'notes-owner-id', path: 'project-notes.md', version: 8, dirty: true }],
    activity: [
      { principal: 'agent:a', outcome: 'returned', operationId: 'run-a', resource: { id: 'file-a', version: 'independent-version' } },
      { principal: 'agent:a', outcome: 'rejected', operationId: 'not-accepted' },
      { principal: 'another-agent', outcome: 'returned', operationId: 'unrelated' }
    ],
    native: { streams: [{ id: 'outside', producer: 'claude', sessionId: 'same-text', nextCursor: 50, retainedFrom: 10, droppedEvents: 9 }], page: null }
  });
  assert.equal(work.sessions.length, 2, 'same text across different identity namespaces is not a proven join');
  assert.deepEqual(work.sessions[0].operationIds, ['run-a']); assert.equal(work.sessions[0].resourceRefs[0].version, 'independent-version');
  assert.equal(work.sessions[0].version, 4); assert.equal(work.sessions[1].cursor, 50); assert.equal(work.cursor, 29);
  assert.equal(work.sessions[1].droppedEvents, 9); assert.equal(work.notes.version, 8); assert.equal(work.notes.dirty, true);
  assert.ok(validateResponse('project.work.read', work), JSON.stringify(responseProblems('project.work.read')));
});
