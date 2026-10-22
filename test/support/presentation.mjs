import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, canonical } from '@rho-workspace/plugin-contracts';
import { RhoClient } from '../../dist/client.js';
export const caps = { inputMode: 'pull-tool-result', inboxLookup: false, inboxDeduplication: 'none', hookEmissionDeduplication: 'none', modelConsumptionAck: false, nativeExecutionDeduplication: false };
export const query = { after: 0, cursor: null, limit: 100, maxBytes: 65536 };
export async function presentationFixture(root, service, suffix = 'A', rows = 8) {
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await admin.call('project.create', { name: 'Class-' + suffix });
  const call = (method, body = {}) => admin.call(method, { projectId: project.id, ...body });
  const columns = [{ name: 'student_id', type: 'string', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }];
  const format = { encoding: 'csv', columns, key: { column: 'student_id', namespace: 'class-' + suffix } };
  const csv = 'student_id,score\n' + Array.from({ length: rows }, (_, i) => `STU-${String(i + 1).padStart(3, '0')},${i === 7 ? 180 : 70 + i}`).join('\n') + '\n';
  await fs.mkdir(path.join(project.root, 'outputs'));
  await fs.writeFile(path.join(project.root, 'original.csv'), csv);
  const source = await call('resource.register', { expectedDigest: digest(csv), declaration: { path: 'original.csv', kind: 'table', format } });
  const ref = { id: source.id, version: source.version };
  const candidateDeclaration = { path: 'outputs/candidate-v1.csv', kind: 'table', format };
  const policy = { policyVersion: 1, policyId: 'basic-tables', sourceResource: ref, candidateDeclaration, compositionId: 'results', sourceViewId: 'original', candidateViewId: 'candidate', tableComponent: { id: 'rho.table', version: '0.2.0' }, comparison: { mapping: 'equal-string', entityKey: 'student_id', namespace: format.key.namespace }, groupPresentation: { mode: 'split', axis: 'horizontal', weights: [1, 1] } };
  const file = path.join(root, suffix + '.private.json'), observerFile = path.join(root, suffix + '-observer.private.json');
  await service.agentConnection(project.id, 'session-' + suffix, file, ['binding.open', 'binding.activity']);
  await service.agentConnection(project.id, 'observer-' + suffix, observerFile, ['binding.activity.append']);
  const business = await RhoClient.fromFile(file), observer = await RhoClient.fromFile(observerFile);
  service.registerNativeAdapter({ projectId: project.id, taskId: 'grades', registrationId: 'adapter', principal: 'agent:' + digest(project.id + ':session-' + suffix).slice(0, 32), adapterPrincipal: 'agent:' + digest(project.id + ':observer-' + suffix).slice(0, 32), externalSessionId: 'session-' + suffix, transportCapabilities: caps, proof: { kind: 'claude-code-init', sessionId: 'session-' + suffix, clientVersion: '2.1.306' } });
  const binding = await business.call('binding.open', { externalSessionId: 'session-' + suffix, adapter: 'claude-code-mcp', attachment: { taskId: 'grades', role: 'business', adapterRegistrationId: 'adapter', transportCapabilities: caps } });
  await call('task.routing.put', { taskId: 'grades', expectedVersion: 0, changeId: 'route', compositionId: 'results', participants: [{ bindingId: binding.id, role: 'business' }], feedbackOwnerBindingId: binding.id, presenterBindingId: null, policyRef: digest(canonical(policy)) });
  await service.configurePresentation(project.id, policy);
  const candidateCsv = csv.replace('STU-008,180', 'STU-008,80');
  const publish = async () => {
    await fs.writeFile(path.join(project.root, candidateDeclaration.path), candidateCsv);
    const at = new Date().toISOString();
    const events = [{ sourceSeq: 0, kind: 'tool.requested', nativeToolUseId: 'actual-fixture-tool', tool: 'Bash', at, detailsRef: null, outcome: 'requested' }, { sourceSeq: 1, kind: 'tool.returned', nativeToolUseId: 'actual-fixture-tool', tool: 'Bash', at, detailsRef: null, outcome: 'returned' }, { sourceSeq: 2, kind: 'artifact.ready', nativeToolUseId: 'actual-fixture-tool', at, output: { role: 'candidate', policyRef: digest(canonical(policy)), expectedDigest: digest(candidateCsv), declaration: candidateDeclaration } }];
    return observer.call('binding.activity.append', { taskId: 'grades', bindingId: binding.id, adapterId: 'adapter', adapterEpoch: 'epoch', events });
  };
  return { project, call, policy, ref, publish, csv, candidateCsv };
}
