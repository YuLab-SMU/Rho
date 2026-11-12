// Notebook editing, completion, session boundaries and conversation Studio in real Chrome.
// RHO_NOTEBOOK_SSH and RHO_NOTEBOOK_SERVER select a disposable SSH server with R/jsonlite and
// Python; RHO_NOTEBOOK_FOLDER selects its disposable folder. The controlled ACP peer supplies
// only a conversation identity; cells execute in real R and Python, locally and over SSH.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { RhoService, RhoClient } from './support.mjs';
import { BrowserClient } from '../dist/browser.js';

const evidence = path.resolve(process.env.RHO_NOTEBOOK_EVIDENCE ?? 'work/notebook-' + Date.now());
await fs.mkdir(evidence, { recursive: true });
const root = await fs.mkdtemp('/tmp/rho-notebook-ui-');
const peer = path.join(root, 'peer.mjs');
await fs.writeFile(peer, `import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import {RhoClient} from ${JSON.stringify(new URL('../dist/client.js', import.meta.url).href)};
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
let client,projectId;
createInterface({input:process.stdin}).on('line',async line=>{const r=JSON.parse(line),reply=result=>out({id:r.id,result});
if(r.method==='initialize')reply({protocolVersion:1,agentCapabilities:{}});
if(r.method==='session/new'){
 const file=r.params.mcpServers[0].env.find(e=>e.name==='RHO_AGENT_CONNECTION').value;
 const connection=JSON.parse(await fs.readFile(file,'utf8'));client=new RhoClient(connection);projectId=connection.projectId;
 reply({sessionId:'notebook-ui'});
}
if(r.method==='session/prompt'){
 const update=update=>out({method:'session/update',params:{sessionId:'notebook-ui',update}});
 update({sessionUpdate:'tool_call',toolCallId:'cell',title:'mcp__rho__rho_call',kind:'execute',status:'in_progress',rawInput:{operation:'kernel.run'}});
 await client.call('kernel.run',{projectId,language:'python',code:'studio_value = 50\\nprint(studio_value)',purpose:'A cell in the conversation',changeId:'studio-cell',waitMs:30000});
 update({sessionUpdate:'tool_call_update',toolCallId:'cell',status:'completed'});
 reply({stopReason:'end_turn'});
}});`);
const report = { passed: false, checks: [], remote: !!process.env.RHO_NOTEBOOK_SERVER, peer: 'controlled ACP identity, no model', browserErrors: [] };
const pass = name => { report.checks.push(name); console.log('ok · ' + name); };
async function poll(read, accept, label) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out: ' + label);
}
let service, browser, page;
try {
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: 'Rscript', ssh: process.env.RHO_NOTEBOOK_SSH,
    claudeAcp: { command: { file: process.execPath, args: [peer] } } }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken }), person = new BrowserClient({ url: service.url });
  const project = await admin.call('project.create', { name: 'Notebook checks 中文' });
  const call = (method, body = {}) => person.call(method, { projectId: project.id, ...body });
  const notebook = (id, title, own) => ({ id, kind: 'view', component: 'rho.notebook', version: '1', props: { title, ...(own ? { notebook: own } : {}) }, bindings: {} });
  await call('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'notebooks', operations: [{ op: 'replace', rootId: 'root', nodes: [
    { id: 'root', kind: 'group', children: ['local', 'remote', 'project'] }, notebook('local', 'Local notebook', 'nb-local'), notebook('remote', 'Server notebook', 'nb-remote'), notebook('project', 'Project notebook'),
  ] }] });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', e => report.browserErrors.push(e.message));
  page.on('response', async response => {
    if (!response.url().endsWith('/kernel.complete')) return;
    const got = await response.json().catch(() => null);
    report.completions ??= [];
    report.completions.push({ line: response.request().postDataJSON()?.line, state: got?.value?.state, items: got?.value?.items?.map(i => i.label), problem: got?.value?.problem });
  });
  await page.goto(service.url + '/#project=' + project.id);
  await page.locator('.nav-workspace').first().click();
  const cells = () => call('kernel.read', { limit: 500 });
  let n = 0;
  const run = async (language, code, own, client = person) => {
    const got = await client.call('kernel.run', { projectId: project.id, language, code, ...(own ? { notebook: own } : {}), changeId: 'cell-' + ++n, waitMs: 30000 });
    assert.equal(got.cell.state, 'done', got.cell.problem ?? JSON.stringify(got.cell.outputs));
    return got.cell;
  };
  const fillEdit = async (cell, code) => {
    const view = page.locator('#cell-' + cell.cellId); await view.waitFor();
    await view.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = view.locator('.nb-edit .cm-content'); await editor.click();
    await page.keyboard.press('Meta+A'); await page.keyboard.type(code); return editor;
  };
  const edit = async (cell, code, state = 'done') => {
    await fillEdit(cell, code); await page.keyboard.press('Shift+Enter');
    const got = await poll(cells, r => r.cells.some(c => c.replaces === cell.cellId && !['queued', 'running'].includes(c.state)), 'edited cell ends');
    const next = got.cells.findLast(c => c.replaces === cell.cellId);
    assert.equal(next.state, state, next.problem ?? JSON.stringify(next.outputs));
    await page.locator('#cell-' + next.cellId + '.' + state).waitFor(); return next;
  };
  const shot = name => page.screenshot({ path: path.join(evidence, name + '.png') });
  for (const remote of [false, ...(report.remote ? [true] : [])]) {
    const own = remote ? 'nb-remote' : 'nb-local', label = remote ? 'SSH server' : 'local';
    if (remote) {
      await call('kernel.place.set', { place: { placeId: 'test-server', label: 'Disposable Linux server', via: 'ssh', destination: process.env.RHO_NOTEBOOK_SERVER, folder: process.env.RHO_NOTEBOOK_FOLDER ?? '/work/followup' }, use: { r: 'test-server', python: 'test-server' } });
      assert.equal((await call('kernel.place.check', { placeId: 'test-server' })).check.ok, true);
    }
    await page.getByRole('tab', { name: remote ? 'Server notebook' : 'Local notebook', exact: true }).click();
    const r = await run('r', 'de <- data.frame(gene=c("A", "B"), score=c(1, 2))\nmean(de$score)', own);
    await fillEdit(r, 'de$sc'); await page.keyboard.press('Control+Space');
    await page.getByRole('option').filter({ hasText: 'score' }).waitFor(); await shot((remote ? 'server' : 'local') + '-r-names');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    const r2 = await edit(r, 'mean(de$score) + 1');
    assert.match(r2.outputs.map(o => o.text ?? '').join(''), /2.5/);
    let py = await run('python', 'def summarize(data, *, precision=2):\n    return round(sum(data), precision)\nsummary_value = 41\nprint(summary_value)', own);
    await fillEdit(py, 'summarize([1, 2], pre'); await page.keyboard.press('Control+Space');
    await page.getByRole('option').filter({ hasText: 'precision' }).waitFor(); await shot((remote ? 'server' : 'local') + '-python-arguments');
    // CodeMirror ignores acceptance keys for 75 ms after a list opens.
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#cell-' + py.cellId + ' .nb-edit .cm-content').innerText(), /precision=\)$/);
    await page.keyboard.press('Escape');
    await fillEdit(py, 'import jso'); await page.keyboard.press('Control+Space');
    await page.getByRole('option').filter({ hasText: /^json/ }).first().waitFor();
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    const beforeCount = (await cells()).cells.length;
    py = await edit(py, 'print(summary_value + 1)');
    assert.equal((await cells()).cells.length, beforeCount + 1, 'completion and Escape add no cell');
    const earlier = page.locator('#cell-' + py.cellId).getByRole('button', { name: '1 earlier run', exact: true });
    await earlier.click(); assert.match(await page.locator('#cell-' + py.cellId + ' .nb-earlier').innerText(), /summary_value = 41/);
    const failed = await edit(py, '1 / 0', 'error');
    py = await edit(failed, 'print(43)');
    assert.match(py.outputs.map(o => o.text ?? '').join(''), /43/);
    await call('kernel.stop', { sessionId: py.sessionId });
    const afterEnd = await edit(py, 'print(99)');
    assert.notEqual(afterEnd.sessionId, py.sessionId);
    const order = await page.locator('.nb-cells > li').evaluateAll(rows => rows.map(row => ({ id: row.id, ended: row.matches('.nb-mark.ended') })));
    const index = order.findIndex(row => row.id === 'cell-' + afterEnd.cellId);
    assert.ok(order.slice(0, index).some(row => row.ended), 'a rerun in a new session follows the old session end');
    assert.ok(await page.locator('#cell-' + py.cellId).count(), 'the old session keeps its own result');
    await shot((remote ? 'server' : 'local') + '-new-session');
    pass(label + ': R and Python completion in the editor, Escape, in-place runs, earlier outputs, error repair and a rerun after session end');
  }
  // Actual conversation Studio scoping, with real cells under the controlled peer's grant.
  await call('kernel.place.set', { use: { r: 'local', python: 'local' } });
  const started = await call('conversation.start', { changeId: 'studio', text: 'Notebook conversation checks' });
  const conversationId = started.conversation.conversationId;
  await poll(() => call('conversation.read', { conversationId }), r => r.conversation.principal && r.turns.at(-1)?.state !== 'running', 'conversation ready');
  const conversationCell = (await cells()).cells.find(c => c.purpose === 'A cell in the conversation');
  assert.ok(conversationCell, 'the controlled peer ran a real cell through its conversation grant');
  await page.reload();
  await page.locator('.nav-session').filter({ hasText: 'Notebook conversation checks' }).click();
  await page.locator('#cell-' + conversationCell.cellId).waitFor();
  const studio = await edit(conversationCell, 'print(studio_value + 1)');
  assert.match(studio.outputs.map(o => o.text ?? '').join(''), /51/);
  await fillEdit(studio, 'studio_val'); await page.keyboard.press('Control+Space');
  await page.getByRole('option').filter({ hasText: 'studio_value' }).waitFor();
  await shot('conversation-studio-names'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // A frozen time in that same Studio is read-only.
  const replay = page.getByRole('slider', { name: 'Moment shown', exact: true });
  if (await replay.count()) {
    await replay.focus(); await page.keyboard.press('Home');
    await poll(() => replay.getAttribute('aria-valuetext'), value => value !== 'Now', 'a past moment is shown');
    assert.equal(await page.locator('.nb-actions button').count(), 0, 'replay offers no edits or runs');
  }
  pass('conversation Studio: the Agent cell is visible, the person edits in the same session and completes its values');
  assert.deepEqual(report.browserErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.message; process.exitCode = 1;
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close(); await service?.close();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failure: report.failure, evidence }));
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
}
