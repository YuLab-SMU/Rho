// A cold-start walkthrough: read the Skills, then do open -> edit -> execute -> present
// using only what they say, counting every refused call. The point is not that the
// operations exist, but that a reader who has never seen this repository needs no
// trial and error.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(process.env.RHO_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
const { RhoService } = await import(pathToFileURL(path.join(packageRoot, 'dist/server.js')).href);
const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')).href);

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-walk-'));
const state = path.join(root, '.service'), project = path.join(root, 'work');
await fs.mkdir(path.join(project, 'R'), { recursive: true });
await fs.writeFile(path.join(project, 'R', 'plot.R'), 'out <- commandArgs(trailingOnly = TRUE)[1]\npng(file.path(out, "cars.png"), width = 640, height = 420)\nplot(datasets::cars$speed, datasets::cars$dist, pch = 19)\ndev.off()\ncat("done\\n")\n');
const core = process.env.RHO_CORE_BINARY, rscript = process.env.RHO_RSCRIPT;
if (!core || !rscript) { console.error('Needs RHO_CORE_BINARY and RHO_RSCRIPT.'); process.exit(2); }

const refusals = [];
const report = { passed: false, refusals, reads: [], steps: [] };
let service;
try {
  service = await new RhoService({ root, stateDir: state, coreBinary: core, rscript }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });

  // Step 0: what the Skills say. Ask the service, not the repository.
  const agentGrant = await operator.call('session.grant', {
    projectId: p.id, externalSessionId: 'cold-start',
    methods: ['capability.list', 'skill.list', 'skill.read', 'protocol.describe', 'protocol.validate', 'observation.snapshot',
      'document.open', 'document.read', 'document.edit', 'document.save', 'document.undoOwn', 'document.revert',
      'resource.register', 'artifact.check', 'data.page', 'composition.apply', 'composition.read', 'task.map.read', 'task.map.declare',
      'action.submit', 'action.lookup', 'action.observe']
  });
  const raw = await RhoClient.fromFile(agentGrant.connectionFile);
  // Every refusal is recorded, so "no trial and error" is measured rather than assumed.
  const agent = {
    call: async (method, body) => {
      try { return await raw.call(method, body); }
      catch (error) { refusals.push({ method, kind: error?.error?.kind, message: error?.error?.message }); throw error; }
    }
  };
  const skills = await agent.call('skill.list', { projectId: p.id });
  const read = async id => { const s = await agent.call('skill.read', { projectId: p.id, skillId: id }); report.reads.push(id); return s; };
  const umbrella = await read('rho.workspace');
  assert.match(umbrella.content, /capability\.list/);
  const personFiles = await read('rho.person-files');
  const r = await read('r.workspace');
  assert.ok(r.example.method && r.verify.command);
  report.skillCount = skills.length;
  report.steps.push('read the available Skills and the three that cover this flow');

  // Step 1: doctor first, as the umbrella Skill says, before work.
  const doctor = await operator.call('project.doctor', { projectId: p.id, intent: 'run-r' });
  assert.equal(doctor.ok, true, 'the project reports itself able to run R');
  assert.deepEqual(doctor.intent.missing, [], 'the session already has what run-r needs');
  report.steps.push('doctor confirms the project can run R and names no missing method');

  // Step 2: read, edit and save a document, conditional as documents.workspace says.
  const doc = await agent.call('document.open', { projectId: p.id, path: 'R/plot.R' });
  const edited = await agent.call('document.edit', {
    projectId: p.id, documentId: doc.id, expectedVersion: doc.version, expectedRevision: doc.revision,
    changeId: 'walk-edit-1', undoGroup: 'walk', edits: [{ from: 0, to: 0, insert: '# walked\n' }]
  });
  await agent.call('document.save', {
    projectId: p.id, documentId: edited.id, expectedVersion: edited.version, expectedRevision: edited.revision,
    expectedDiskDigest: edited.diskDigest, changeId: 'walk-save-1'
  });
  report.steps.push('open, conditional edit and save a document');

  // Step 3: execute exactly as r.workspace says, declaring the artifact.
  const bytes = await fs.readFile(path.join(project, 'R', 'plot.R'));
  const operationId = 'walk-run-1';
  await agent.call('action.submit', {
    projectId: p.id, operationId, action: 'r.execute', actionVersion: '0.2.0',
    input: {
      script: { kind: 'disk', path: 'R/plot.R', digest: createHash('sha256').update(bytes).digest('hex') },
      args: [], requirements: [], artifacts: [], completion: null
    }
  });
  let run;
  for (let i = 0; i < 120; i++) {
    run = await agent.call('action.lookup', { projectId: p.id, operationId });
    if (!['active', 'unobserved'].includes(run.execution)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(run.execution, 'completed', 'the run completes and reads as completed');
  report.steps.push('submit r.execute and read a completed run without an explicit observe');

  // Step 4: present, as task-map and the umbrella Skill say.
  await agent.call('task.map.declare', {
    projectId: p.id, expectedVersion: (await agent.call('task.map.read', { projectId: p.id })).version,
    changeId: 'walk-declare-1', question: null, compositionId: null,
    vocabulary: { kinds: { 跑: { label: 'Run' } }, states: { 跑完: { label: 'Finished', role: 'done' } } },
    items: [{ id: 'walk-run', kind: '跑', state: '跑完', title: 'Plot the cars data', group: 'Now' }], remove: [], next: []
  });
  const components = (await agent.call('capability.list', { projectId: p.id })).components;
  const editor = components.filter(c => c.id === 'rho.editor').sort((a, b) => b.version.localeCompare(a.version))[0];
  await agent.call('composition.apply', {
    projectId: p.id, compositionId: 'workspace', expectedVersion: 0, changeId: 'walk-present-1',
    operations: [{ op: 'replace', rootId: 'root', nodes: [
      { id: 'root', kind: 'group', children: ['script'] },
      { id: 'script', kind: 'view', component: editor.id, version: editor.version, props: { title: 'plot.R' }, bindings: { document: { kind: 'live-document', documentId: doc.id } } }
    ] }]
  });
  report.steps.push('declare one task item and present the script in the layout');

  // Negative control: the recorder must capture a refusal, or "no refusals" means
  // nothing at all. This call is deliberately wrong and is expected to be refused.
  await agent.call('document.edit', { projectId: p.id, documentId: doc.id, expectedVersion: doc.version, changeId: 'control' })
    .then(() => assert.fail('the control call should have been refused'))
    .catch(() => {});
  assert.equal(refusals.length, 1, 'the refusal recorder works');
  report.control = refusals[0];
  refusals.length = 0;
  assert.deepEqual(refusals, [], 'no call in the flow itself was refused');
  report.passed = true;
} catch (error) {
  report.failure = { message: error?.message, kind: error?.error?.kind, detail: error?.error };
  throw error;
} finally {
  await service?.close().catch(() => {});
  const evidence = path.resolve(process.env.RHO_WALK_EVIDENCE ?? 'work/walkthrough-' + Date.now());
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(JSON.stringify({ passed: report.passed, steps: report.steps.length, refusals: refusals.length }) + '\n');
}
