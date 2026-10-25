// W4 exit check (docs/WORKSPACE-PLAN.md): an action the Agent proposes opens as a form bound
// to its real inputs; the person edits one and submits, and the owner dispatches it exactly
// once; a refresh during the run keeps the same operationId; a stop reads "requested" until
// Core reports the process ended; a failed run's repair context carries the real error text
// and references, and the repair links the original both ways; an unknown outcome is said as
// unknown (M4). Real Core and R throughout; the Agent is a deterministic protocol client.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { RhoClient, native, packageRoot } from './support.mjs';
import { rulers, profiles } from './rulers.mjs';
const evidence = path.resolve(process.env.RHO_ACTION_EVIDENCE ?? 'work/actions-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-actions-'), state = path.join(root, '.service');
const report = { scenario: 'W4-actions', passed: false, checks: [], rulers: [] };
const passed = (name, detail = {}) => { report.checks.push({ name, ...detail }); process.stdout.write(`ok · ${name}\n`); };
const digestOf = text => createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error('Timed out: ' + label + ' · last ' + JSON.stringify(value)?.slice(0, 400)); await sleep(200); }
}
let child, browser, orphan;
try {
  child = spawn(process.execPath, [path.join(packageRoot, 'dist/cli.js'), '--root', root, '--state-dir', state, '--core', native.coreBinary, '--rscript', native.rscript], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('Launcher readiness timed out')), 20000);
    child.stdout.on('data', d => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { const v = JSON.parse(line); if (v.ready) { clearTimeout(timer); resolve(v.ready); } } catch {} } });
  });
  const admin = await RhoClient.fromFile(path.join(state, 'connection.json'));
  const project = await admin.call('project.create', { name: 'Actions' });
  const call = (m, b = {}) => admin.call(m, { projectId: project.id, ...b });
  const grant = await call('session.grant', { externalSessionId: 'w4-agent', methods: ['action.submit', 'action.lookup', 'action.output', 'action.cancel', 'context.read', 'composition.apply', 'composition.read'] });
  const agentClient = await RhoClient.fromFile(grant.connectionFile);
  const agent = (m, b = {}) => agentClient.call(m, { projectId: project.id, ...b });
  const write = async (file, text) => { await fs.writeFile(path.join(project.root, file), text); return text; };
  const input = (file, text, args = []) => ({ script: { kind: 'disk', path: file, digest: digestOf(text) }, args, requirements: [], artifacts: [], completion: null });
  const run = (operationId, file, text, extra = {}) => ({ operationId, action: 'r.execute', actionVersion: '0.2.0', input: input(file, text), ...extra });
  const lookup = operationId => agent('action.lookup', { operationId });
  // Rho's own record of handing a run to Core: one acceptance and one delivery per dispatch.
  const dispatches = async operationId => {
    const events = JSON.parse(await fs.readFile(path.join(project.root, '.rho/rho/events.json'), 'utf8')).events.filter(e => e.subject === operationId);
    return { accepted: events.filter(e => e.type === 'operation.accepted').length, delivered: events.filter(e => e.type === 'operation.delivery').length };
  };

  // The Agent proposes one run as a form: the script, and a multiplier the person may change.
  const scale = await write('scale.R', 'args <- commandArgs(trailingOnly=TRUE)\nm <- as.numeric(args[2])\ncat("multiplier", m, "\\n")\nSys.sleep(4)\nwrite.csv(data.frame(id=c("a","b"),v=c(1,2)*m),file.path(args[1],"out.csv"),row.names=FALSE)\n');
  const proposal = input('scale.R', scale, ['2']);
  await agent('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'w4-form', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['form'] },
    { id: 'form', kind: 'view', component: 'rho.action', version: '1', props: { title: 'Scale the values', action: 'r.execute', actionVersion: '0.2.0', operationId: 'w4-form', input: proposal }, bindings: {} }] }] });
  // An action that is not registered at that version is refused before it reaches a person.
  await assert.rejects(agent('composition.apply', { compositionId: 'workspace', expectedVersion: 1, changeId: 'w4-wrong', operations: [{ op: 'insert', parentId: 'root', index: 1, node: { id: 'wrong', kind: 'view', component: 'rho.action', version: '1', props: { title: 'Wrong', action: 'r.execute', actionVersion: '9.9.9', operationId: 'w4-wrong', input: {} }, bindings: {} } }] }), e => e.error?.kind === 'invalid');

  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ready.openUrl).origin });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const form = page.locator('[data-rho-action-form="w4-form"]');
  // A reload restores whatever the tab last showed: Home, the project, or the layout itself.
  const projectRow = page.locator('.project-row').filter({ hasText: 'Actions' }), layoutRow = page.locator('.nav-row').filter({ hasText: 'workspace' }).first();
  const openLayout = async () => {
    await form.or(projectRow).or(layoutRow).first().waitFor();
    if (await form.isVisible()) return;
    if (await projectRow.isVisible()) await projectRow.click();
    await layoutRow.click();
    await form.waitFor();
  };
  await page.goto(ready.openUrl);
  await openLayout();

  // 1. The form shows the inputs the Agent proposed, as the owner's contract names them. The
  // script is pinned to the saved file the Agent proposed and is read by name, not digest.
  const args = form.getByLabel('args · one per line'), completion = form.getByLabel('completion', { exact: true });
  assert.equal(await args.inputValue(), '2');
  assert.equal(await completion.inputValue(), '');
  assert.equal(await form.locator('[data-rho-reference="script"]').innerText(), 'scale.R · the saved file the Agent proposed');
  await form.getByRole('button', { name: 'Run', exact: true }).and(page.locator(':enabled')).waitFor();
  // A value the owner would refuse is named at its field, and nothing is sent.
  await args.fill('x'.repeat(5000));
  await form.locator('.shell-field-problem').first().waitFor();
  assert.equal(await args.getAttribute('aria-invalid'), 'true');
  assert.match(await form.locator('.shell-field-problem').first().innerText(), /4096/);
  assert.ok(await form.getByRole('button', { name: 'Run', exact: true }).isDisabled());
  assert.deepEqual(await dispatches('w4-form'), { accepted: 0, delivered: 0 });
  await args.fill('3');
  await until(() => form.locator('.shell-field-problem').count(), n => n === 0, 'the edited proposal is valid');
  await form.getByRole('button', { name: 'Run', exact: true }).and(page.locator(':enabled')).waitFor();
  await rulers(page, { name: 'form', profile: profiles.shell, first: () => form.locator('h2'), enforce: true, evidence, report });
  passed('form bound to the proposed inputs, owner problems shown per field', { fields: ['script', 'args', 'completion'] });

  // 2. Submit with two clicks in one task: the owner dispatches once.
  const native1 = await page.evaluate(() => { const b = [...document.querySelectorAll('[data-rho-action-form="w4-form"] button[type=submit]')][0]; b.click(); b.click(); return true; });
  assert.ok(native1);
  await form.locator('[data-rho-submitted="w4-form"]').waitFor();
  const accepted = await until(() => lookup('w4-form'), r => !!r.native?.run_id, 'w4-form accepted by Core');
  assert.equal(accepted.principal.startsWith('browser:'), true, 'the person submitted it');
  assert.deepEqual(await dispatches('w4-form'), { accepted: 1, delivered: 1 });
  passed('edited form submitted, exactly one dispatch', { runId: accepted.native.run_id });

  // 3. A refresh while it runs shows the same operationId and dispatches nothing.
  assert.equal((await lookup('w4-form')).execution, 'active');
  await page.reload();
  await openLayout();
  await form.locator('[data-rho-submitted="w4-form"]').waitFor();
  const after = await lookup('w4-form');
  assert.equal(after.native.run_id, accepted.native.run_id);
  assert.deepEqual(await dispatches('w4-form'), { accepted: 1, delivered: 1 });
  const done = await until(() => lookup('w4-form'), r => r.execution === 'completed', 'w4-form completed');
  // The Agent follows the person's run by its operationId, and it ran with the edited value.
  const stdout = (await agent('action.output', { operationId: 'w4-form', stream: 'stdout', offset: 0, maxBytes: 4096 })).reply.value.text;
  assert.match(stdout, /multiplier 3/);
  passed('refresh mid-run kept the operationId; the edited value reached Core', { execution: done.execution });

  // 4. Stop: "requested" or "signalled" only while the process runs; "stopped" only after Core
  // reports it ended. Core is fast, so every state the page shows is recorded and checked.
  const long = await write('long.R', 'cat("started\\n")\nSys.sleep(60)\n');
  await agent('action.submit', run('w4-long', 'long.R', long));
  await until(() => lookup('w4-long'), r => r.execution === 'active', 'w4-long running');
  const runView = name => page.locator('.shell-run').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await page.locator('[data-rho-agent]').click();
  await runView('w4-long').waitFor();
  await runView('w4-long').locator('[data-rho-execution="active"]').waitFor();
  await page.evaluate(() => {
    const seen = window.__stops = [];
    const record = () => { const view = document.querySelector('.shell-run[aria-label="w4-long"]'); const stop = view?.querySelector('[data-rho-stop]'); if (stop) seen.push({ stop: stop.dataset.rhoStop, execution: view.querySelector('[data-rho-execution]')?.dataset.rhoExecution, text: stop.textContent }); };
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await runView('w4-long').getByRole('button', { name: 'Stop run', exact: true }).click();
  await runView('w4-long').locator('[data-rho-stop="stopped"]').waitFor({ timeout: 30000 });
  const stops = await page.evaluate(() => window.__stops);
  for (const s of stops) {
    if (s.stop === 'stopped') assert.notEqual(s.execution, 'active', 'stopped shown while Core reports it running: ' + JSON.stringify(s));
    else assert.ok(['requested', 'signalled'].includes(s.stop) && s.execution === 'active', JSON.stringify(s));
  }
  // Core's reply to the request is shown before the process ends, so the person sees the
  // request as a request; then the stop, once Core reports the exit.
  assert.ok(stops.some(s => ['requested', 'signalled'].includes(s.stop)), 'the request was never shown as a request: ' + JSON.stringify(stops));
  const final = stops.at(-1);
  assert.match(final.text, /^Stopped · signal \d+ · asked by a browser tab at /);
  assert.equal((await lookup('w4-long')).cancellation.requestedBy.startsWith('browser:'), true);
  passed('stop requested is not stopped; Core confirmed the stop', { states: [...new Set(stops.map(s => s.stop))], exit: final.text.split(' · ')[1] });

  // 5. A failed run: the person asks the Agent to fix it; the context carries the error text
  // and the script reference; the repair is a new identity linked both ways.
  const broken = await write('broken.R', 'cat("reading input\\n")\nstop("Deliberate failure: column x missing")\n');
  await agent('action.submit', run('w4-broken', 'broken.R', broken));
  await until(() => lookup('w4-broken'), r => r.execution === 'failed', 'w4-broken failed');
  await page.locator('[data-rho-agent]').click();
  await runView('w4-broken').locator('[data-rho-execution="failed"]').waitFor();
  // Loop S5: the cause is on the view, verbatim from stderr, and asking is the primary action.
  await runView('w4-broken').locator('.shell-run-error').getByText('Error: Deliberate failure: column x missing', { exact: true }).waitFor();
  assert.equal(await runView('w4-broken').getByRole('button', { name: 'Ask the Agent to fix', exact: true }).evaluate(b => b.classList.contains('primary')), true);
  await runView('w4-broken').getByRole('button', { name: 'Ask the Agent to fix', exact: true }).click();
  // The request goes to the Agent through the clipboard; the page never shows the context's identity.
  await runView('w4-broken').getByRole('button', { name: 'Copy request for the Agent', exact: true }).click();
  await runView('w4-broken').getByRole('button', { name: 'Copied', exact: true }).waitFor();
  const request = await page.evaluate(() => navigator.clipboard.readText());
  const contextId = request.match(/context ([a-f0-9]{64})/)?.[1];
  assert.ok(contextId && request.includes('repairOf "w4-broken"'), request);
  // The failure waits on the person, so its one interruption is allowed (as in S7's interrupted state).
  await rulers(page, { name: 'repair', profile: profiles.shell, first: () => runView('w4-broken').locator('h2'), transientAllowed: true, enforce: true, evidence, report });
  const facts = (await agent('context.read', { contextId })).run;
  assert.match(facts.error.text, /Deliberate failure: column x missing/);
  assert.deepEqual(facts.script, { kind: 'disk', path: 'broken.R', digest: digestOf(broken) });
  assert.equal(facts.execution, 'failed');
  await runView('w4-broken').getByText(/^Fetched by the Agent/).waitFor();
  const fixed = await write('broken.R', 'cat("reading input\\n")\ncat("column x present\\n")\n');
  const repair = await agent('action.submit', run('w4-fixed', 'broken.R', fixed, { repairOf: 'w4-broken' }));
  assert.equal(repair.repairOf, 'w4-broken');
  await until(() => lookup('w4-fixed'), r => r.execution === 'completed', 'w4-fixed completed');
  // Repaired, the failure stops leading: no failed colour, nothing left to ask or copy.
  await runView('w4-broken').locator('.shell-state.failed.superseded').waitFor();
  // A completed repair needs no state word; one still running or failed would name its state.
  assert.equal((await runView('w4-broken').locator('.shell-run-repair').textContent()).trim(), 'Repaired by w4-fixed');
  assert.equal(await runView('w4-broken').getByRole('button', { name: /Ask the Agent to fix|Copy request for the Agent|Copied/ }).count(), 0);
  await runView('w4-broken').getByText(/^Fetched by the Agent/).waitFor();
  await runView('w4-broken').locator('[data-rho-repaired-by="w4-fixed"]').click();
  await runView('w4-fixed').locator('[data-rho-repair-of="w4-broken"]').waitFor();
  passed('repair context holds the error text and script reference; the repair links the original', { contextId: contextId.slice(0, 12) + '…', errorBytes: facts.error.retainedBytes });

  // 6. Unknown: Core's host is killed while a run is active. Rho cannot know how it ended,
  // and the run view says exactly that.
  const waiting = await write('waiting.R', 'cat("waiting\\n")\nSys.sleep(6)\n');
  await agent('action.submit', run('w4-unknown', 'waiting.R', waiting));
  orphan = (await until(() => lookup('w4-unknown'), r => r.native?.status?.Running, 'w4-unknown running')).native.status.Running.pid;
  const host = (await call('observation.snapshot')).host.reply.value.host.pid;
  process.kill(host, 'SIGKILL');
  await page.locator('[data-rho-agent]').click();
  const unknownView = runView('w4-unknown');
  await unknownView.locator('[data-rho-execution="unknown"]').waitFor({ timeout: 30000 });
  assert.match(await unknownView.locator('[data-rho-execution]').textContent(), /^outcome unknown · submitted by the Agent at /);
  assert.equal(await unknownView.getByRole('button', { name: 'Ask the Agent to fix', exact: true }).count(), 1);
  await rulers(page, { name: 'unknown-run', profile: profiles.shell, first: () => unknownView.locator('h2'), transientAllowed: true, enforce: true, evidence, report });
  passed('unknown outcome shown as unknown; M1–M10 hold on the run view', { execution: 'unknown' });

  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = { message: String(error.message).slice(0, 3000), stack: String(error.stack ?? '').split('\n').filter(l => l.includes('.mjs')).slice(0, 4) }; process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  // The process whose Host was killed is nobody's to stop now; the check that orphaned it does.
  if (orphan) { try { process.kill(orphan, 'SIGKILL'); } catch {} }
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ passed: report.passed, failure: report.failure, report: path.join(evidence, 'report.json') }) + '\n');
}
