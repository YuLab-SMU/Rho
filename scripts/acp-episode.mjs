// Real Claude ACP + Westlake HPC + Rho + Chrome. Uses disposable files and only
// owned processes. Credentials stay in memory; reports retain only Rho's bounded
// visible conversation record, never the native transcript or diagnostics.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { BrowserClient } from '../dist/browser.js';

const evidence = path.resolve(process.env.RHO_ACP_EVIDENCE ?? 'work/acp-episode/' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-acp-episode-'), configDir = path.join(root, '.claude'); await fs.mkdir(configDir);
const auth = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude/settings.json'), 'utf8')).env ?? {};
assert.ok(auth.ANTHROPIC_BASE_URL && (auth.ANTHROPIC_AUTH_TOKEN || auth.ANTHROPIC_API_KEY), 'Existing gateway credentials are required');
const model = 'westlakehpc/deepseek-v4.1-flash';
const env = { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', ANTHROPIC_MODEL: model };
for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) if (auth[k]) env[k] = auth[k];
const claude = process.env.RHO_CLAUDE ?? path.join(os.homedir(), '.local/bin/claude');
const options = { root, stateDir: path.join(root, '.service'), coreBinary: path.resolve('../Rho-core/target/debug/rho-core'), rscript: 'Rscript', claude,
  claudeAcp: { env, model, settingSources: [], allowedTools: ['Read'] }, conversations: { maxAgentTurns: 16, turnWallMs: 180000, stopGraceMs: 15000 } };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { passed: false, root, provider: 'Westlake HPC', model, startedAt: new Date().toISOString(), checks: [], screenshots: [], browserErrors: [],
  claudeVersion: spawnSync(claude, ['--version'], { encoding: 'utf8' }).stdout.trim(), node: process.version,
  sources: Object.fromEntries(['.', '../Rho-plugins', '../Rho-core'].map(dir => [dir, { commit: spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), dirty: !!spawnSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim() }])),
  web: JSON.parse(await fs.readFile('dist/web/composition.json', 'utf8')), scriptSha256: sha(await fs.readFile(new URL(import.meta.url))) };
let service, browser, context, page, project, person, conversationId, shot = 0;
const nativePids = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (step, details = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), step, ...details }));
async function until(read, valid, label, timeout = 180000) {
  const end = Date.now() + timeout;
  for (;;) { const value = await read(); if (valid(value)) return value; if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(250); }
}
async function start() { service = await new RhoService(options).start(); options.port = Number(new URL(service.url).port); person = new BrowserClient({ url: service.url }); }
const call = (method, body = {}) => person.call(method, { projectId: project.id, ...body });
const record = async () => JSON.parse(await fs.readFile(path.join(project.root, '.rho/rho/conversations', conversationId + '.json'), 'utf8'));
const read = () => call('conversation.read', { conversationId });
const panel = () => page.getByRole(page.viewportSize().width < 768 ? 'dialog' : 'complementary', { name: 'Agent panel', exact: true });
async function snap(name) { const file = `${String(++shot).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: path.join(evidence, file), fullPage: true }); report.screenshots.push(file); }
async function openPanel() { if (!await panel().count()) await page.getByRole('button', { name: 'Agent', exact: true }).click(); await panel().locator('#conversation-input').waitFor(); }
async function say(text) { await panel().locator('#conversation-input').fill(text); await panel().getByRole('button', { name: /^(Start|Send)$/ }).click(); }
async function approve() {
  const pending = await page.getByRole('group', { name: 'Agent permission' }).count();
  if (!pending) return;
  const group = page.getByRole('group', { name: 'Agent permission' }).last();
  await snap('native-permission');
  const state = await read(), request = state.turns.at(-1).permissions.find(p => p.state === 'pending');
  assert.ok(request, 'permission is retained before it is shown');
  const option = request.options.find(o => o.kind === 'allow_once'); assert.ok(option, 'native Agent offers a one-time choice');
  await group.getByRole('button', { name: option.name, exact: true }).click();
}
async function ended(count, label) {
  const value = await until(async () => { await approve(); return read(); }, r => r.turns.length === count && r.turns.at(-1).state !== 'running', label);
  await until(() => panel().locator('.turn-ending').last().getAttribute('class'), s => !s.includes('running'), 'screen ending');
  await panel().getByRole('button', { name: 'Send', exact: true }).waitFor();
  log(label, { state: value.turns.at(-1).state }); await snap(label); return value.turns.at(-1);
}
async function gateStarted(label, turnCount) {
  await until(async () => { await approve(); const r = await read(); if (r.turns.length === turnCount && r.turns.at(-1).state !== 'running') throw new Error('Gate ended before starting: ' + label); return fs.readFile(path.join(project.root, label + '.pid'), 'utf8').catch(() => null); }, Boolean, 'native gate ' + label);
  const pid = Number(await fs.readFile(path.join(project.root, label + '.pid'), 'utf8')); nativePids.add(pid); return pid;
}
const gatePrompt = label => `Run python3 gate.py ${label} exactly once with Bash in the foreground, using a timeout of at least 120000 milliseconds. The test harness will release it or stop it; do not background, retry, or change gate.py. Work only in this disposable project. After it ends, report the output briefly.`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  await start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  project = await admin.call('project.create', { name: 'Claude ACP episode' }); report.project = project.id;
  await fs.writeFile(path.join(project.root, 'input.txt'), 'alpha=7\nbeta=11\n');
  await fs.writeFile(path.join(project.root, 'notes.txt'), 'ACP episode\n');
  await fs.writeFile(path.join(project.root, 'gate.py'), `import os,pathlib,sys,time
name=sys.argv[1]
p=pathlib.Path('.')
with (p/(name+'.count')).open('a') as f:f.write('run\\n')
(p/(name+'.pid')).write_text(str(os.getpid()))
deadline=time.monotonic()+120
while not (p/(name+'.release')).exists():
 if time.monotonic()>deadline:raise SystemExit(9)
 time.sleep(.05)
(p/(name+'.done')).write_text('completed once\\n')
print(name+' completed once')
`);
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version(); context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', e => report.browserErrors.push(e.message));
  await page.goto(service.url); await page.locator('.project-row').filter({ hasText: 'Claude ACP episode' }).click(); await openPanel();
  // Deliver the first message but lose its HTTP acknowledgement. Retry must reuse it.
  let lostAck;
  await page.route('**/api/v2/conversation.start', async route => { const response = await route.fetch(); lostAck = await response.json(); await route.abort('failed'); }, { times: 1 });
  await say('Call rho_index once to inspect shared Rho capabilities, then use Read to read input.txt. Tell me alpha plus beta. Remember the phrase violet river 你好 for the next message. Do not change files. Answer briefly.');
  await panel().getByRole('button', { name: 'Retry', exact: true }).waitFor(); await snap('lost-ack');
  conversationId = lostAck.value.conversation.conversationId;
  await panel().getByRole('button', { name: 'Retry', exact: true }).click();
  const first = await ended(1, 'first-answer'); assert.equal(first.state, 'completed');
  assert.match(first.steps.filter(s => s.kind === 'text').map(s => s.text).join(''), /18/);
  assert.ok(first.steps.some(s => s.tool === 'mcp__rho__rho_index' && s.outcome === 'returned'));
  const original = await record(); report.acpSessionId = original.acpSessionId; report.adapter = original.adapter;
  assert.equal(original.nativeSessionId, null); report.checks.push('lost acknowledgement retained one original message; real native Read and Rho MCP completed');
  await say('Call rho_index again once, then write the remembered phrase and sum to notes.txt using Write. Include the original Chinese characters. Do not read input.txt again.');
  const second = await ended(2, 'second-answer'); assert.equal(second.state, 'completed');
  assert.equal(first.pid, second.pid, 'two turns reuse the same ACP process');
  assert.ok(second.steps.some(s => s.tool === 'mcp__rho__rho_index' && s.outcome === 'returned'));
  assert.match(await fs.readFile(path.join(project.root, 'notes.txt'), 'utf8'), /violet river.*你好/s);
  report.checks.push('two real turns reused the ACP connection, MCP credential and context; native write persisted Unicode');
  await say(gatePrompt('browser-loss')); await gateStarted('browser-loss', 3); await snap('before-browser-loss');
  await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await snap('browser-offline');
  await fs.writeFile(path.join(project.root, 'browser-loss.release'), 'release');
  await until(read, r => r.turns.length === 3 && r.turns.at(-1).state === 'completed', 'work completed while browser disconnected');
  await context.setOffline(false); await page.reload(); await openPanel(); await panel().locator('.turn').nth(2).waitFor(); await snap('browser-reconnected');
  assert.equal(await fs.readFile(path.join(project.root, 'browser-loss.count'), 'utf8'), 'run\n');
  report.checks.push('browser disconnection/reload observed the original completed turn; one native dispatch');
  await say(gatePrompt('cancel')); const cancelPid = await gateStarted('cancel', 4); await snap('before-cancel');
  await panel().getByRole('button', { name: 'Stop', exact: true }).click();
  const cancelled = await ended(4, 'cancelled'); assert.equal(cancelled.state, 'stopped'); assert.equal(cancelled.result.reason, 'cancelled');
  await until(() => alive(cancelPid), x => !x, 'native foreground command stopped', 15000);
  assert.equal(await fs.readFile(path.join(project.root, 'cancel.count'), 'utf8'), 'run\n');
  await assert.rejects(fs.stat(path.join(project.root, 'cancel.done')), { code: 'ENOENT' });
  report.checks.push('ACP cancellation confirmed by the original prompt; the observed native foreground command exited');
  await say(gatePrompt('transport-loss')); await gateStarted('transport-loss', 5); await snap('before-transport-loss');
  const current = await record(), interrupted = current.turns.at(-1); process.kill(-interrupted.pid, 'SIGKILL');
  const unknown = await ended(5, 'transport-outcome-unknown'); assert.equal(unknown.state, 'unknown'); assert.ok(unknown.steps.length);
  await call('conversation.send', { conversationId, changeId: interrupted.changeId, text: interrupted.text });
  assert.equal((await read()).turns.length, 5); assert.equal(await fs.readFile(path.join(project.root, 'transport-loss.count'), 'utf8'), 'run\n');
  await say('The connection was interrupted. Do not run or retry any command. Tell me the phrase you remember, including its Chinese characters, and the sum from our first message.');
  const recovered = await ended(6, 'same-session-recovered'); assert.equal(recovered.state, 'completed');
  const answer = recovered.steps.filter(s => s.kind === 'text').map(s => s.text).join(''); assert.match(answer, /violet river/); assert.match(answer, /你好/); assert.match(answer, /18/);
  assert.equal((await record()).acpSessionId, original.acpSessionId);
  assert.equal(await fs.readFile(path.join(project.root, 'transport-loss.count'), 'utf8'), 'run\n');
  report.checks.push('ACP transport loss kept partial output and unknown outcome; duplicate send did not replay; an explicit new message loaded the same session');
  await service.close(); await start(); await page.reload(); await openPanel();
  assert.equal((await read()).turns.length, 6);
  await say('After restarting Rho, state only the remembered phrase and sum. Do not use tools.');
  const restarted = await ended(7, 'after-service-restart'); assert.equal(restarted.state, 'completed');
  assert.match(restarted.steps.filter(s => s.kind === 'text').map(s => s.text).join(''), /violet river/);
  assert.equal((await record()).acpSessionId, original.acpSessionId);
  report.checks.push('service restart read existing messages without execution, then loaded the original session for a deliberate next message');
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await openPanel();
  await panel().locator('.turn').nth(6).waitFor(); await snap('phone-recovered');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(report.browserErrors, []);
  await assert.rejects(fs.stat(path.join(project.root, '.rho/host.sock')), { code: 'ENOENT' });
  report.checks.push('1440 and 390 CSS-pixel browser states captured; no page exceptions; no Core Host was started');
  report.conversation = await record(); report.passed = true;
} catch (error) {
  report.failure = String(error.message).replaceAll(auth.ANTHROPIC_BASE_URL, '[gateway]');
  if (page) await snap('failure').catch(() => {}); process.exitCode = 1;
} finally {
  if (conversationId) report.conversation = await record().catch(() => null);
  await context?.setOffline(false).catch(() => {}); await browser?.close(); await service?.close();
  // Only fixture commands whose actual PIDs were read in this episode are cleaned up.
  for (const pid of nativePids) if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  log('finished', { passed: report.passed, checks: report.checks.length, evidence, failure: report.failure });
}
