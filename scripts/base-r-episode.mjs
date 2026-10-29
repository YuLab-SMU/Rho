// A real base-R project, browser person and external model. No simulated Agent fallback.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { RhoService, RhoClient, native, packageRoot } from './support.mjs';
import { runClaude } from './claude-consumer.mjs';
import { mcpToolNames } from './mcp-consumer.mjs';
import { inspectResponsive } from './browser-checks.mjs';
import { selectionScope } from '../dist/shell-layout.js';

const evidence = path.resolve(process.env.RHO_EPISODE_EVIDENCE ?? 'work/base-r-episode-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const resume = process.env.RHO_EPISODE_RESUME;
const saved = resume ? JSON.parse(await fs.readFile(path.join(resume, 'checkpoint.json'), 'utf8')) : null;
if (saved) assert.equal(saved.scenario, 'base-r-airquality');
const root = saved?.root ?? await fs.mkdtemp('/tmp/rho-airquality-');
const report = { scenario: 'base-r-airquality', root, passed: false, resumedFrom: resume ?? null,
  checks: [], responsive: [], nativeDispatches: 0, limits: [
    'Automated person in installed Chrome; no human usability study.',
    'Browser connection loss and lost question acknowledgement; no claim of Host crash or model-session resumption.',
    'Five descriptive monthly aggregates; missingness bias and causal interpretation remain unreviewed.',
    'External model: 48 turns, 10 minute process deadline; timeout retains evidence and never substitutes a deterministic reply.'
  ] };
report.assets = JSON.parse(await fs.readFile(path.join(packageRoot, 'dist/web/composition.json'), 'utf8'));
report.runtime = { node: process.version, R: execFileSync(native.rscript, ['--version'], { encoding: 'utf8' }).trim(),
  coreSha256: createHash('sha256').update(await fs.readFile(native.coreBinary)).digest('hex') };
let service, browser, page, modelPromise;
const check = name => { report.checks.push(name); process.stdout.write(name + '\n'); };
async function poll(read, predicate, label, attempts = 120) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 250)); }
  throw new Error('Timed out: ' + label);
}
const refOf = r => ({ id: r.id, version: r.version });
const marker = '# Person note: preserve this comment — 五月臭氧 🧬';
const draftText = '\nDecision pending: compare both inclusion rules before choosing. 保留原结果。';
const question = '五月这一行为什么只有24条观测？请检查 analysis.R，将纳入规则改为只排除 Ozone 缺失值，不再要求其他字段完整；重新计算五个月的样本量和平均臭氧，保留我的注释。请明确回复并关联新表和图，保留原结果供比较。';
try {
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), ...native, eventRetention: 256 }).start();
  const dispatch = service.bridge.call.bind(service.bridge);
  service.bridge.call = (...args) => { if (args[1] === 'submit') report.nativeDispatches++; return dispatch(...args); };
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const project = saved?.project ?? await operator.call('project.create', { name: 'Airquality · inclusion rules' });
  const call = (method, input = {}) => operator.call(method, { projectId: project.id, ...input });
  let doc, notes, input, original, originalPlot, thread, contextId;
  if (saved) ({ doc, notes, input, original, originalPlot, thread, contextId } = saved);
  else {
    for (const name of ['analysis.R','notes.md']) await fs.copyFile(path.join(packageRoot, 'fixtures/base-r-airquality', name), path.join(project.root, name));
    doc = await call('document.open', { path: 'analysis.R' });
    notes = await call('document.open', { path: 'notes.md' });
    input = { script: { kind: 'disk', path: 'analysis.R', digest: doc.diskDigest }, args: [], requirements: [],
      artifacts: [ { path: 'monthly-ozone.csv', kind: 'table', format: { encoding: 'csv', columns: [
        { name: 'id', type: 'string', nullValues: [] }, ...['month','n','mean_ozone'].map(name => ({ name, type: 'number', nullValues: [] }))
      ], key: { column: 'id', namespace: 'airquality-month' } } },
      { path: 'monthly-ozone.png', kind: 'media', format: { mimeType: 'image/png' } } ], completion: 'inventory.json' };
    await call('action.submit', { operationId: 'airquality-original', action: 'r.execute', actionVersion: '0.2.0', input });
    assert.equal((await poll(() => call('action.lookup', { operationId: 'airquality-original' }), r => !['active','unobserved'].includes(r.execution), 'baseline R')).execution, 'completed');
    const checked = await call('artifact.check', { operationId: 'airquality-original' });
    original = refOf(checked.resources.find(r => r.kind === 'table')); originalPlot = refOf(checked.resources.find(r => r.kind === 'media'));
    const view = (id, component, title, bindings) => ({ id, kind: 'view', component, version: '0.2.0', props: { title }, bindings });
    await call('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'airquality-start', operations: [{ op: 'replace', rootId: 'root', nodes: [
      { id: 'root', kind: 'group', children: ['original','code','notes','original-plot'] },
      view('original','rho.table','Original · complete cases',{ data: original }),
      view('code','rho.editor','analysis.R',{ document: { kind: 'live-document', documentId: doc.id } }),
      view('notes','rho.editor','Notes',{ document: { kind: 'live-document', documentId: notes.id } }),
      view('original-plot','rho.media','Original figure',{ data: originalPlot })
    ] }] });
    check('real base R baseline creates a keyed table and PNG without add-on packages');
  }
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: process.env.RHO_EPISODE_HEADED !== '1' });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read','clipboard-write'] });
  report.browser = browser.version(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.goto(service.url);
  await page.locator('.project-row').filter({ hasText: project.name }).click();
  await page.locator('.project-nav').getByRole('button', { name: /^workspace/i }).click();
  const tab = name => page.getByRole('tab', { name, exact: true });
  const grid = id => page.locator(`[data-owner-view="${id}"]`);
  const header = id => page.locator(`[data-owner-header="${id}"]`);
  const cell = (id, column) => grid(id).locator(`.ag-row[row-index="0"] [col-id="${column}"]`);
  const revealMean = async id => {
    // Wide columns stay scrollable; verify a real horizontal wheel can expose the
    // compared value, rather than mistaking an attached but clipped cell for access.
    await grid(id).locator('.ag-row').first().hover(); await page.mouse.wheel(700, 0);
    await poll(() => cell(id,'mean_ozone').evaluate(el => {
      const cell = el.getBoundingClientRect(), pane = el.closest('[data-owner-view]').getBoundingClientRect();
      return cell.width > 0 && cell.left >= pane.left && cell.right <= pane.right + 1;
    }), Boolean, 'mean column reachable by horizontal scrolling');
  };
  await cell('original','n').waitFor();
  assert.equal(await cell('original','n').innerText(), '24');
  if (!saved) {
    await tab('analysis.R').click();
    const editor = grid('code').locator('.cm-content'); await editor.click(); await page.keyboard.press('Meta+End'); await page.keyboard.insertText('\n' + marker + '\n');
    await poll(() => call('document.read', { documentId: doc.id }), d => d.content.includes(marker), 'person comment acknowledged');
    await header('code').getByRole('button', { name: 'Save document', exact: true }).click();
    await poll(() => call('document.read', { documentId: doc.id }), d => !d.dirty, 'person save');
    await tab('Notes').click();
    await grid('notes').locator('.cm-content').click(); await page.keyboard.press('Meta+End'); await page.keyboard.insertText(draftText);
    await poll(() => call('document.read', { documentId: notes.id }), d => d.content.includes(draftText) && d.dirty, 'unsaved notes acknowledged');
    await tab('Original · complete cases').click();
    // Sorting and a real owner filter must retain the stable row key rather than its position.
    await grid('original').locator('.ag-header-cell[col-id="mean_ozone"]').click();
    await grid('original').getByRole('button', { name: 'Filter', exact: true }).click();
    await grid('original').getByLabel('Column', { exact: true }).selectOption('month');
    await grid('original').getByLabel('Value', { exact: true }).fill('5');
    await grid('original').getByRole('button', { name: 'Apply', exact: true }).click();
    await poll(() => grid('original').locator('.ag-row').count(), n => n === 1, 'May filter');
    await grid('original').locator('.ag-row[row-index="0"] input[type="checkbox"]').check();
    await poll(() => call('interaction.selection.read', { scope: selectionScope({ id: 'original', bindings: { data: original } }) }), s => s.selection?.entities.includes('month-05'), 'May entity selection');
    await header('original').getByRole('button', { name: 'Ask about selected rows', exact: true }).click();
    await grid('original').locator('.table-question-editor .cm-content').click(); await page.keyboard.insertText(question);
    await poll(() => grid('original').getByRole('button', { name: 'Send question', exact: true }).isEnabled(), Boolean, 'question acknowledged');
    await page.screenshot({ path: path.join(evidence, '01-point-ask.png') });
    const posted = []; let drop = true;
    await page.route('**/api/v2/annotation.create', async route => {
      posted.push(route.request().postDataJSON()); const response = await route.fetch();
      if (response.ok() && drop) { drop = false; await route.abort('failed'); } else await route.fulfill({ response });
    });
    await grid('original').getByRole('button', { name: 'Send question', exact: true }).click();
    await grid('original').getByRole('button', { name: 'Retry original question', exact: true }).waitFor();
    thread = (await call('annotation.list'))[0]; assert.equal(thread.messages[0].draft.text, question);
    await page.screenshot({ path: path.join(evidence, '02-question-ack-lost.png') });
    await page.reload();
    await grid('original').getByRole('button', { name: 'Retry original question', exact: true }).click();
    await header('original').getByText('Prepared · not fetched by Agent', { exact: true }).waitFor();
    assert.deepEqual(posted[1], posted[0]); assert.equal((await call('annotation.list')).length, 1);
    assert.deepEqual(thread.anchor, { kind: 'table', resource: original, entities: ['month-05'] });
    await page.unroute('**/api/v2/annotation.create');
    await header('original').getByText('Prepared · not fetched by Agent', { exact: true }).click();
    await grid('original').getByRole('button', { name: 'Copy request for the Agent', exact: true }).click();
    const handoff = await page.evaluate(() => navigator.clipboard.readText());
    contextId = handoff.match(/read context ([^. ]+)/)?.[1]; assert.ok(contextId, handoff);
    await header('original').getByText('Prepared · not fetched by Agent', { exact: true }).click();
    check('person edits and Unicode question survive lost acknowledgement; original retry preserves one May/version anchor');
    const grant = await call('session.grant', { externalSessionId: 'airquality-agent', methods: [
      'capability.list','skill.list','skill.read','context.read','document.open','document.read','document.edit','document.save',
      'action.submit','action.lookup','artifact.check','data.page','annotation.read','annotation.reply'
    ] });
    const config = path.join(root, '.service', 'episode-mcp.json');
    await fs.writeFile(config, JSON.stringify({ mcpServers: { rho: { command: process.execPath,
      args: [path.join(packageRoot, 'node_modules/@rho-workspace/plugin-agent/dist/mcp.js')], env: { RHO_AGENT_CONNECTION: grant.connectionFile } } } }), { mode: 0o600 });
    const activityStart = (await call('observation.snapshot')).activity.cursor;
    await fs.writeFile(path.join(evidence, 'checkpoint.json'), JSON.stringify({ scenario: report.scenario, root, project, doc, notes, input, original, originalPlot, thread, contextId }, null, 2), { mode: 0o600 });
    const prompt = `${handoff}\nThis is a real research project. Read the context and annotations.workspace skill. Inspect the shared analysis.R document (${doc.id}) using the public operations. Implement the person's inclusion-rule change, preserve every other calculation, inventory code and person comment; save conditionally against the observed revision and disk digest. Do not touch notes.md. Execute exactly one operation with operationId airquality-ozone-only, action r.execute, actionVersion 0.2.0 and input shaped as ${JSON.stringify({ ...input, args: ['recovery-window'] })}, substituting the NEW saved script digest. The six-second argument is only a recovery-test window. Poll that SAME identity; reconnect or unknown outcomes do not authorize another execution. Check completed artifacts and inspect all result rows. Explain the original May count, actual new May count/mean, other changed months, and limits of the descriptive conclusion. Open reply.md and write a concise factual reply via the document operations, then annotation.reply to ${thread.annotationId}, original message ${thread.messages[0].id}, expectedVersion 1, changeId airquality-answer, linking BOTH actual new table and PNG refs in resources. Do not change any layout or old result. The UI person will decide how to compare. Use only rho_index, rho_resolve, rho_call and rho_read; no shell/filesystem tools. Stop once your explicit linked reply is recorded.`;
    modelPromise = runClaude(['--print','--output-format','json','--no-session-persistence','--strict-mcp-config','--mcp-config',config,
      '--tools','','--allowedTools',...mcpToolNames.map(n => 'mcp__rho__' + n),'--permission-mode','dontAsk','--setting-sources','','--max-turns','48',prompt], project.root, evidence);
    // Observe real model progress without reading context on its behalf.
    let modelDone = false; modelPromise.then(() => { modelDone = true; });
    await poll(() => call('project.runs'), ({ runs }) => {
      const run = runs.find(r => r.operationId === 'airquality-ozone-only');
      if (!run && modelDone) throw new Error('Model stopped without the requested operation; no deterministic fallback.');
      return run?.execution === 'active';
    }, 'real model submits its managed R execution', 2400);
    const running = await call('action.lookup', { operationId: 'airquality-ozone-only' }); report.recovery = { original: running };
    await page.context().setOffline(true);
    await page.getByText('Offline', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, '03-offline-during-run.png') });
    check('real Agent submitted R; browser disconnected while that original operation was active');
    report.modelRun = await modelPromise; modelPromise = null;
    assert.equal(report.modelRun.exitCode, 0, 'Real model failed; see retained model evidence.');
    const modelResult = JSON.parse(await fs.readFile(path.join(evidence, 'claude-result.json'), 'utf8'));
    report.modelRun.result = modelResult.subtype; report.modelRun.turns = modelResult.num_turns;
    report.modelRun.usage = modelResult.usage;
    assert.equal(modelResult.is_error, false); assert.equal(modelResult.subtype, 'success');
    await page.context().setOffline(false);
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await header('original').getByText('Explicit Agent response', { exact: true }).waitFor();
    const after = await call('action.lookup', { operationId: 'airquality-ozone-only' });
    report.recovery.after = after; assert.equal(after.execution, 'completed');
    assert.deepEqual(after.core, running.core); assert.equal(after.requestDigest, running.requestDigest);
    assert.ok(running.native?.record?.operation_id);
    assert.equal(after.native.record.operation_id, running.native.record.operation_id);
    assert.deepEqual(after.native.record.key, running.native.record.key);
    const entries = (await call('observation.snapshot')).activity.entries.filter(e => e.cursor > activityStart && e.principal.startsWith('agent:'));
    report.modelActivity = { entries };
    for (const method of ['context.read','document.edit','document.save','action.submit','artifact.check','annotation.reply'])
      assert.ok(entries.some(e => e.method === method && e.outcome === 'returned'), 'Missing real model call: ' + method);
    const answer = await call('annotation.read', { annotationId: thread.annotationId });
    assert.equal(answer.messages.length, 2); assert.ok(answer.messages[1].author.startsWith('agent:'));
    report.modelReply = answer.messages[1];
    check('real Agent reads the frozen question, conditionally edits/saves, checks actual R output and records a linked reply');
  }
  const answer = await call('annotation.read', { annotationId: thread.annotationId });
  assert.deepEqual(answer.anchor, thread.anchor); assert.equal(answer.messages[0].draft.text, question);
  const checked = await call('artifact.check', { operationId: 'airquality-ozone-only' });
  const output = refOf(checked.resources.find(r => r.kind === 'table')), plot = refOf(checked.resources.find(r => r.kind === 'media'));
  assert.deepEqual(answer.messages[1].resources.map(r => JSON.stringify(r)).sort(), [output, plot].map(r => JSON.stringify(r)).sort());
  const before = await call('data.page', { resource: original, offset: 0, limit: 10 });
  const after = await call('data.page', { resource: output, offset: 0, limit: 10 });
  // Independent oracle uses a direct base-R aggregate, not the Agent's script or explanation.
  const oracle = execFileSync(native.rscript, ['--vanilla','-e', 'x<-datasets::airquality; for(m in 5:9) { z<-x$Ozone[x$Month==m]; cat(m,sum(!is.na(z)),mean(z,na.rm=TRUE),"\\n") }'], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  assert.deepEqual(before.rows.map(r => r.n), [24,9,26,23,29]);
  for (const [i, r] of after.rows.entries()) {
    assert.equal(r.id, 'month-0' + oracle[i][0]); assert.equal(r.n, oracle[i][1]); assert.ok(Math.abs(r.mean_ozone - oracle[i][2]) < 1e-4);
  }
  assert.equal(after.rows.length, 5); assert.notDeepEqual(output, original); assert.notDeepEqual(plot, originalPlot);
  assert.ok((await fs.readFile(path.join(project.root, 'analysis.R'), 'utf8')).includes(marker));
  const notesState = await call('document.read', { documentId: notes.id }); assert.ok(notesState.dirty && notesState.content.includes(draftText));
  report.comparison = { original, output, originalPlot, plot, before: before.rows, after: after.rows, oracle };
  await header('original').getByText('Explicit Agent response', { exact: true }).waitFor();
  // A model reply cannot silently rebind the original view or migrate its selection.
  assert.equal(await cell('original','n').innerText(), '24');
  assert.equal(await grid('original').locator('.ag-row[row-index="0"] input[type="checkbox"]').isChecked(), true);
  await header('original').getByRole('button', { name: 'Open linked result · ' + output.version.slice(0, 8), exact: true }).click();
  const resultId = await page.locator('[data-owner-view^="result:"]').filter({ has: page.locator('.ag-root') }).getAttribute('data-owner-view');
  await cell(resultId,'n').waitFor(); assert.equal(await cell(resultId,'n').innerText(), '26');
  assert.equal(await grid(resultId).locator('.ag-row[row-index="0"] input[type="checkbox"]').isChecked(), false);
  if (!await cell('original','n').isVisible()) {
    await page.getByText('Arrange views', { exact: true }).click();
    await page.screenshot({ path: path.join(evidence, '04-arrange-linked-result.png') });
    await page.locator('.view-menu').getByRole('button', { name: 'Split right', exact: true }).click();
  }
  await cell('original','n').waitFor(); await cell(resultId,'n').waitFor();
  const left = await grid('original').boundingBox(), right = await grid(resultId).boundingBox();
  assert.ok(left.x + left.width <= right.x + 2, 'both explicit versions visibly side by side');
  await page.screenshot({ path: path.join(evidence, '05-compare-tables.png') });
  check('person opens the exact linked result and arranges both versions side by side with separate selections');
  await page.reload(); await cell(resultId,'n').waitFor(); await cell('original','n').waitFor();
  const layout = await call('composition.read', { compositionId: 'workspace' }); report.layout = layout;
  assert.deepEqual(layout.nodes.find(n => n.id === resultId).bindings.data, output);
  assert.equal((await call('interaction.selection.read', { scope: selectionScope({ id: 'original', bindings: { data: original } }) })).selection.entities[0], 'month-05');
  await inspectResponsive(page, { name: 'comparison', evidence, report, settle: async width => {
    if (width < 768) await tab('Original · complete cases').click();
    await cell('original','n').waitFor(); await revealMean('original');
    assert.equal(Number(await cell('original','mean_ozone').locator('span[title]').getAttribute('title')), before.rows[0].mean_ozone);
    if (width < 768) await tab('monthly-ozone.csv').click();
    await cell(resultId,'n').waitFor(); await revealMean(resultId);
    assert.equal(Number(await cell(resultId,'mean_ozone').locator('span[title]').getAttribute('title')), after.rows[0].mean_ozone);
  } });
  await tab('Notes').click(); await grid('notes').locator('.cm-content').waitFor();
  await poll(() => grid('notes').innerText(), text => text.includes('Decision pending'), 'restored notes render');
  await page.screenshot({ path: path.join(evidence, '06-return-unsaved-notes.png') });
  await tab('Original figure').click();
  await grid('original-plot').locator('img').waitFor();
  await poll(() => grid('original-plot').locator('img').evaluate(img => img.complete && img.naturalWidth === 900), Boolean, 'original PNG decoded');
  // Figure access stays an ordinary view; opening it never reruns either operation.
  await tab('Original · complete cases').click();
  await header('original').getByRole('button', { name: 'Open linked result · ' + plot.version.slice(0, 8), exact: true }).click();
  const newFigure = page.locator('[data-owner-view^="result:"]').filter({ has: page.locator('img') });
  await newFigure.locator('img').waitFor();
  await poll(() => newFigure.locator('img').evaluate(img => img.complete && img.naturalWidth === 900), Boolean, 'new PNG decoded');
  await page.screenshot({ path: path.join(evidence, '07-linked-figure.png') });
  const { runs } = await call('project.runs'); assert.equal(runs.length, 2); assert.ok(runs.every(r => r.execution === 'completed'));
  if (!saved) assert.equal(report.nativeDispatches, 2); else assert.equal(report.nativeDispatches, 0);
  report.runs = runs; assert.deepEqual(errors, []);
  check('reload and narrow-screen return retain exact comparison, original selection and unsaved notes; only two native executions exist');
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  if (page) { await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
} finally {
  if (modelPromise) report.modelRun = await modelPromise;
  await browser?.close(); await service?.close();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ passed: report.passed, evidence, root, error: report.error }) + '\n');
}
