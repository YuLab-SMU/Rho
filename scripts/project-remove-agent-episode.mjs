// Real native Agent cancellation, with a live terminal, command and Python session. Uses an
// isolated client configuration and disposable project; credentials stay in memory. No user
// service or native session is stopped. Requires the gateway used by acp-episode.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { RhoService, RhoClient } from './support.mjs';
import { BrowserClient } from '../dist/browser.js';
import { westlakeCodexEnv } from './acp-westlake.mjs';

const agent = process.argv[2] ?? 'claude';
assert.ok(['claude', 'codex'].includes(agent), 'choose claude or codex');
const evidence = path.resolve(process.env.RHO_REMOVE_EVIDENCE ?? `work/remove-${agent}-${Date.now()}`);
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-remove-real-');
const model = process.env.MODEL ?? 'westlakehpc/glm-5.3-flash';
const auth = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude/settings.json'), 'utf8')).env ?? {};
const configDir = path.join(root, '.claude'); await fs.mkdir(configDir);
const env = { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ANTHROPIC_MODEL: model };
for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) if (auth[k]) env[k] = auth[k];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function poll(read, accepts, label, ms = 120000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const value = await read(); if (accepts(value)) return value; await new Promise(r => setTimeout(r, 200)); }
  throw new Error('Timed out: ' + label);
}
// Process identities only: command arguments may hold credentials.
function descendants(pid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
  const found = new Set([pid]);
  for (let i = 0; i < rows.length; i++) for (const [child, parent] of rows) if (found.has(parent)) found.add(child);
  return [...found];
}
let service, browser, page;
const report = { passed: false, agent, model, checks: [] };
try {
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: 'Rscript',
    claude: process.env.RHO_CLAUDE ?? path.join(os.homedir(), '.local/bin/claude'),
    ...(process.env.RHO_CODEX ? { codex: process.env.RHO_CODEX } : {}),
    claudeAcp: { env, model, settingSources: [], allowedTools: ['Bash', 'Read'] },
    codexAcp: { env: await westlakeCodexEnv(auth, root, model), model },
    conversations: { stopGraceMs: 5000, turnWallMs: 180000 } }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const person = new BrowserClient({ url: service.url });
  const project = await admin.call('project.create', { name: `Remove real ${agent}` });
  const call = (method, body = {}) => person.call(method, { projectId: project.id, ...body });
  await fs.writeFile(path.join(project.root, 'kept.txt'), 'The folder stays.\n');
  const code = 'import os,time; open("native.pid","w").write(str(os.getpid())); print("native work started",flush=True); time.sleep(120)';
  const text = `This is a cancellation check in a disposable folder. Use your native shell tool to run exactly this command in the project folder and wait for its result: python3 -u -c '${code}'. Do not use a background process or Rho tools. Do not modify any other files. I will stop it while you wait.`;
  const started = await call('conversation.start', { backend: agent === 'codex' ? 'codex-acp' : 'claude-acp', changeId: 'real-remove', text });
  const conversationId = started.conversation.conversationId;
  const read = () => call('conversation.read', { conversationId });
  await poll(async () => {
    const state = await read();
    if (state.turns.at(-1)?.state !== 'running') throw new Error('Agent ended before the check: ' + (state.turns.at(-1)?.problem ?? state.turns.at(-1)?.state));
    return fs.readFile(path.join(project.root, 'native.pid'), 'utf8').catch(() => '');
  }, Boolean, 'the real model starts its native command');
  const nativePid = Number(await fs.readFile(path.join(project.root, 'native.pid'), 'utf8'));
  const before = await poll(read, r => r.turns.at(-1).steps.some(s => s.kind === 'tool'), 'a real tool call is recorded');
  const agentPids = descendants(before.turns.at(-1).pid);
  const terminal = (await call('console.terminal.open', { cols: 80, rows: 24 })).terminal;
  const command = (await call('console.run', { command: 'sleep 120', changeId: 'running-command' })).command;
  const session = (await call('kernel.run', { language: 'python', code: 'kept = 42', changeId: 'live-session', waitMs: 30000 })).session;
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(service.url);
  await page.getByRole('group', { name: 'Projects', exact: true }).getByRole('button', { name: `Remove Remove real ${agent} from Rho`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Remove Remove real ${agent} from Rho?`, exact: true });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /1 Agent answering, 1 live session, 1 terminal, 1 running command/);
  assert.equal((await read()).turns.at(-1).state, 'running');
  assert.ok(alive(nativePid) && alive(session.pid) && alive(command.pid), 'counting stops nothing');
  report.checks.push('real model is waiting on its native tool; removal counts all four kinds without stopping them');
  await page.screenshot({ path: path.join(evidence, 'before-removal.png') });
  await dialog.getByRole('button', { name: 'Stop and remove', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await poll(() => person.call('project.list', {}), list => !list.some(p => p.id === project.id), 'project removed');
  const pids = [...new Set([...agentPids, nativePid, command.pid, session.pid])].filter(Boolean);
  await poll(() => pids.filter(alive), left => left.length === 0, 'native Agent, tool, command and session processes ended', 15000);
  await call('project.restore');
  const after = await read();
  assert.equal(after.turns[0].id, before.turns[0].id, 'the original turn identity survives');
  assert.notEqual(after.turns.at(-1).state, 'running');
  assert.notEqual((await call('console.terminal.list')).terminals.find(t => t.terminalId === terminal.terminalId)?.endedAt ?? 'gone', null);
  assert.equal(await fs.readFile(path.join(project.root, 'kept.txt'), 'utf8'), 'The folder stays.\n');
  report.checks.push('the real Agent and its native tool end, terminal closes, command and session end; restoring retains the original turn and project files');
  report.processesChecked = pids.length; report.ending = after.turns.at(-1).state;
  report.passed = true;
} catch (error) {
  report.failure = error.message;
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close(); await service?.close();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, evidence }));
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
}
