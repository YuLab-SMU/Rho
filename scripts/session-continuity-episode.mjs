// Real Claude Code sessions started outside Rho, continued in Rho's Agent panel and back in a
// terminal, with one held open by a live interactive Claude Code. The project, Rho's state and
// Claude Code's configuration are disposable; model credentials stay in the process environment.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { inspectResponsive } from './browser-checks.mjs';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rho-continuity-episode-')));
const evidence = path.resolve(process.env.RHO_CONTINUITY_EVIDENCE ?? 'work/session-continuity/' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const report = { passed: false, root, checks: [], runs: [], browserErrors: [] };
const check = text => { report.checks.push(text); console.log('ok · ' + text); };
const wait = async (read, accept, label, ms = 180000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read().catch(() => null); if (value && accept(value)) return value; await new Promise(r => setTimeout(r, 500)); }
  throw new Error('Timed out: ' + label);
};

// Claude Code's own configuration for this run. The service runs in this process, so it and the
// Agents it starts read the same folder. This process's own Claude Code markers stay set for the
// service (it must not pass them on); the terminal runs below are started without them.
const configDir = path.join(root, 'claude-config'); await fs.mkdir(configDir);
const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude/settings.json'), 'utf8'));
for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_MODEL_CAPABILITIES'])
  if (settings.env?.[key]) process.env[key] = settings.env[key];
Object.assign(process.env, { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ model: process.env.RHO_CONTINUITY_MODEL ?? 'haiku', permissions: { defaultMode: 'dontAsk' } }));
const terminalEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDECODE|CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|SESSION_ID|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|SSE_PORT)|CLAUDE_PID)$/.test(key)));

const { RhoService } = await import('../dist/server.js');
const { RhoClient } = await import('../dist/client.js');
const { BrowserClient } = await import('../dist/browser.js');
let service, browser; const holders = [];
try {
  service = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: path.join(root, 'absent-core'), rscript: 'Rscript', example: false }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const person = new BrowserClient({ url: service.url });
  const project = await operator.call('project.create', { name: 'continuity study' });
  const call = (method, body = {}) => person.call(method, { projectId: project.id, ...body });
  await fs.writeFile(path.join(configDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [project.root]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));

  // A terminal turn: Claude Code's print mode in the project folder, as a script or a person would run it.
  const terminal = async (name, args) => {
    const started = Date.now();
    const result = await new Promise(resolve => execFile('claude', ['-p', '--output-format', 'json', ...args], { cwd: project.root, env: terminalEnv, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
    await fs.writeFile(path.join(evidence, name + '.json'), result.stdout, { mode: 0o600 });
    const value = JSON.parse(result.stdout || '{}');
    report.runs.push({ name, code: result.code, elapsedMs: Date.now() - started, sessionId: value.session_id, result: value.result, error: value.is_error });
    assert.ok(value.session_id && !value.is_error, name + ': ' + result.stderr);
    return value;
  };
  // An interactive Claude Code holding a session open, in a pseudo-terminal.
  const hold = async sessionId => {
    const child = spawn('python3', ['-I', '-c', 'import pty, sys; pty.spawn(sys.argv[1:])', 'claude', '--resume', sessionId], { cwd: project.root, env: { ...terminalEnv, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdout.resume(); child.stderr.resume(); holders.push(child);
    await wait(async () => readdirSync(path.join(configDir, 'sessions')).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(path.join(configDir, 'sessions', n), 'utf8'))), list => list.some(v => v.sessionId === sessionId), 'the interactive Claude Code to register', 60000);
    return () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
  };
  const listed = async sessionId => (await call('agent.sessions.list')).sessions.find(s => s.sessionId === sessionId);

  // 1. A session started outside Rho is listed with its own identity, and nothing is started.
  const first = await terminal('terminal-1', ['--', 'Remember this code word for later: heron-42. Reply with just OK.']);
  const row = await wait(() => listed(first.session_id), Boolean, 'the outside session to be listed', 20000);
  assert.equal(row.producer, 'claude-code'); assert.equal(row.continueWith, 'claude-acp'); assert.equal(row.open, null); assert.ok(!row.conversationId);
  assert.equal((await call('observation.snapshot')).conversations?.length ?? 0, 0);
  check(`the outside session ${first.session_id} is listed as started in ${row.where}, continuable with Claude Code, with no Rho conversation`);

  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => report.browserErrors.push(e.message));
  await page.goto(service.url + '/#project=' + project.id);
  await page.locator('.project-nav').getByRole('button', { name: 'Agent', exact: true }).click();
  const list = page.locator('section.conversations');
  await list.locator('.native-row').filter({ hasText: row.title }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(evidence, 'list-outside.png') });
  await list.locator('.native-row').filter({ hasText: row.title }).getByRole('button', { name: 'Continue', exact: true }).click();
  const panel = page.locator('section.conversation');
  await panel.locator('.turn.outside').filter({ hasText: 'heron-42' }).waitFor();
  await panel.getByText('Your message continues this same Claude Code session.', { exact: false }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(evidence, 'panel-outside.png') });
  check('Continue opens the outside session in the Agent panel with its earlier message and where it started');

  // 2. The next message in Rho continues that same session: the Agent knows the earlier turn.
  await panel.locator('#conversation-input').fill('What code word did I give you earlier? Reply with just the word.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const continued = await wait(async () => (await call('conversation.list')).conversations.find(c => c.sessionId === first.session_id), c => c.state === 'completed' || c.state === 'failed', 'the continued message to finish');
  const read1 = await call('conversation.read', { conversationId: continued.conversationId });
  const answer1 = read1.turns.at(-1).steps.filter(s => s.kind === 'text').map(s => s.text).join('');
  report.runs.push({ name: 'rho-1', state: read1.turns.at(-1).state, answer: answer1, problem: read1.turns.at(-1).problem });
  assert.equal(continued.state, 'completed', read1.turns.at(-1).problem);
  assert.match(answer1, /heron-42/i);
  assert.equal(continued.origin?.producer, 'claude-code'); assert.ok(!continued.origin?.copyOf);
  assert.equal((await listed(first.session_id)).conversationId, continued.conversationId);
  await panel.locator('.turn').filter({ hasText: 'heron-42' }).last().waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(evidence, 'panel-continued.png') });
  check(`Rho continued the same session ${first.session_id}: the answer "${answer1.trim()}" came from the terminal turn's context, and the list now shows one conversation for it`);

  // 3. Back in a terminal, the same session has Rho's turn.
  const back = await terminal('terminal-2', ['--resume', first.session_id, '--', 'In one short sentence: what did I ask you in my previous message?']);
  assert.equal(back.session_id, first.session_id);
  assert.match(back.result, /code word|heron/i);
  await panel.locator('.turn.outside').filter({ hasText: 'what did I ask you in my previous message' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(evidence, 'panel-back.png') });
  check(`resumed in a terminal, the session answered "${back.result.trim()}", and Rho's panel shows that turn in place`);

  // 4. While an interactive Claude Code holds the session, Rho does not write into it.
  let release = await hold(first.session_id);
  await wait(() => listed(first.session_id), s => s.open?.where === 'Terminal', 'Rho to see the session open in Terminal', 20000);
  const refused = await call('conversation.send', { conversationId: continued.conversationId, changeId: 'm-held-' + Date.now(), text: 'Are you there?' }).then(() => null, error => error);
  assert.ok(refused, 'a held session accepted a message');
  assert.match(refused.message, /open in Terminal/);
  await panel.locator('#conversation-input').fill('Are you there?');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await panel.getByText('This session is open in Terminal.', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'panel-held-refused.png') });
  release();
  await wait(() => listed(first.session_id), s => !s.open, 'the interactive Claude Code to let go', 20000);
  check('with an interactive Claude Code holding the session, sending was refused with where it is open, and nothing was sent');
  // Once it is closed there, Rho's next message continues after the terminal's turn, not after its own.
  await panel.locator('#conversation-input').fill('Quote my message just before this one, word for word, and nothing else.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const again = await wait(async () => (await call('conversation.read', { conversationId: continued.conversationId })).turns.at(-1), t => t.text.startsWith('Quote my message') && t.state !== 'running', 'Rho\'s message after the terminal turn');
  const answer3 = again.steps.filter(s => s.kind === 'text').map(s => s.text).join('');
  report.runs.push({ name: 'rho-2', state: again.state, answer: answer3, problem: again.problem });
  assert.equal(again.state, 'completed', again.problem);
  assert.match(answer3, /what did I ask you in my previous message/i);
  const transcript = (await fs.readFile(path.join(configDir, 'projects', (await fs.readdir(path.join(configDir, 'projects')))[0], first.session_id + '.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.type === 'user' || r.type === 'assistant');
  const prompt = (text, from) => transcript.find(r => r.type === 'user' && JSON.stringify(r.message?.content).includes(text));
  const asked = prompt('Quote my message just before this one'), terminalAnswer = transcript.find(r => r.type === 'assistant' && r.message?.stop_reason === 'end_turn' && Date.parse(r.timestamp) > Date.parse(prompt('what did I ask you in my previous message').timestamp));
  assert.equal(asked.parentUuid, terminalAnswer.uuid, 'Rho\'s message did not follow the terminal turn');
  report.chain = { rhoPrompt: asked.uuid, parent: asked.parentUuid, terminalAnswer: terminalAnswer.uuid };
  check(`after the terminal turn, Rho's next message follows the terminal's answer in the session's own record and quoted it: "${answer3.trim()}"`);

  // 5. A second outside session, held open, continues as a copy; the original is not written.
  const second = await terminal('terminal-3', ['--', 'Remember this other code word: osprey-7. Reply with just OK.']);
  release = await hold(second.session_id);
  const held = await wait(() => listed(second.session_id), s => s.open?.where === 'Terminal', 'the second session to be seen open', 30000);
  await page.locator('.project-nav').getByRole('button', { name: 'Agent', exact: true }).click();
  const heldRow = list.locator('.native-row').filter({ hasText: held.title });
  await heldRow.getByText('Open in Terminal', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'list-held.png') });
  await heldRow.getByRole('button', { name: 'Continue', exact: true }).click();
  await panel.getByText('Open in Terminal now.', { exact: false }).waitFor();
  assert.equal(await panel.locator('#conversation-input').isDisabled(), true);
  await page.screenshot({ path: path.join(evidence, 'panel-held.png') });
  const original = await fs.readFile(path.join(configDir, 'projects', (await fs.readdir(path.join(configDir, 'projects')))[0], second.session_id + '.jsonl'), 'utf8');
  await panel.getByRole('button', { name: 'continue a copy', exact: true }).click();
  await panel.locator('#conversation-input').fill('Which code word did I ask you to remember? Reply with just the word.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const copied = await wait(async () => (await call('conversation.list')).conversations.find(c => c.origin?.copyOf === second.session_id), c => c.state === 'completed' || c.state === 'failed', 'the copy to answer');
  const read2 = await call('conversation.read', { conversationId: copied.conversationId });
  const answer2 = read2.turns.at(-1).steps.filter(s => s.kind === 'text').map(s => s.text).join('');
  report.runs.push({ name: 'rho-copy', state: read2.turns.at(-1).state, answer: answer2, sessionId: copied.sessionId, problem: read2.turns.at(-1).problem });
  assert.equal(copied.state, 'completed', read2.turns.at(-1).problem);
  assert.match(answer2, /osprey-7/i);
  assert.ok(copied.sessionId && copied.sessionId !== second.session_id);
  const after = await fs.readFile(path.join(configDir, 'projects', (await fs.readdir(path.join(configDir, 'projects')))[0], second.session_id + '.jsonl'), 'utf8');
  assert.ok(!after.includes('Which code word did I ask you to remember'), 'the original session received the copy\'s message');
  assert.ok(after.startsWith(original.slice(0, 1024)));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(evidence, 'panel-copy.png') });
  release();
  check(`held open in Terminal, the second session continued as a copy ${copied.sessionId} that answered "${answer2.trim()}"; the original transcript does not hold the copy's message`);

  // 6. The list and the Agents tab, at every width, with the Agent panel closed.
  await page.getByRole('button', { name: 'Close Agent' }).first().click();
  await page.locator('.project-nav').getByRole('button', { name: 'Agent', exact: true }).click();
  await list.waitFor();
  await inspectResponsive(page, { name: 'conversations', evidence, report, settle: () => page.waitForTimeout(300) });
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Agent for new conversations' }).waitFor();
  assert.equal(await page.getByRole('radio', { name: 'Use Claude Code for new conversations' }).getAttribute('aria-checked'), 'true');
  await inspectResponsive(page, { name: 'agents', evidence, report, settle: () => page.waitForTimeout(300) });
  check('the conversation list and the Agents tab have no horizontal overflow or unnamed buttons at 1440, 1024, 768 and 390 px');
  assert.deepEqual(report.browserErrors, []);
  report.passed = true;
} finally {
  for (const child of holders) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await browser?.close(); await service?.close();
  console.log('Evidence: ' + evidence);
}
