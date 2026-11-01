import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationMarks, eventMarks, markCaption } from '../dist/timeline-events.js';

const at = s => new Date(Date.UTC(2026, 10, 1, 1, 0, s)).toISOString();
const owners = [{ conversationId: 'c-1', principal: 'agent:aa', title: 'ggplot2 demo', agent: 'Claude Code' }];
const event = (id, by, start, end, outcome = 'done', source = 'kernel.events') => ({ id, by, action: 'run', label: 'summary(fit)', where: 'R', startedAt: at(start), endedAt: end === null ? null : at(end), outcome, source });

test('each plugin event goes to the lane of whoever did it', () => {
  const marks = eventMarks([event('k-3', 'operator', 30, 31), event('k-2', 'agent:aa', 20, 22, 'failed'), event('k-1', 'browser:local', 10, null, 'running'), event('c-1', 'browser:local', 5, 6, 'done', 'console.events')], owners, Date.parse(at(40)));
  assert.deepEqual(marks.map(m => [m.key, m.lane, m.laneTitle, m.who, m.failed]), [
    ['console.events:c-1', 'person', 'You', 'person', false],
    ['kernel.events:k-1', 'person', 'You', 'person', false],
    ['kernel.events:k-2', 'c-1', 'ggplot2 demo', 'conversation', true],
    ['kernel.events:k-3', 'other', 'Outside Rho', 'other', false],
  ]);
  // A cell still running lasts until now; an ended one until it ended.
  assert.equal(marks[1].end, Date.parse(at(40)));
  assert.equal(marks[2].end, Date.parse(at(22)));
  assert.equal(markCaption(marks[1]), 'You are running summary(fit) · R');
  assert.equal(markCaption(marks[2]), 'Claude Code ran summary(fit) · R');
  assert.equal(eventMarks([{ ...event('k-9', 'browser:local', 1, 2), startedAt: 'soon' }], owners, 0).length, 0, 'an event without a time is not placed');
});

test("a conversation's share is its Agent's events and the person's since it began", () => {
  const marks = eventMarks([event('k-1', 'browser:local', 5, 6), event('k-2', 'browser:local', 15, 16), event('k-3', 'agent:aa', 20, 21), event('k-4', 'operator', 25, 26)], owners, 0);
  assert.deepEqual(conversationMarks(marks, 'c-1', Date.parse(at(10))).map(m => m.key), ['kernel.events:k-2', 'kernel.events:k-3']);
});
