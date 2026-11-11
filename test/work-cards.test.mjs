// Work in progress shows one card per conversation of an Agent. Where a session was started is
// not a kind of conversation: the ways Rho comes to know one session are joined by the Agent's
// own session id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workAgent, workCards } from '../dist/external-work.js';

const base = { title: 'Plot ozone by month', state: 'completed', observation: null, operationIds: [], resourceRefs: [] };
const panel = (sessionId, more = {}) => ({ ...base, id: 'conversation:c-1', source: 'acp', sessionId, agent: 'claude-code', conversationId: 'c-1', principal: 'agent:aa', ...more });
const kept = (sessionId, more = {}) => ({ ...base, id: 'x-' + sessionId, source: 'external-session', sessionId, agent: 'claude-code', ...more });
const seen = (sessionId, more = {}) => ({ ...base, id: 'external-acp:' + sessionId, source: 'external-acp', sessionId, agent: 'codex', state: 'running', ...more });
const host = (sessionId, more = {}) => ({ ...base, id: 'activity:' + sessionId, source: 'native-transcript', sessionId, agent: 'claude-code', state: 'retained', ...more });
const cards = (sessions, boarded = false) => workCards(sessions, boarded).map(c => [c.session.id, c.open ?? null]);

test('a session known in several ways is one card that opens its conversation', () => {
  // The Agent's own files, the Host's kept activity and a window running it now: one session.
  assert.deepEqual(cards([kept('s1'), host('s1'), seen('s1')]), [['external-acp:s1', 'x-s1']], 'the live card stays and opens the listed conversation');
  assert.deepEqual(cards([kept('s1'), host('s1')]), [['x-s1', 'x-s1']]);
  // Known one way only: the card is there; it opens a conversation only where one is listed.
  assert.deepEqual(cards([seen('s2')]), [['external-acp:s2', null]]);
  assert.deepEqual(cards([host('s3')]), [['activity:s3', null]]);
  assert.deepEqual(cards([kept('s4'), kept('s5')]), [['x-s4', 'x-s4'], ['x-s5', 'x-s5']]);
});

test('a session continued in the Agent panel is that conversation, and shows while it works or waits', () => {
  assert.deepEqual(cards([panel('s1'), kept('s1'), host('s1')]), [], 'finished: listed once, on the Agent page');
  assert.deepEqual(cards([panel('s1', { state: 'running' }), kept('s1')]), [['conversation:c-1', 'c-1']]);
  assert.deepEqual(cards([panel('s1', { state: 'running' }), kept('s1')], true), [], 'the answer board already shows it answering');
  assert.deepEqual(cards([panel('s1', { state: 'running', pendingPermissions: 1 })], true), [['conversation:c-1', 'c-1']], 'a waiting choice is repeated');
});

test('a card names its Agent, never where the session began', () => {
  assert.deepEqual(['claude-code', 'codex', 'dsh', 'acp', 'WorkBuddy'].map(workAgent), ['Claude Code', 'Codex', 'DeepSeek Harness', 'Agent', 'WorkBuddy']);
});
