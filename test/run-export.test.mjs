import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';
import { runtime } from '../dist/runtime.js';
import { digest } from '@rho-workspace/plugin-contracts';

// W6 (docs/WORKSPACE-PLAN.md): a run exports as ordinary files with where they came from and
// what was checked. A declared file the run did not write, or that no longer matches the
// inventory it wrote, is named and left out; unsaved script text leaves only by choice.
async function poll(read, predicate, label, attempts = 300) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (predicate(value)) return value; await setTimeout(100); }
  throw new Error('Timed out: ' + label);
}
// Writes a table and a figure, declares a third file it never writes, and lists what it wrote
// in an inventory using base R only.
const script = [
  'out <- commandArgs(trailingOnly = TRUE)[1]',
  'write.csv(data.frame(id = c("s1", "s2"), value = c(1.5, 2.5)), file.path(out, "table.csv"), row.names = FALSE)',
  'writeLines(\'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\', file.path(out, "figure.svg"))',
  'files <- c("table.csv", "figure.svg")',
  'entries <- vapply(files, function(f) { p <- file.path(out, f); sprintf(\'{"path":"%s","bytes":%d,"sha256":"%s"}\', f, as.integer(file.size(p)), unname(tools::sha256sum(p))) }, "")',
  'writeLines(sprintf(\'{"schemaVersion":1,"complete":true,"artifacts":[%s]}\', paste(entries, collapse = ",")), file.path(dirname(out), "inventory.json"))',
  'message("wrote ", length(files), " files")', ''
].join('\n');
const declared = [{ path: 'table.csv', kind: 'file', format: { mimeType: 'text/csv' } }, { path: 'figure.svg', kind: 'file', format: { mimeType: 'image/svg+xml' } }, { path: 'never.txt', kind: 'file', format: { mimeType: 'text/plain' } }];

test('a run exports its script, outputs and provenance as ordinary files', { timeout: 90000 }, async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-export-'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), ...await runtime() }).start();
  try {
    const operator = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await operator.call('project.create', { name: 'export' });
    const file = path.join(root, 'agent.json');
    await service.agentConnection(p.id, 'agent', file, ['action.submit', 'action.lookup', 'action.export', 'document.open', 'document.edit']);
    const client = await RhoClient.fromFile(file), agent = (m, body = {}) => client.call(m, { projectId: p.id, ...body });
    await fs.writeFile(path.join(p.root, 'analysis.R'), script);
    await agent('action.submit', { operationId: 'export-run', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'analysis.R', digest: digest(script) }, args: ['--trim'], requirements: [], artifacts: declared, completion: 'inventory.json' } });
    await poll(() => agent('action.lookup', { operationId: 'export-run' }), r => r.execution === 'completed', 'the run completes');

    // The script is edited after the run and not saved: the export must be told what to do with it.
    const doc = await agent('document.open', { path: 'analysis.R' });
    await agent('document.edit', { documentId: doc.id, expectedVersion: doc.version, edits: [{ from: 0, to: 0, insert: '# next idea\n' }], undoGroup: 'later' });
    await assert.rejects(agent('action.export', { operationId: 'export-run' }), e => e.error.kind === 'condition' && e.error.details.unsaved[0].path === 'analysis.R');
    await assert.rejects(agent('action.export', { operationId: 'export-run', destination: '.rho/out', unsaved: 'leave' }), e => e.error.kind === 'scope');

    const result = await agent('action.export', { operationId: 'export-run', unsaved: 'include' });
    assert.equal(result.destination, 'exports/export-run'); assert.equal(result.partial, true); assert.equal(result.exported, 4);
    const folder = path.join(p.root, 'exports/export-run'), read = name => fs.readFile(path.join(folder, name));
    // Ordinary files under their own names: the script that ran, the unsaved text beside it, the outputs.
    assert.equal(String(await read('script/analysis.R')), script);
    assert.equal(String(await read('script/analysis.unsaved.R')), '# next idea\n' + script);
    assert.match(String(await read('outputs/table.csv')), /^"id","value"\n"s1",1.5\n/);
    assert.match(String(await read('outputs/figure.svg')), /^<svg /);
    const record = JSON.parse(String(await read('provenance.json')));
    assert.equal(record.complete, true); assert.equal(record.partial, true);
    assert.equal(record.run.operationId, 'export-run'); assert.equal(record.run.submittedBy, 'Agent'); assert.equal(record.run.exit, 'code 0');
    assert.deepEqual(record.args, ['--trim']); assert.equal(record.script.sha256, digest(script));
    const entry = name => record.files.find(f => f.path === name && f.role === 'output');
    for (const name of ['table.csv', 'figure.svg']) {
      assert.equal(entry(name).state, 'exported'); assert.equal(entry(name).check, 'matches the inventory the run wrote');
      assert.equal(entry(name).sha256, digest(await read('outputs/' + name)));
    }
    assert.equal(entry('never.txt').state, 'not-written');
    assert.equal(record.files.find(f => f.role === 'script').check, 'the code this run recorded; the file on disk is the same');
    assert.match(record.files.find(f => f.role === 'unsaved-script').check, /^unsaved text at buffer version \d+; it never ran$/);
    const text = String(await read('PROVENANCE.md'));
    assert.match(text, /^# export-run \(partial\)/); assert.match(text, /never\.txt: not written\. The run declared this file but did not write it\./);
    assert.match(text, /No run establishes that a statistical result is correct\./);

    // An export never writes into an existing folder.
    await assert.rejects(agent('action.export', { operationId: 'export-run', unsaved: 'leave' }), e => e.error.kind === 'conflict');

    // A paired tab exports too; an output changed since the run is named and left out.
    const outputs = (await agent('action.lookup', { operationId: 'export-run' })).plan.output;
    await fs.appendFile(path.join(p.root, outputs, 'table.csv'), '"s3",9\n');
    const { code } = await operator.call('session.browser.pair', { path: 'export' });
    const grant = (await (await fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: service.url }, body: JSON.stringify({ code }) })).json()).value;
    const tab = new BrowserClient({ url: service.url, ...grant });
    const again = await tab.call('action.export', { projectId: p.id, operationId: 'export-run', destination: 'exports/second', unsaved: 'leave' });
    assert.deepEqual(again.files.filter(f => f.role !== 'script').map(f => [f.path, f.state]), [['analysis.R', 'left-out'], ['table.csv', 'changed'], ['figure.svg', 'exported'], ['never.txt', 'not-written']]);
    await assert.rejects(fs.access(path.join(p.root, 'exports/second/outputs/table.csv')));
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
