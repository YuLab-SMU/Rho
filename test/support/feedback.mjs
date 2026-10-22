import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, digest } from '@rho-workspace/plugin-contracts';
import { RhoClient } from '../../dist/client.js';
export const feedbackCaps = { inputMode: 'post-tool-boundary', inboxLookup: true, inboxDeduplication: 'retained-original-delivery', hookEmissionDeduplication: 'no-reemit-after-attempt', modelConsumptionAck: false, nativeExecutionDeduplication: false };
export const feedbackQuery = { after: 0, cursor: null, limit: 100, maxBytes: 65536 };
export async function feedbackFixture(root, service, suffix = 'A') {
  const admin = new RhoClient({ url: service.url, token: service.adminToken }), project = await admin.call('project.create', { name: 'Feedback-' + suffix });
  const call = (method, body = {}) => admin.call(method, { projectId: project.id, ...body });
  const original = 'student_id,score\nSTU-008,180\n'; await fs.writeFile(path.join(project.root, 'original.csv'), original);
  const resource = await call('resource.register', { expectedDigest: digest(original), declaration: { path: 'original.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'student_id', type: 'string', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }], key: { column: 'student_id', namespace: 'class-' + suffix } } } });
  const question = await call('document.open', { path: 'question.md' });
  const draft = await call('document.edit', { documentId: question.id, expectedVersion: question.version, edits: [{ from: 0, to: 0, insert: '请核对 STU-008，并保留我的修改。' }], undoGroup: 'fixture-draft' });
  const notes = await call('document.open', { path: 'explanation.md' });
  await call('document.edit', { documentId: notes.id, expectedVersion: notes.version, edits: [{ from: 0, to: 0, insert: '初始说明\n' }], undoGroup: 'fixture-notes' });
  const file = path.join(root, suffix + '-business.private.json'), adapterFile = path.join(root, suffix + '-adapter.private.json');
  const methods = ['binding.open', 'binding.activity', 'feedback.read', 'feedback.status', 'context.read', 'document.read', 'document.edit', 'document.save', 'annotation.reply'];
  const businessDescriptor = await service.agentConnection(project.id, 'native-' + suffix, file, methods);
  const adapterDescriptor = await service.agentConnection(project.id, 'observer-' + suffix, adapterFile, ['binding.activity.append']);
  const business = await RhoClient.fromFile(file), adapter = await RhoClient.fromFile(adapterFile);
  const registration = { projectId: project.id, taskId: 'grades', registrationId: 'native-adapter', principal: 'agent:' + digest(project.id + ':native-' + suffix).slice(0, 32), adapterPrincipal: 'agent:' + digest(project.id + ':observer-' + suffix).slice(0, 32), externalSessionId: 'native-' + suffix, transportCapabilities: feedbackCaps, proof: { kind: 'claude-code-init', sessionId: 'native-' + suffix, clientVersion: '2.1.306' } };
  service.registerNativeAdapter(registration);
  const binding = await business.call('binding.open', { externalSessionId: registration.externalSessionId, adapter: 'claude-code-mcp', attachment: { taskId: 'grades', role: 'business', adapterRegistrationId: registration.registrationId, transportCapabilities: feedbackCaps } });
  await call('task.routing.put', { taskId: 'grades', expectedVersion: 0, changeId: 'route', compositionId: 'results', participants: [{ bindingId: binding.id, role: 'business' }], feedbackOwnerBindingId: binding.id, presenterBindingId: null, policyRef: digest('feedback-fixture-policy') });
  await service.configureFeedback(project.id, { draftPath: 'question.md', relatedDocumentId: notes.id });
  const pair = await service.browser.createPairing(project.root), session = await service.browser.pair(pair.code), teacher = new RhoClient({ url: service.url, token: session.token });
  const input = { projectId: project.id, taskId: 'grades', compositionId: 'results', submissionId: 'question-1', draft: { documentId: draft.id, version: draft.version }, anchor: { kind: 'table', resource: { id: resource.id, version: resource.version }, entities: ['STU-008'] }, relatedDocumentId: notes.id, routeExpectation: { taskVersion: 1, targetBindingId: binding.id } };
  const submit = body => teacher.call('feedback.submit', body ?? input);
  const status = () => teacher.call('feedback.status', { projectId: project.id, taskId: 'grades', submissionId: input.submissionId, query: feedbackQuery });
  const append = events => adapter.call('binding.activity.append', { taskId: 'grades', bindingId: binding.id, adapterId: registration.registrationId, adapterEpoch: 'epoch', events });
  const privateCall = async (method, body) => {
    const response = await fetch(service.url + '/api/adapter/' + method, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adapterDescriptor.token }, body: JSON.stringify({ projectId: project.id, registrationId: registration.registrationId, externalSessionId: registration.externalSessionId, ...body }) });
    return response.json();
  };
  return { project, admin, call, business, adapter, teacher, input, submit, status, append, privateCall, binding, registration, notes, draft, session, adapterDescriptor, businessDescriptor };
}
