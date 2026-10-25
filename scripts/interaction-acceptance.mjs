// S7 integration: actual browser + owner state + real R; optional real model
// continuation. Assertions read owners/DOM independently of expression.ts.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { RhoService, RhoClient, native, packageRoot } from './support.mjs';
import { connectMcp, callOperation, mcpToolNames } from './mcp-consumer.mjs';
import { runClaude } from './claude-consumer.mjs';
import { rulers, profiles, firstUnit, agentMarker, facts } from './rulers.mjs';
import { selectionScope } from '../dist/shell-layout.js';
const root = await fs.mkdtemp('/tmp/rho-s7-'), evidence = path.resolve(process.env.RHO_INTERACTION_EVIDENCE ?? 'work/interaction-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
// The rulers are hard assertions; RHO_RULERS_DIAGNOSE=1 records every state without stopping.
const enforce = process.env.RHO_RULERS_DIAGNOSE !== '1', profile = profiles.shell;
const report = { scenario: 'S7-table-feedback', rulers: [], contracts: {}, passed: false, humanUsability: 'not an acceptance criterion', model: process.env.RHO_INTERACTION_MODEL === '1', checks: [], widths: [], counts: { nativeDispatches: 0 }, limits: ['Browser IME is driven through Chrome CDP, not a physical candidate-window usability test.', 'Unassigned layouts prepare a context; assigned tasks use the existing original-session feedback route.'] };
report.assets = JSON.parse(await fs.readFile(path.join(packageRoot, 'dist/web/composition.json'), 'utf8'));
let service, browser, page, mcp;
const check = name => { report.checks.push(name); process.stdout.write(name + '\n'); };
async function poll(read, predicate, label, attempts = 120) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 250)); }
  throw new Error('Timed out: ' + label);
}
try {
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), ...native, eventRetention: 64 }).start();
  const dispatch = service.bridge.call.bind(service.bridge);
  service.bridge.call = (...args) => { if (args[1] === 'submit') report.counts.nativeDispatches++; return dispatch(...args); };
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await operator.call('project.create', { name: 'Interaction trial' });
  const call = (method, input = {}) => operator.call(method, { projectId: project.id, ...input });
  const script = [
    'out <- commandArgs(trailingOnly=TRUE)[1]',
    'if ("fail" %in% commandArgs(trailingOnly=TRUE)) stop("Deliberate validation failure")',
    'result <- data.frame(id=c("001","002"),value=c(2,4))',
    'write.csv(result,file.path(out,"results.csv"),row.names=FALSE,quote=TRUE)',
    'f <- file.path(out,"results.csv")',
    'inventory <- list(schemaVersion=1L,complete=TRUE,artifacts=list(list(path="results.csv",bytes=unname(file.size(f)),sha256=digest::digest(f,algo="sha256",file=TRUE))))',
    'writeLines(jsonlite::toJSON(inventory,auto_unbox=TRUE),file.path(dirname(out),"inventory.json"))', ''
  ].join('\n');
  await fs.writeFile(path.join(project.root, 'analysis.R'), script);
  await fs.writeFile(path.join(project.root, 'notes.md'), 'Notes 🧬\n');
  const methods = ['capability.list','skill.list','skill.read','document.open','document.read','document.edit','document.save','action.submit','action.lookup','artifact.check','composition.read','composition.apply','data.page','context.read','annotation.read','annotation.reply'];
  const grant = await call('session.grant', { externalSessionId: 's7-agent', methods });
  mcp = await connectMcp(packageRoot, grant.connectionFile);
  const agent = async (method, input = {}) => { const result = await callOperation(mcp, method, input); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
  const doc = await agent('document.open', { path: 'analysis.R' }), notes = await agent('document.open', { path: 'notes.md' });
  const input = { script: { kind: 'disk', path: 'analysis.R', digest: doc.diskDigest }, args: [], requirements: [{ package: 'digest', source: 'cran' }, { package: 'jsonlite', source: 'cran' }], artifacts: [{ path: 'results.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'value', type: 'number', nullValues: [] }], key: { column: 'id', namespace: 'trial-rows' } } }], completion: 'inventory.json' };
  const execute = async (id, selected = input) => {
    await agent('action.submit', { operationId: id, action: 'r.execute', actionVersion: '0.2.0', input: selected });
    const run = await poll(() => agent('action.lookup', { operationId: id }), r => !['active','unobserved'].includes(r.execution), id);
    return run;
  };
  assert.equal((await execute('s7-initial')).execution, 'completed');
  const checked = await agent('artifact.check', { operationId: 's7-initial' }), original = checked.resources[0];
  const ref = { id: original.id, version: original.version };
  const table = { id: 'table', kind: 'view', component: 'rho.table', version: '0.2.0', props: { title: 'Results' }, bindings: { data: ref } };
  let composition = await agent('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'show-initial', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['table','notes'] }, table, { id: 'notes', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Notes' }, bindings: { document: { kind: 'live-document', documentId: notes.id } } }] }] });
  assert.equal((await call('task.map.read')).items.length, 0);
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 956 } });
  report.browser = browser.version(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const pairing = await operator.call('session.browser.pair', {});
  await page.goto(service.url + '/#pair=' + pairing.code);
  const attention = () => page.locator('.shell-bar[data-attention]');
  const notice = text => page.locator('[data-rho-interruption]').filter({ hasText: text });
  // Below 768 one view shows at a time.
  const narrowView = () => page.locator('.shell-panel > .shell-view');
  await page.locator('.project-row').first().click();
  await page.locator('.project-nav').getByRole('button', { name: /^workspace/ }).click();
  await attention().waitFor();
  await agent('document.read', { documentId: notes.id });
  await page.locator('[data-owner-view="notes"] .cm-content').waitFor({ state: 'visible' });
  await agent('data.page', { resource: ref, offset: 0, limit: 10 });
  check('Following moves the real active view from document to table, paced by the common reducer');
  const grid = () => page.locator('[data-owner-view="table"]');
  // A view's own controls (the question's actions among them) sit beside its tabs.
  const asking = () => page.locator('[data-owner-header="table"]');
  await grid().locator('.ag-row[row-index="0"] [col-id="value"]').waitFor();
  assert.equal(await grid().locator('.ag-row[row-index="0"] [col-id="value"]').textContent(), '2');
  await grid().locator('.ag-row[row-index="0"] input[type="checkbox"]').check();
  await poll(() => call('interaction.selection.read', { scope: selectionScope({ id: 'table', bindings: { data: ref } }) }), c => c.selection?.entities.includes('001'), 'exact original row selection');
  assert.equal(await attention().getAttribute('data-attention'), 'working');
  await call('interaction.selection.set', { scope: { kind: 'shared', id: 'other-table' }, expectedVersion: 0, changeId: 'other-selection', selection: { resource: ref, entities: ['002'] } });
  await asking().getByRole('button', { name: 'Ask about selected rows', exact: true }).click();
  const editor = grid().locator('.table-question-editor .cm-content'); await editor.waitFor(); await editor.click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '解释这行', selectionStart: 4, selectionEnd: 4 });
  await agent('document.read', { documentId: notes.id });
  await page.waitForTimeout(400);
  assert.equal(await editor.evaluate(e => e === document.activeElement), true);
  assert.equal(await grid().getByRole('button', { name: 'Send question', exact: true }).isDisabled(), true);
  const words = '解释原表001这一行（value=2）🧬。请将两行的value乘2，运行analysis.R生成新版表，并明确回复这个问题，关联新版结果。';
  await cdp.send('Input.insertText', { text: words });
  await poll(() => grid().getByRole('button', { name: 'Send question', exact: true }).isEnabled(), Boolean, 'confirmed question draft');
  check('real table selection and browser IME preserve active input while Agent observations arrive');
  const submitted = []; let drop = true;
  await page.route('**/api/v2/annotation.create', async route => {
    submitted.push(route.request().postDataJSON()); const response = await route.fetch();
    if (response.status() >= 400) { report.submissionFailure = await response.json(); await route.fulfill({ response }); return; }
    if (drop) { drop = false; await route.abort('failed'); } else await route.fulfill({ response });
  });
  await grid().getByRole('button', { name: 'Send question', exact: true }).click();
  await grid().getByRole('button', { name: 'Retry original question' }).waitFor();
  let thread = await poll(() => call('annotation.list'), t => { if (report.submissionFailure) throw new Error('Question refused: ' + JSON.stringify(report.submissionFailure)); return t.length === 1; }, 'retained question after lost acknowledgement');
  thread = thread[0]; assert.deepEqual(thread.anchor, { kind: 'table', resource: ref, entities: ['001'] });
  assert.equal(thread.messages[0].draft.text, words);
  await page.reload(); await grid().getByRole('button', { name: 'Retry original question' }).waitFor();
  await grid().getByRole('button', { name: 'Retry original question' }).click();
  await asking().getByText('Prepared · not fetched by Agent', { exact: true }).waitFor();
  assert.deepEqual(submitted[1], submitted[0]); assert.equal((await call('annotation.list')).length, 1);
  const originalContext = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('rho-table-question/1')).map(k => JSON.parse(sessionStorage.getItem(k))).find(v => v.contextId)?.contextId);
  assert.ok(originalContext); assert.equal(report.counts.nativeDispatches, 1);
  check('lost acknowledgement, reload and original retry create exactly one immutable question and no execution');
  await agent('context.read', { contextId: originalContext });
  await asking().getByText('Fetched by Agent · no linked response yet', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Step away', exact: true }).click();
  let output;
  if (report.model) {
    const activityStart = (await call('observation.snapshot')).activity.cursor;
    const config = path.join(evidence, 'mcp.json');
    await fs.writeFile(config, JSON.stringify({ mcpServers: { rho: { command: process.execPath, args: [path.join(packageRoot, 'node_modules/@rho-workspace/plugin-agent/dist/mcp.js')], env: { RHO_AGENT_CONNECTION: grant.connectionFile } } } }), { mode: 0o600 });
    const prompt = `Continue the real Rho table question. Read annotations.workspace with skill.read and context.read ${originalContext}. Its original annotation is ${thread.annotationId}, message ${thread.messages[0].id}. Inspect analysis.R via document ${doc.id}. Implement the person's requested doubled values in this script, retain its inventory-writing code, save conditionally, and execute exactly one operation named s7-answer with the updated script disk digest and this action input structure: ${JSON.stringify(input)}. Observe that same operation to completion; artifact.check it. Read result rows to check 001=4 and 002=8. Open a reply draft answer.md, edit it with a factual answer to the original question, and annotation.reply to the original message with expectedVersion 1, changeId s7-explicit-answer and resources:[{id,version}] naming the actual new table. Use composition.apply to rebind table to the new ref (workspace expectedVersion ${composition.version}, changeId s7-new-table, replace its table bindings with the new data ref). Do not create a task map. Use rho_index, rho_resolve, rho_call and rho_read as needed; no shell or filesystem tools. Do not guess facts or mark fetched as answered.`;
    report.modelRun = await runClaude(['--print','--output-format','json','--no-session-persistence','--strict-mcp-config','--mcp-config',config,'--tools','','--allowedTools',...mcpToolNames.map(n => 'mcp__rho__' + n),'--permission-mode','dontAsk','--setting-sources','','--max-turns','48',prompt], project.root, evidence);
    assert.equal(report.modelRun.exitCode, 0, 'Real model continuation failed; deterministic output is not substituted.');
    const actualCalls = (await call('observation.snapshot')).activity.entries.filter(e => e.cursor > activityStart);
    report.modelActivity = { calls: actualCalls.length, methods: [...new Set(actualCalls.map(e => e.method))] };
    for (const method of ['context.read', 'action.submit', 'annotation.reply']) assert.ok(actualCalls.some(e => e.method === method && e.outcome === 'returned'), 'Missing actual model call: ' + method);
    const response = await call('annotation.read', { annotationId: thread.annotationId }); output = response.messages[1]?.resources?.[0]; assert.ok(output, 'Model must explicitly link its produced table');
  } else {
    const edited = await agent('document.edit', { documentId: doc.id, expectedVersion: doc.version, expectedRevision: doc.revision, changeId: 'double-values', edits: [{ from: script.indexOf('value=c(2,4)'), to: script.indexOf('value=c(2,4)') + 12, insert: 'value=c(4,8)' }], undoGroup: 'answer' });
    const saved = await agent('document.save', { documentId: doc.id, expectedVersion: edited.version, expectedRevision: edited.revision, expectedDiskDigest: edited.diskDigest, changeId: 'save-answer' });
    assert.equal((await execute('s7-answer', { ...input, script: { ...input.script, digest: saved.diskDigest } })).execution, 'completed');
    const result = await agent('artifact.check', { operationId: 's7-answer' }); output = { id: result.resources[0].id, version: result.resources[0].version };
    const answer = await agent('document.open', { path: 'answer.md' });
    const written = await agent('document.edit', { documentId: answer.id, expectedVersion: answer.version, edits: [{ from: 0, to: 0, insert: 'Original row 001 has value 2. The new table doubles it to 4; row 002 becomes 8.' }], undoGroup: 'answer' });
    await agent('annotation.reply', { annotationId: thread.annotationId, expectedVersion: 1, changeId: 'answer', replyTo: thread.messages[0].id, draft: { documentId: answer.id, version: written.version }, resources: [output] });
    await agent('composition.apply', { compositionId: 'workspace', expectedVersion: composition.version, changeId: 'new-table', operations: [{ op: 'bind', id: 'table', bindings: { data: output } }] });
  }
  assert.notDeepEqual(output, ref);
  const newRows = await agent('data.page', { resource: output, offset: 0, limit: 10 });
  assert.deepEqual(newRows.rows.map(r => [r.id, r.value]), [['001',4],['002',8]]);
  await page.getByRole('button', { name: 'Return', exact: true }).click();
  await page.getByRole('region', { name: 'Changes while away' }).waitFor();
  await asking().getByText('Explicit Agent response', { exact: true }).waitFor();
  assert.equal(await grid().locator('.ag-row[row-index="0"] [col-id="value"]').textContent(), '2');
  assert.equal(await grid().locator('.ag-row[row-index="0"] input[type="checkbox"]').isChecked(), true);
  const final = await call('annotation.read', { annotationId: thread.annotationId });
  assert.deepEqual(final.anchor, thread.anchor); assert.equal(final.messages[0].draft.text, words); assert.equal(final.messages[1].replyTo, thread.messages[0].id); assert.ok(final.messages[1].author.startsWith('agent:'));
  assert.deepEqual(final.messages[1].resources, [output]); assert.equal((await call('task.map.read')).items.length, 0);
  const visibleTable = view => width => firstUnit(width < 768 ? narrowView() : view(), 'table');
  const settle = view => async width => { const cell = visibleTable(view)(width); await cell.waitFor(); await poll(() => cell.evaluate(c => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; }), Boolean, 'resized table columns'); };
  await rulers(page, { name: 'return', profile, first: visibleTable(grid), settle: settle(grid), transientAllowed: true, digest: true, enforce, evidence, report });
  check((report.model ? 'real Agent' : 'deterministic MCP consumer') + ' fetches the question, runs real R, explicitly replies and links its exact new table without Task Map');
  await asking().getByRole('button', { name: /Open linked result/ }).click();
  await page.locator('[data-owner-view^="result:"] .ag-row[row-index="0"] [col-id="value"]').waitFor();
  assert.equal(await page.locator('[data-owner-view^="result:"] .ag-row[row-index="0"] [col-id="value"]').textContent(), '4');
  check('reply opens new result beside the retained original; old row selection and source remain unchanged');
  assert.equal(await page.locator('[data-owner-view^="result:"] .ag-row[row-index="0"] input[type="checkbox"]').isChecked(), false);
  const savedForFault = await agent('document.read', { documentId: doc.id });
  const faultInput = { ...input, script: { ...input.script, digest: savedForFault.diskDigest } };
  assert.equal((await execute('s7-failed', { ...faultInput, args: ['fail'] })).execution, 'failed');
  await notice('s7-failed').waitFor();
  const result = () => page.locator('[data-owner-view^="result:"]');
  await rulers(page, { name: 'interrupted', profile, first: visibleTable(result), settle: settle(result), transientAllowed: true, enforce, evidence, report });
  assert.equal((await execute('s7-recovery', faultInput)).execution, 'completed');
  // docs/INTERACTION-MODEL.md: once a later run of the source completes, nobody waits on the failure.
  await poll(() => notice('s7-failed').count(), n => n === 0, 'superseded failure leaves the interruption slot');
  check('a real failed run stops interrupting once a later run of its script completes; selection does not migrate to the new version');
  // Done reading: the person keeps their own arrangement and puts the return summary away, one action each.
  await page.locator('[data-rho-interruption]').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('region', { name: 'Changes while away' }).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await poll(() => page.locator('[data-rho-layer="transient"]:visible').count(), n => n === 0, 'nothing left waiting for the person');
  await rulers(page, { name: 'complete', profile, first: visibleTable(result), settle: settle(result), enforce, evidence, report });
  for (const width of [1440,1024,768,390]) {
    await page.setViewportSize({ width, height: 956 });
    const visible = width < 768 ? narrowView() : page.locator('[data-owner-view^="result:"]');
    await visible.locator('.ag-row[row-index="0"] [col-id="value"]').waitFor();
    await poll(() => visible.locator('.ag-row[row-index="0"] [col-id="value"]').evaluate(cell => { const r = cell.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; }), Boolean, 'resized table columns');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await visible.locator('.ag-row[row-index="0"] [col-id="value"]').textContent(), '4');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // E1: the Agent's latest object and its state, by name, one action away at every width.
    const marker = await agentMarker(page, profile); assert.equal(marker.visible && marker.actionable, true, 'E1 marker at ' + width); assert.match(marker.text, /s7-recovery.*completed/, 'E1 names the object and its state at ' + width); (report.contracts.E1 ??= []).push({ width, text: marker.text });
    await page.screenshot({ path: path.join(evidence, 'complete-' + width + '.png') }); report.widths.push(width);
  }
  await page.setViewportSize({ width: 1440, height: 956 });
  await page.getByRole('button', { name: 'Recorded evidence', exact: true }).click();
  await page.getByRole('region', { name: 'Recorded activity', exact: true }).waitFor();
  assert.ok((await page.getByRole('region', { name: 'Recorded activity', exact: true }).textContent()).includes('annotation.reply'));
  await page.screenshot({ path: path.join(evidence, 'recorded-evidence.png') });
  await page.reload(); await page.locator('[data-owner-view^="result:"] .ag-row[row-index="0"] [col-id="value"]').waitFor();
  assert.equal(report.counts.nativeDispatches, 4); assert.deepEqual(errors, []);
  check('four widths, evidence access and refresh retain views without redispatch or browser exceptions');
  const resultView = page.locator('[data-owner-view^="result:"]'), runView = name => page.locator('.shell-run').filter({ has: page.getByRole('heading', { name, exact: true }) });
  // E4: the Agent's words, observed facts and verification render apart; the Agent never wears the verified colour.
  const kinds = await facts(page); report.contracts.E4 = kinds;
  for (const kind of ['agent', 'observed', 'verified']) assert.ok(kinds.kinds.includes(kind), 'E4 renders ' + kind);
  assert.equal(kinds.agentInVerified, false);
  // E2: from the artifact to the run that produced this version, and back to that exact version.
  await resultView.locator('[data-rho-producer]').click();
  await runView('s7-answer').waitFor();
  await runView('s7-answer').locator(`[data-rho-artifact="${output.id}@${output.version}"]`).click();
  await resultView.locator('.ag-row[row-index="0"] [col-id="value"]').waitFor({ state: 'visible' });
  assert.equal(await resultView.locator('.ag-row[row-index="0"] [col-id="value"]').textContent(), '4');
  report.contracts.E2 = { producer: 's7-answer', artifact: output };
  // E1: one action from the marker reaches the Agent's object.
  await page.locator('[data-rho-agent]').click(); await runView('s7-recovery').waitFor();
  // M3: the superseded failure is one click from the bar's run chain.
  await page.getByRole('button', { name: 's7-failed failed', exact: true }).click();
  await runView('s7-failed').waitFor();
  assert.match(await runView('s7-failed').locator('[data-fact="observed"]').first().textContent(), /^failed · code version 2 of 2 · submitted by the Agent at .* · stderr retained$/);
  await rulers(page, { name: 'run', profile, first: () => runView('s7-failed').locator('h2'), enforce, evidence, report });
  // E5: all of the above on a project where the Agent declared nothing.
  const declared = (await call('observation.snapshot')).activity.entries.filter(e => String(e.method).startsWith('task.map.'));
  assert.equal(declared.length, 0); assert.equal((await call('task.map.read')).items.length, 0);
  report.contracts.E5 = { taskMapCalls: 0, taskMapItems: 0 }; report.contracts.E3 = { annotationId: thread.annotationId, linked: output };
  check('E1–E5: the Agent\'s object, artifact ↔ run ↔ exact version, linked reply and three kinds of statement, without any task map');
  await page.getByRole('button', { name: 'Context & access', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect this tab', exact: true }).click();
  await page.getByRole('dialog', { name: 'Disconnect this tab?' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('heading', { name: 'This tab is disconnected', exact: true }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), []);
  assert.equal(report.counts.nativeDispatches, 4);
  check('disconnect clears this tab’s credentials, attention checkpoints and pending question references');
  report.refs = { original: ref, output, annotationId: thread.annotationId, replyTo: thread.messages[0].id, contextId: originalContext }; report.passed = true;
} catch (error) {
  report.failure = { message: error.message, kind: error.error?.kind, root };
  if (page) { await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); await fs.writeFile(path.join(evidence, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {}); await mcp?.close().catch(() => {}); await service?.close().catch(() => {});
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ passed: report.passed, failure: report.failure, report: path.join(evidence, 'report.json') }) + '\n');
}
