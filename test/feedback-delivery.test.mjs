import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { Fault, canonical, digest } from '@rho-workspace/plugin-contracts';
import { AgentContext } from '@rho-workspace/plugin-agent';
import { feedbackSchemas as ownerSchemas, deliveryStoreSchema } from '@rho-workspace/plugin-agent/feedback-contract';
import { outputs as annotationOutputs } from '@rho-workspace/plugin-annotations/contract';
import { RhoService } from '../dist/server.js';
import { protocol } from '../dist/protocol.js';
import { feedbackFixture, feedbackQuery } from './support/feedback.mjs';
const at = '2026-10-21T00:00:00Z';
const event = (sourceSeq, kind, nativeToolUseId, extra = {}) => ({ sourceSeq, kind, nativeToolUseId, tool: 'Read', at, detailsRef: null, outcome: kind === 'tool.requested' ? 'requested' : 'returned', ...extra });
async function fixture(config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-feedback-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing', plugins: ['documents', 'files', 'tables', 'annotations', 'agent'], ...config }).start();
  return { root, service, close: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
const readInput = (submission, fetchId = 'fetch-1', maxBytes = 65536) => ({ taskId: 'grades', deliveryId: submission.delivery.deliveryId, contextId: submission.contextId, fetchId, query: { ...feedbackQuery, maxBytes } });
test('feedback public/owner schemas are frozen and annotation outputs precisely validate real retained messages', async () => {
  for (const [method, name] of [['feedback.submit', 'FeedbackSubmitInput'], ['feedback.read', 'FeedbackReadInput'], ['feedback.status', 'DeliveryStatusInput']]) {
    const source = structuredClone(protocol.operations[method]); delete source.properties.projectId; source.required = source.required.filter(x => x !== 'projectId'); assert.deepEqual(source, ownerSchemas[name]);
  }
  const f = await fixture();
  try {
    const a = await feedbackFixture(f.root, f.service), s = await a.submit(), thread = await a.call('annotation.read', { annotationId: s.annotation.annotationId });
    assert.deepEqual(protocol.responses['annotation.read'], annotationOutputs['annotation.read']);
    const ajv = new Ajv({ strict: false, allowUnionTypes: true }); ajv.addFormat('date-time', true);
    assert.ok(ajv.validate(protocol.responses['annotation.read'], thread), JSON.stringify(ajv.errors));
    assert.ok(ajv.validate(protocol.responses['feedback.submit'], s), JSON.stringify(ajv.errors));
    const store = JSON.parse(await fs.readFile(path.join(a.project.root, '.rho/plugins/agent/delivery.json')));
    assert.ok(ajv.validate(deliveryStoreSchema, store), JSON.stringify(ajv.errors));
  } finally { await f.close(); }
});
test('feedback submission is idempotent, freezes original STU-008 and recovers committed messages after thread advancement', async () => {
  const f = await fixture();
  const prepare = AgentContext.prototype.prepareFeedbackContext;
  try {
    const a = await feedbackFixture(f.root, f.service);
    let once = true;
    AgentContext.prototype.prepareFeedbackContext = async function(...args) { if (once) { once = false; throw new Fault('unavailable', 'injected context interruption'); } return prepare.apply(this, args); };
    const pending = await a.submit();
    assert.equal(pending.stages.annotation, 'committed'); assert.equal(pending.stages.context, 'pending');
    AgentContext.prototype.prepareFeedbackContext = prepare;
    const reply = await a.call('document.open', { path: 'reply.md' });
    const draft = await a.call('document.edit', { documentId: reply.id, expectedVersion: 1, edits: [{ from: 0, to: 0, insert: 'A separate reply advanced this thread.' }], undoGroup: 'reply' });
    await a.call('annotation.reply', { annotationId: pending.annotation.annotationId, expectedVersion: 1, changeId: 'advance', replyTo: pending.annotation.messageId, draft: { documentId: draft.id, version: draft.version } });
    const results = await Promise.all([a.submit(), a.submit()]); assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].stages.queue, 'queued'); assert.equal(results[0].annotation.submittedVersion, 1);
    await a.call('document.edit', { documentId: a.draft.id, expectedVersion: a.draft.version, edits: [{ from: 0, to: 0, insert: 'Later draft changes\n' }], undoGroup: 'later' });
    assert.deepEqual(await a.submit(), results[0]);
    await assert.rejects(a.submit({ ...a.input, relatedDocumentId: null }), e => e.error.kind === 'conflict');
    const read = await a.business.call('feedback.read', readInput(results[0]));
    assert.equal(read.feedback.source.rows[0].score, 180); assert.equal(read.feedback.messageText, '请核对 STU-008，并保留我的修改。');
    assert.equal((await a.status()).responses[0].fromAssignedBusiness, false);
  } finally { AgentContext.prototype.prepareFeedbackContext = prepare; await f.close(); }
});
test('lost runtime ACK reconciles the original inbox after worker replacement and never accepts or emits it twice', async () => {
  const f = await fixture();
  try {
    const a = await feedbackFixture(f.root, f.service), s = await a.submit();
    let accepts = 0, lookups = 0;
    f.service.selectFeedbackTransport(a.project.id, a.registration.registrationId, { accept: async e => { accepts++; await f.service.acceptFeedback(e); throw new Error('Injected lost runtime ACK'); }, lookup: async e => { lookups++; return f.service.lookupFeedback(e); } });
    const unknown = await f.service.stepFeedback(a.project.id, a.input.submissionId);
    assert.equal(unknown.action, 'accept'); assert.equal(unknown.state, 'unknown');
    let status = await a.status(); assert.equal(status.queue.attempts, 1); assert.equal(status.queue.enqueueAck, 'not-observed'); assert.equal(status.queue.inboxReceipt.emission, 'not-attempted');
    f.service.selectFeedbackTransport(a.project.id, a.registration.registrationId, { accept: async () => { accepts++; throw new Error('Must not be called'); }, lookup: async e => { lookups++; return f.service.lookupFeedback(e); } });
    const reconciled = await f.service.stepFeedback(a.project.id, a.input.submissionId);
    assert.equal(reconciled.action, 'lookup'); assert.equal(reconciled.state, 'accepted'); assert.equal(accepts, 1); assert.equal(lookups, 1);
    await a.append([event(0, 'tool.requested', 'boundary-1')]);
    const first = await a.privateCall('feedback.next', { nativeToolUseId: 'boundary-1' }); assert.equal(first.ok, true); assert.equal(first.value.delivery.deliveryId, s.delivery.deliveryId);
    const again = await a.privateCall('feedback.next', { nativeToolUseId: 'boundary-1' }); assert.equal(again.value.delivery, null);
    status = await a.status(); assert.equal(status.queue.inboxReceipt.emission, 'attempt-recorded');
    await a.privateCall('feedback.emitted', { nativeToolUseId: 'boundary-1', deliveryId: s.delivery.deliveryId });
    assert.equal((await a.status()).queue.inboxReceipt.emission, 'emitted');
    await f.service.stepFeedback(a.project.id, a.input.submissionId); assert.equal(accepts, 1);
  } finally { await f.close(); }
});
test('exact original business fetch is isolated, bounded and distinguished from the actual native tool return', async () => {
  const f = await fixture();
  try {
    const a = await feedbackFixture(f.root, f.service), b = await feedbackFixture(f.root, f.service, 'B'), s = await a.submit();
    await assert.rejects(b.business.call('feedback.read', { ...readInput(s), projectId: a.project.id }), e => e.error.kind === 'scope');
    const foreignFile = path.join(f.root, 'foreign.private.json'); await f.service.agentConnection(a.project.id, 'foreign', foreignFile, ['feedback.read', 'context.read']);
    const { RhoClient } = await import('../dist/client.js'); const foreign = await RhoClient.fromFile(foreignFile);
    await assert.rejects(foreign.call('feedback.read', readInput(s)), e => e.error.kind === 'scope');
    await assert.rejects(foreign.call('context.read', { contextId: s.contextId }), e => e.error.kind === 'scope');
    await assert.rejects(a.business.call('feedback.read', readInput(s, 'small', 1024)), e => e.error.kind === 'limit' && e.error.details.requiredBytes > 1024);
    const first = await a.business.call('feedback.read', readInput(s)); assert.deepEqual(await a.business.call('feedback.read', readInput(s)), first);
    assert.equal(first.fetchReceipt.observation, 'owner-served');
    await a.append([event(0, 'tool.requested', 'read-feedback', { tool: 'mcp__rho__rho_feedback_read', fetchId: 'fetch-1' }), event(1, 'tool.returned', 'read-feedback', { tool: 'mcp__rho__rho_feedback_read', fetchId: 'fetch-1' })]);
    const status = await a.status(); assert.deepEqual(status.fetches.map(f => f.observation), ['owner-served', 'client-tool-returned']); assert.equal(status.fetches[1].nativeToolUseId, 'read-feedback');
    const paged = { projectId: a.project.id, taskId: 'grades', submissionId: a.input.submissionId, query: { ...feedbackQuery, limit: 1 } };
    const page = await a.teacher.call('feedback.status', paged); assert.equal(page.complete, false);
    await a.business.call('feedback.read', readInput(s, 'second-fetch'));
    await assert.rejects(a.teacher.call('feedback.status', { ...paged, query: { ...paged.query, cursor: page.next } }), e => e.error.kind === 'stale');
    assert.equal(f.service.bridge.owned.size, 0);
  } finally { await f.close(); }
});
test('missing inbox stays unknown without replay; full/corrupt/missing delivery storage preserves source drafts and old receipts', async () => {
  const f = await fixture({ agentDelivery: { maxRecords: 1 } });
  try {
    const a = await feedbackFixture(f.root, f.service), s = await a.submit(); let accept = 0;
    f.service.selectFeedbackTransport(a.project.id, a.registration.registrationId, { accept: async () => { accept++; throw new Error('No acknowledgement'); }, lookup: async e => ({ deliveryId: e.deliveryId, state: 'not-found', receipt: null, absenceAuthorizesReplay: false }) });
    await f.service.stepFeedback(a.project.id, a.input.submissionId);
    await f.service.stepFeedback(a.project.id, a.input.submissionId); await f.service.stepFeedback(a.project.id, a.input.submissionId); assert.equal(accept, 1);
    await assert.rejects(a.submit({ ...a.input, submissionId: 'over-limit' }), e => e.error.kind === 'limit');
    assert.equal((await a.call('document.read', { documentId: a.draft.id })).content, '请核对 STU-008，并保留我的修改。');
    const file = path.join(a.project.root, '.rho/plugins/agent/delivery.json'), original = await fs.readFile(file);
    const corrupt = JSON.parse(original); corrupt.records[0].submission.requestDigest = '0'.repeat(64);
    await fs.writeFile(file, JSON.stringify(corrupt)); await assert.rejects(a.status(), e => e.error.kind === 'storage');
    await fs.writeFile(file, '{broken'); await assert.rejects(a.status(), e => e.error.kind === 'storage');
    await fs.writeFile(file, original); await fs.rename(file, file + '.saved');
    await assert.rejects(f.service.configureFeedback(a.project.id), e => e.kind === 'storage');
    await assert.rejects(a.status(), e => e.error.kind === 'storage');
    await fs.rename(file + '.saved', file); assert.equal((await a.status()).submission.delivery.deliveryId, s.delivery.deliveryId);
  } finally { await f.close(); }
});
test('a real worker killed after runtime accept restarts with lookup only; native hook helper emits the original reference once', async () => {
  const f = await fixture(); let worker, release;
  try {
    const a = await feedbackFixture(f.root, f.service), s = await a.submit();
    let accepted, acceptCount = 0, lookupCount = 0;
    const acceptedPromise = new Promise(resolve => { accepted = resolve; }), releasePromise = new Promise(resolve => { release = resolve; });
    f.service.selectFeedbackTransport(a.project.id, a.registration.registrationId, { accept: async e => { acceptCount++; await f.service.acceptFeedback(e); accepted(); await releasePromise; throw new Error('Runtime ACK intentionally unavailable'); }, lookup: async e => { lookupCount++; return f.service.lookupFeedback(e); } });
    const descriptor = path.join(f.root, 'native.private.json');
    await fs.writeFile(descriptor, JSON.stringify({ ...a.adapterDescriptor, registrationId: a.registration.registrationId, externalSessionId: a.registration.externalSessionId }), { mode: 0o600 });
    const workerEntry = fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/claude-feedback-worker'));
    const env = { ...process.env, RHO_ADAPTER_CONNECTION: descriptor, RHO_FEEDBACK_WORKER_MAX_CYCLES: '1', RHO_FEEDBACK_WORKER_MAX_MS: '15000' };
    worker = spawn(process.execPath, [workerEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] }); worker.stdout.resume(); worker.stderr.resume();
    await Promise.race([acceptedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('Worker never reached the real durable runtime accept.')), 10000).unref())]);
    const exited = once(worker, 'exit'); worker.kill('SIGKILL'); const ended = await exited; assert.equal(ended[1], 'SIGKILL');
    release();
    const before = await a.status(); assert.equal(before.queue.attempts, 1); assert.equal(before.queue.enqueueAck, 'not-observed');
    const recovered = spawn(process.execPath, [workerEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let result = ''; recovered.stdout.on('data', bytes => { result += bytes; }); recovered.stderr.resume();
    const [code] = await once(recovered, 'exit'); assert.equal(code, 0); assert.equal(JSON.parse(result).lookupSteps, 1);
    assert.equal(acceptCount, 1); assert.equal(lookupCount, 1); assert.equal((await a.status()).queue.enqueueAck, 'observed');
    await a.append([event(0, 'tool.requested', 'real-hook-boundary')]);
    const hookEntry = fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/claude-feedback-hook'));
    async function hook() { const child = spawn(process.execPath, [hookEntry], { env, stdio: ['pipe', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.resume(); child.stdin.end(JSON.stringify({ session_id: a.registration.externalSessionId, hook_event_name: 'PostToolUse', tool_use_id: 'real-hook-boundary', tool_name: 'Read' })); await once(child, 'exit'); return output; }
    const emitted = JSON.parse(await hook()); assert.ok(emitted.hookSpecificOutput.additionalContext.includes(s.delivery.deliveryId));
    assert.equal(await hook(), ''); assert.equal((await a.status()).queue.inboxReceipt.emission, 'emitted');
  } finally { release?.(); if (worker?.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); await f.close(); }
});
test('hook helper crashes before or after stdout preserve emission uncertainty and never re-emit the original delivery', async () => {
  const f = await fixture();
  try {
    for (const mode of ['before', 'after']) {
      const a = await feedbackFixture(f.root, f.service, mode), s = await a.submit(); await f.service.stepFeedback(a.project.id, a.input.submissionId);
      await a.append([event(0, 'tool.requested', 'hook-boundary')]);
      const descriptor = path.join(f.root, mode + '.private.json');
      await fs.writeFile(descriptor, JSON.stringify({ ...a.adapterDescriptor, registrationId: a.registration.registrationId, externalSessionId: a.registration.externalSessionId }), { mode: 0o600 });
      const prelude = path.join(f.root, 'crash-' + mode + '.mjs');
      await fs.writeFile(prelude, mode === 'before' ? "process.stdout.write = () => { process.kill(process.pid, 'SIGKILL'); return true; };" : "const write = process.stdout.write.bind(process.stdout); process.stdout.write = chunk => { write(chunk, () => process.kill(process.pid, 'SIGKILL')); return true; };");
      const hookEntry = fileURLToPath(import.meta.resolve('@rho-workspace/plugin-agent/claude-feedback-hook'));
      async function hook(crash = false) {
        const child = spawn(process.execPath, [...(crash ? ['--import', prelude] : []), hookEntry], { env: { ...process.env, RHO_ADAPTER_CONNECTION: descriptor }, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', data => output += data); child.stderr.resume();
        child.stdin.end(JSON.stringify({ session_id: a.registration.externalSessionId, hook_event_name: 'PostToolUse', tool_use_id: 'hook-boundary', tool_name: 'Read' }));
        const result = await once(child, 'exit'); return { result, output };
      }
      const first = await hook(true); assert.equal(first.result[1], 'SIGKILL');
      if (mode === 'before') assert.equal(first.output, ''); else assert.ok(first.output.includes(s.delivery.deliveryId));
      assert.equal((await a.status()).queue.inboxReceipt.emission, 'attempt-recorded');
      assert.equal((await hook()).output, ''); assert.equal((await a.status()).queue.attempts, 1);
    }
  } finally { await f.close(); }
});
test('oversized whole feedback preserves its committed source/context and refuses an unfetchable queue envelope', async () => {
  const f = await fixture({ agentDelivery: { maxFeedbackObjectBytes: 256 } });
  try {
    const a = await feedbackFixture(f.root, f.service), s = await a.submit();
    assert.equal(s.stages.annotation, 'committed'); assert.equal(s.stages.context, 'prepared'); assert.equal(s.stages.queue, 'blocked'); assert.equal(s.reason, 'context-limit'); assert.equal(s.delivery, null);
    assert.deepEqual(await a.submit(), s); assert.equal((await a.status()).queue.attempts, 0);
    assert.equal((await a.call('annotation.read', { annotationId: s.annotation.annotationId })).messages[0].draft.text, '请核对 STU-008，并保留我的修改。');
    assert.equal((await a.call('document.read', { documentId: a.draft.id })).content, '请核对 STU-008，并保留我的修改。');
  } finally { await f.close(); }
});
