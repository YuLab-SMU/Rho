import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activitySummary, conversationBlocks, currentPlanEntry, shortPath, toolActivity } from '../dist/conversation-presentation.js';

const step = (value) => ({ kind: 'tool', at: '2026-10-27T10:00:00.000Z', outcome: 'returned', ...value });
const turn = (steps, extra = {}) => ({ id: 't1', by: 'person', text: 'Analyse the table', sentAt: '2026-10-27T10:00:00.000Z', state: 'completed', steps, omitted: 0, problem: null, ...extra });

test('a tool step keeps its meaning: verb, identifying input and observed location', () => {
  const bash = toolActivity(step({ tool: 'Bash', title: 'Run the analysis', toolKind: 'execute', detail: 'Rscript analysis.R --input data.csv' }), null, '/tmp/project');
  assert.equal(bash.action, 'execute'); assert.equal(bash.verb, 'Ran');
  assert.equal(bash.target, 'Rscript analysis.R --input data.csv'); assert.equal(bash.targetKind, 'command');
  assert.equal(bash.title, 'Run the analysis');
  assert.equal(toolActivity(step({ tool: 'Bash', title: 'ls -la', detail: 'ls -la' }), null).title, null);
  const read = toolActivity(step({ tool: 'Read', toolKind: 'read', title: 'Read the shared notes' }), '/tmp/project/project-notes.md', '/tmp/project');
  assert.equal(read.verb, 'Read'); assert.equal(read.target, 'project-notes.md'); assert.equal(read.targetKind, 'path');
  assert.equal(read.location, '/tmp/project/project-notes.md');
  const project = toolActivity(step({ tool: 'mcp__rho__rho_call', operation: 'data.page' }), null);
  assert.equal(project.verb, 'Called'); assert.equal(project.target, 'data.page'); assert.equal(project.targetKind, 'operation');
  const tools = toolActivity(step({ tool: 'ToolSearch', detail: 'send email' }), null);
  assert.equal(tools.verb, 'Found'); assert.equal(tools.target, 'send email'); assert.equal(tools.targetKind, 'query');
});

test('a run of actions reads as what happened, and the final words stay in the open', () => {
  const steps = [
    { kind: 'text', at: 'a', text: 'Reading the table. ' },
    step({ id: 'r1', tool: 'Read', toolKind: 'read', detail: '/tmp/p/data.csv' }),
    step({ id: 'b1', tool: 'Bash', toolKind: 'execute', detail: 'Rscript analysis.R' }),
    step({ id: 'b2', tool: 'Bash', toolKind: 'execute', detail: 'Rscript plot.R' }),
    { kind: 'text', at: 'b', text: 'The model is fitted.' }
  ];
  const blocks = conversationBlocks(turn(steps), null, '/tmp/p');
  assert.deepEqual(blocks.map(block => block.kind), ['text', 'activity', 'text']);
  assert.equal(blocks[1].summary, 'Read 1 file · Ran 2 commands');
  assert.equal(blocks[1].activities[0].target, 'data.csv');
  const streaming = conversationBlocks(turn([{ kind: 'text', at: 'a', text: 'Working' }], { state: 'running' }), null, '/tmp/p');
  assert.equal(streaming[0].streaming, true);
  const finished = conversationBlocks(turn([{ kind: 'text', at: 'a', text: 'Done' }]), null, '/tmp/p');
  assert.equal(finished[0].streaming, false);
  // The same ACP message identity can surround a tool call; keys stay unique.
  const repeated = conversationBlocks(turn([{ kind: 'text', id: 'answer', at: 'a', text: 'before' }, step({ id: 'b1', tool: 'Bash' }), { kind: 'text', id: 'answer', at: 'b', text: 'after' }]));
  assert.equal(new Set(repeated.map(block => block.key)).size, repeated.length);
});

test('a running action run stays open and a failed message is not repeated as a step', () => {
  const steps = [step({ id: 'b1', tool: 'Bash' }), step({ id: 'b2', tool: 'Bash', outcome: 'requested' }), { kind: 'error', at: 'c', text: 'Not answered.' }];
  const blocks = conversationBlocks(turn(steps, { state: 'failed', result: { message: 'Not answered.' }, problem: null }), null);
  assert.deepEqual(blocks.map(block => block.kind), ['activity']);
  assert.equal(blocks[0].running, false);
  assert.match(blocks[0].summary, /with unknown outcome/);
  const running = conversationBlocks(turn([step({ id: 'b1', tool: 'Bash', outcome: 'requested' })], { state: 'running' }), null);
  assert.equal(running[0].kind, 'activity'); assert.equal(running[0].running, true);
});

test('the plan line follows the entry in progress, then the next pending one', () => {
  const observation = { plan: { entries: [
    { content: 'Inspect', status: 'completed', priority: 'high' },
    { content: 'Fit the model', status: 'in_progress', priority: 'medium' },
    { content: 'Check the figure', status: 'pending', priority: 'medium' }] } };
  assert.equal(currentPlanEntry(observation).content, 'Fit the model');
  assert.equal(currentPlanEntry({ plan: { entries: [observation.plan.entries[0], observation.plan.entries[2]] } }).content, 'Check the figure');
  assert.equal(currentPlanEntry(null), null);
});

test('paths inside the project are named relative to it; other files keep their last two segments', () => {
  assert.equal(shortPath('/tmp/work/project/data/air.csv', '/tmp/work/project'), 'data/air.csv');
  assert.equal(shortPath('/tmp/work/project', '/tmp/work/project'), 'project');
  assert.equal(shortPath('/opt/shared/reference/genome.fa', '/tmp/work/project'), '…/reference/genome.fa');
  assert.equal(activitySummary([toolActivity(step({ tool: 'Task' }), null)]), 'Used 1 Agent tool');
});
