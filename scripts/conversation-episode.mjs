// Stage-1 driver for the conversation episode (docs/CONVERSATION-EPISODE.md). It is not an
// acceptance suite: it stops only when a step cannot be performed, and the episode record's
// review judges what the screenshots and records show. Real service process, real Chrome,
// the person's configured Claude Code CLI and a disposable project; four real model messages.
// Usage: node scripts/conversation-episode.mjs [run-name]  (evidence: work/conversation-episode/)
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { RhoClient } from '../dist/client.js';

const run = process.argv[2] ?? new Date().toISOString().replace(/[:.]/g, '-');
const evidence = path.resolve('work/conversation-episode', run); await fs.mkdir(evidence, { recursive: true });
const log = async (step, data = {}) => { const line = JSON.stringify({ at: new Date().toISOString(), step, ...data }); console.log(line); await fs.appendFile(path.join(evidence, 'log.jsonl'), line + '\n'); };
const root = await fs.realpath(await fs.mkdtemp('/tmp/rho-conv-'));
const projectDir = path.join(root, 'air-quality');
await fs.mkdir(projectDir);
await fs.writeFile(path.join(projectDir, 'data.csv'), 'Ozone,Solar.R,Wind,Temp,Month,Day\n41,190,7.4,67,5,1\n36,118,8,72,5,2\n12,149,12.6,74,5,3\n18,313,11.5,62,5,4\nNA,NA,14.3,56,5,5\n28,NA,14.9,66,5,6\n23,299,8.6,65,5,7\n19,99,13.8,59,5,8\n8,19,20.1,61,5,9\nNA,194,8.6,69,5,10\n7,NA,6.9,74,5,11\n16,256,9.7,69,5,12\n');
await fs.writeFile(path.join(projectDir, 'notes.md'), '# Notes\n\nFirst look at the May air-quality readings.\n');
const state = path.join(root, '.service');
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const core = path.resolve('../Rho-core/target/debug/rho-core'), rscript = '/usr/local/bin/Rscript';
let service;
async function startService(label) {
  const child = spawn(process.execPath, ['dist/cli.js', '--root', root, '--state-dir', state, '--core', core, '--rscript', rscript, '--agent-backend', 'claude-cli', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', d => err.push(d));
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => { lines.once('line', line => resolve(JSON.parse(line).ready)); child.once('exit', code => reject(new Error('service exited ' + code + ' ' + Buffer.concat(err)))); });
  service = { child, ready }; await log('service.started', { label, url: ready.url });
  return ready;
}
async function stopService(label) {
  const exited = new Promise(resolve => service.child.once('exit', (code, signal) => resolve({ code, signal })));
  const started = Date.now(); service.child.kill('SIGTERM'); const how = await exited;
  await log('service.stopped', { label, ...how, ms: Date.now() - started });
}
const ready = await startService('first');
const operator = await RhoClient.fromFile(ready.connectionFile);
const project = await operator.call('project.open', { path: 'air-quality' });
await log('project', { id: project.id, root: projectDir });

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
let shot = 0; const snap = async name => { const file = path.join(evidence, String(++shot).padStart(2, '0') + '-' + name + '.png'); await page.screenshot({ path: file }); await log('screenshot', { file: path.basename(file) }); };
const panel = () => page.getByRole(page.viewportSize().width < 768 ? 'dialog' : 'complementary', { name: 'Agent panel', exact: true });
async function openProject() {
  await page.goto(ready.url);
  await page.locator('.project-row').filter({ hasText: 'air-quality' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).waitFor();
}
async function openPanel() { if (!(await panel().count())) await page.getByRole('button', { name: 'Agent', exact: true }).click(); await panel().waitFor(); await panel().locator('#conversation-input').waitFor(); }
// Waits for the newest message to end and returns what the screen says about it.
async function waitTurn(label, maxMs = 600000) {
  const started = Date.now(); let sawWorking = false, sawSteps = false;
  for (;;) {
    const ending = panel().locator('.conversation-turns > .turn').last().locator('.turn-ending');
    const present = await ending.count();
    const cls = present ? await ending.getAttribute('class', { timeout: 2000 }).catch(() => '') : '';
    const text = present ? await ending.innerText({ timeout: 2000 }).catch(() => '') : '';
    if (cls?.includes('running')) {
      if (!sawWorking) { sawWorking = true; await snap(label + '-working'); }
      if (!sawSteps && await panel().locator('.conversation-turns > .turn').last().locator('.activity-row, .activity-group').count()) { sawSteps = true; await snap(label + '-steps'); }
    } else if (cls) { await log('turn.ended', { label, state: cls.replace('turn-ending ', ''), text, ms: Date.now() - started }); await snap(label + '-ended'); return { state: cls.replace('turn-ending ', ''), text }; }
    if (Date.now() - started > maxMs) { await snap(label + '-timeout'); throw new Error('turn did not end: ' + label); }
    await page.waitForTimeout(1000);
  }
}
async function say(text) {
  const before = await panel().locator('.conversation-turns > .turn').count();
  const box = panel().locator('#conversation-input'); await box.fill(text);
  const button = panel().getByRole('button', { name: /^(Start|Send)$/ });
  await button.click();
  try { await page.waitForFunction(n => document.querySelectorAll('.conversation-turns > .turn').length > n, before, { timeout: 30000 }); }
  catch (e) { await snap('say-no-turn'); const alert = await panel().locator('[role=alert]').allInnerTexts(); throw new Error('message did not appear: ' + JSON.stringify(alert)); }
}
const record = async () => { const dir = path.join(projectDir, '.rho/rho/conversations'); const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')); const c = JSON.parse(await fs.readFile(path.join(dir, index.conversations[0].conversationId + '.json'), 'utf8')); return c; };

try {
  await openProject(); await openPanel(); await snap('panel-empty');
  await say('What is in this project? Give me a short overview of each file.');
  const first = await waitTurn('t1');
  let c = await record(); await log('record', { id: c.id, native: c.nativeSessionId, confirmed: c.confirmed, turns: c.turns.map(t => ({ id: t.id, state: t.state, steps: t.steps.length, tools: t.steps.filter(s => s.kind === 'tool').map(s => (s.operation ?? s.tool) + ':' + s.outcome), result: t.result })) });
  await say('Which column in data.csv has the most missing values, and how many are missing?');
  await waitTurn('t2');
  // Reload: the open conversation and its messages come back from the record.
  await page.reload(); await page.getByRole('button', { name: 'Agent', exact: true }).waitFor(); await openPanel();
  await panel().locator('.conversation-turns > .turn').nth(1).waitFor(); await snap('after-reload');
  // Restart the service on the same state and port, then continue the same conversation.
  await stopService('restart'); await startService('second');
  await page.reload(); await page.getByRole('button', { name: 'Agent', exact: true }).waitFor(); await openPanel();
  await panel().locator('.conversation-turns > .turn').nth(1).waitFor(); await snap('after-restart');
  await say('Add one line at the end of notes.md that records your answer about missing values, then save it.');
  await waitTurn('t3');
  await log('notes.md', { text: await fs.readFile(path.join(projectDir, 'notes.md'), 'utf8') });
  // Stop: ask for longer work, stop it once a step is shown.
  await say('Read data.csv and notes.md again, then describe every column of data.csv in detail, one paragraph each.');
  await panel().locator('.conversation-turns > .turn').last().locator('.activity-row, .activity-group').first().waitFor({ timeout: 300000 }).catch(() => {});
  await panel().getByRole('button', { name: 'Stop', exact: true }).click().catch(e => log('stop.click.failed', { message: e.message }));
  await waitTurn('t4-stop');
  c = await record(); await log('record', { id: c.id, native: c.nativeSessionId, turns: c.turns.map(t => ({ id: t.id, state: t.state, stop: t.stop, exit: t.exit, steps: t.steps.length, tools: t.steps.filter(s => s.kind === 'tool').map(s => (s.operation ?? s.tool) + ':' + s.outcome), result: t.result && { isError: t.result.isError, kind: t.result.kind, durationMs: t.result.durationMs, costUsd: t.result.costUsd } })) });
  // A session started outside Rho: granted the way `rho --grant` does, then one call.
  const operator2 = await RhoClient.fromFile(service.ready.connectionFile);
  const grant = await operator2.call('session.grant', { projectId: project.id, externalSessionId: 'claude-code' });
  const outside = await RhoClient.fromFile(grant.connectionFile);
  await outside.call('project.entries', { projectId: project.id }).then(r => log('outside.entries', { names: r.entries.map(e => e.name) }), e => log('outside.entries', { error: e.message }));
  await panel().getByRole('button', { name: 'All conversations', exact: true }).click();
  await page.waitForTimeout(1500); await snap('list-and-outside-session');
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.getByRole('button', { name: 'Agent', exact: true }).waitFor(); await openPanel();
  await snap('phone-list');
  await panel().locator('.conversation-list button').first().click(); await page.waitForTimeout(1000); await snap('phone-conversation');
  await log('browser.errors', { errors });
} catch (e) { await log('failed', { message: e.message, stack: e.stack?.split('\n').slice(0, 4) }); await snap('failure').catch(() => {}); process.exitCode = 1; }
finally {
  await browser.close(); await stopService('end');
  await log('done', { root, projectDir });
}
