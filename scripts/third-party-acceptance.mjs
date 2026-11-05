#!/usr/bin/env node
// An opt-in, real scientific episode. R packages must already be available;
// this script never installs dependencies or touches an existing R session.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.RHO_SCLET_PLUGIN ?? path.resolve(repo, '../Rho-plugins/examples/sclet-plugin');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-third-party-'));
await fs.mkdir(path.join(root, 'project'));
const service = await new RhoService({ root, stateDir: path.join(root, 'state'), rscript: process.env.RHO_RSCRIPT ?? 'Rscript', example: false }).start();
const client = new RhoClient({ url: service.url, token: service.adminToken });
const project = await client.call('project.open', { path: 'project' });
const notes = [];
let sequence = 0;
const text = cell => cell.outputs.map(output => output.text ?? '').join('\n') + (cell.error ? '\n' + JSON.stringify(cell.error) : '');
const json = value => JSON.parse(value.slice(value.indexOf('{'), value.lastIndexOf('}') + 1));
async function finished(cell) {
  for (let i = 0; i < 600; i++) {
    const current = (await client.call('kernel.read', { projectId: project.id, cellId: cell.cellId })).cells[0];
    if (['done', 'error', 'unknown', 'interrupted'].includes(current.state)) return current;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Observation deadline reached; original cell: ' + cell.cellId);
}
try {
  const plugin = await client.call('extension.install', { source });
  const invoke = (operation, input = {}, changeId = 'acceptance-' + ++sequence) => client.call('extension.call', { projectId: project.id, pluginId: plugin.id, expectedDigest: plugin.digest, operation, input, changeId });
  assert.deepEqual((await invoke('sessions')).value.sessions, []);
  async function run(operation, input = {}) {
    const receipt = await invoke(operation, input); assert.equal(receipt.state, 'completed', receipt.error);
    const cell = await finished(receipt.value.cell); notes.push({ operation, cellId: cell.cellId, state: cell.state });
    assert.equal(cell.state, 'done', text(cell)); return { receipt, cell, text: text(cell) };
  }
  const library = process.env.RHO_SCLET_LIBRARY;
  const seedCode = `${library ? '.libPaths(c(' + JSON.stringify(library) + ', .libPaths()))\n' : ''}if (!requireNamespace("sclet", quietly=TRUE)) stop("Set RHO_SCLET_LIBRARY to an existing sclet library.")\nset.seed(19)\nsce <- scuttle::mockSCE(ncells=60, ngenes=200)`;
  const seed = await client.call('kernel.run', { projectId: project.id, language: 'r', code: seedCode, purpose: 'Disposable third-party plugin trial', changeId: 'seed', waitMs: 0 });
  const seeded = await finished(seed.cell); assert.equal(seeded.state, 'done', text(seeded));
  const packages = await run('check');
  const before = json((await run('ledger', { object: 'sce', includeArtifacts: true })).text);
  await run('registry', { object: 'sce' }); await run('skill', { name: 'sclet-driver' });
  const plan = { task: 'plugin-acceptance', context_fingerprint: before.fingerprint, actions: [
    { id: 'normalize', action: 'normalize_data' },
    { id: 'hvg', action: 'find_variable_features', params: { nfeatures: 50 }, depends_on: 'normalize' },
    { id: 'scale', action: 'scale_data', depends_on: 'hvg' },
    { id: 'pca', action: 'run_pca', params: { ncomponents: 5 }, depends_on: 'scale' },
  ] };
  const validated = json((await run('validate', { object: 'sce', plan })).text); assert.equal(validated.validation.valid, true);
  const executeBody = { validationId: validated.validationId };
  const execution = await invoke('execute', executeBody, 'execute-once'); assert.equal(execution.state, 'completed', execution.error);
  const executed = await finished(execution.value.cell); assert.equal(executed.state, 'done', text(executed));
  assert.equal(json(text(executed)).status, 'completed');
  assert.equal((await invoke('execute', executeBody, 'execute-once')).value.cell.cellId, executed.cellId);
  await run('record', { object: 'sce', recordId: 'smoke-report', result: {
    task: 'plugin-acceptance', answer: 'A synthetic 200-gene, 60-cell input completed normalization, variable feature selection, scaling and PCA. This verifies software integration; no biological conclusion is claimed.',
    findings: [], evidence: [], warnings: ['Synthetic input, not evidence for a biological hypothesis.'], recommendations: [], proposed_actions: [], success_criteria: [], stop_conditions: [], context: { fingerprint: json(text(executed)).fingerprint }, metadata: { provider: 'integration-test' },
  } });
  const report = await run('report', { object: 'sce', recordId: 'smoke-report' }); assert.match(report.text, /all checks passed/);
  const after = json((await run('ledger', { object: 'sce', includeArtifacts: true })).text);
  assert.equal(after.dataset.reductions, 'PCA'); assert.equal(after.features.hvg.n, 50);
  assert.equal(json((await run('validate', { object: 'sce', plan })).text).validation.valid, false);
  await client.call('extension.manage', { pluginId: plugin.id, expectedDigest: plugin.digest, action: 'disable' });
  await assert.rejects(invoke('ledger', { object: 'sce' }), /disabled/);
  await client.call('extension.manage', { pluginId: plugin.id, expectedDigest: plugin.digest, action: 'remove' });
  assert.equal((await invoke('execute', executeBody, 'execute-once')).value.cell.cellId, executed.cellId);
  const sessions = await client.call('kernel.read', { projectId: project.id, limit: 1 });
  assert.ok(sessions.sessions.some(s => s.sessionId === seed.cell.sessionId && s.state !== 'ended'));
  const output = path.resolve(process.env.RHO_THIRD_PARTY_OUTPUT ?? path.join(repo, 'output/third-party-plugins/acceptance.json'));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ at: new Date().toISOString(), node: process.version, platform: process.platform, source, digest: plugin.digest, packages: packages.text, notes, execution: json(text(executed)), report: report.text, lifecycle: 'disable/remove retained original cell and live R session', passed: true }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, output }));
} finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
