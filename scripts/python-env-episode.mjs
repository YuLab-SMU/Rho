// A real Agent asked for work that needs a Python package this machine's Python lacks. The
// Agent is the person's own Claude Code with Rho's tools and a short list of its own shell
// commands; it finds, installs and uses an environment however it chooses. Nothing here helps it.
//   node scripts/python-env-episode.mjs BASE_DIRECTORY [--from-rho]
// BASE_DIRECTORY holds bin/uv and pythons/<one Python>/bin/python3: a Python that refuses pip and
// lacks the package. That bin folder itself goes on PATH; a venv made through a link to a
// standalone Python elsewhere cannot find its standard library (run 2 of the first episode).
// The service and the Agent get that bin and the system's own, and a HOME of their own, so
// whatever is installed lands under BASE_DIRECTORY or the project and nowhere else.
// Without --from-rho the person runs Claude Code outside Rho, with Rho's MCP tools. With it they
// write the same message in Rho's Agent panel, in a real browser, and Rho starts Claude Code.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RhoClient } from '../dist/client.js';

const base = path.resolve(process.argv[2] ?? '');
const fromRho = process.argv.includes('--from-rho');
const pythons = (await fs.readdir(path.join(base, 'pythons')).catch(() => [])).filter(name => !name.startsWith('.'));
assert.equal(pythons.length, 1, 'Select the base directory whose pythons folder holds one Python.');
const pythonBin = path.join(base, 'pythons', pythons[0], 'bin');
assert.ok(await fs.access(path.join(pythonBin, 'python3')).then(() => true, () => false), 'That Python has no bin/python3.');
const run = path.join(base, 'run-' + new Date().toISOString().replace(/[:.]/g, '-'));
const projects = path.join(run, 'projects'), state = path.join(run, 'state'), home = path.join(run, 'home'), evidence = path.join(run, 'evidence');
for (const directory of [projects, state, home, evidence]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });

// The project: one table and a README, as a person would bring it.
const project = path.join(projects, 'plant growth');
await fs.mkdir(path.join(project, 'data'), { recursive: true });
let seed = 7; const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const rows = ['plant,light,water,growth'];
for (let i = 1; i <= 40; i++) {
  const light = Math.round((2 + next() * 10) * 10) / 10, water = Math.round((50 + next() * 150)) ;
  rows.push(`P${String(i).padStart(2, '0')},${light},${water},${Math.round((1.5 + 0.8 * light + 0.02 * water + (next() - 0.5) * 2) * 100) / 100}`);
}
await fs.writeFile(path.join(project, 'data/growth.csv'), rows.join('\n') + '\n');
await fs.writeFile(path.join(project, 'README.md'), '# Plant growth\n\n`data/growth.csv`: one plant per row, its daily light (hours), water (ml per day) and growth (cm in four weeks).\n');

const prompt = 'In this Rho project, data/growth.csv has plant growth measurements. Fit an ordinary least squares model of growth on light and water with statsmodels in Rho\'s live Python session, so I can see it there, and tell me the coefficients.';
// When the Agent stops to ask, the person answers the way the work was meant: set up what the
// project needs, in the project, and use it in Rho's session.
const reply = 'Set up what the project needs for this inside the project, without changing any Python outside it, and fit the model in Rho\'s live session.';
const tools = ['mcp__rho__rho_index', 'mcp__rho__rho_resolve', 'mcp__rho__rho_call', 'mcp__rho__rho_read', 'Read', 'Glob', 'Grep',
  ...['uv', 'python3', 'python', 'pip', 'pip3', '.venv/bin/python', '.venv/bin/python3', '.venv/bin/pip', 'ls', 'cat', 'head', 'wc', 'echo', 'pwd', 'cd', 'mkdir', 'which', 'source'].map(c => `Bash(${c}:*)`)];

const PATH = [pythonBin, path.join(base, 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const settingsFile = path.join(homedir(), '.claude/settings.json');
const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8').catch(() => '{}'));
const env = { PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8', UV_CACHE_DIR: path.join(homedir(), '.cache/uv'), UV_PYTHON_INSTALL_DIR: path.join(base, 'pythons') };
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const claude = path.join(homedir(), '.local/bin/claude');
const serviceEnv = { ...env };
if (fromRho) {
  // The Claude Code Rho starts reads this HOME's settings: the same commands as the outside run,
  // and anything else refused rather than asked, so no step waits on a permission.
  await fs.mkdir(path.join(home, '.claude'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: tools } }), { mode: 0o600 });
  // It starts as the person's client with their provider settings, read from their own file
  // each time it starts; they never land in this run or in Rho's environment.
  const wrapper = path.join(run, 'claude');
  await fs.writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process'), fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(settingsFile)}, 'utf8'));
const child = spawn(${JSON.stringify(claude)}, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, ...s.env, ...(s.model ? { ANTHROPIC_MODEL: s.model } : {}) } });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
`, { mode: 0o700 });
  serviceEnv.RHO_CLAUDE = wrapper;
}

const service = spawn(process.execPath, [cli, '--root', projects, '--state-dir', state, '--example', 'off', '--port', '0'], { env: serviceEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let printed = ''; service.stdout.on('data', chunk => { printed += chunk; });
const serviceErr = []; service.stderr.on('data', chunk => serviceErr.push(chunk));
const report = { run, from: fromRho ? 'rho' : 'outside', prompt, base: { python: path.join(pythonBin, 'python3') }, agent: null, calls: [], kernel: null };
const kernelState = async () => JSON.parse(await fs.readFile(path.join(project, '.rho/plugins/kernel/state.json'), 'utf8').catch(() => 'null'));
// The model was fitted when a cell that fits it finished in a session.
const fitted = async () => ((await kernelState())?.cells ?? []).some(cell => cell.state === 'done' && /\.fit\(/.test(cell.code) && !cell.problem);
try {
  for (let i = 0; i < 200 && !printed.includes('\n'); i++) await new Promise(r => setTimeout(r, 100));
  const ready = JSON.parse(printed.split('\n')[0]).ready;
  const operator = await RhoClient.fromFile(ready.connectionFile);
  const opened = await operator.call('project.open', { path: 'plant growth' });

  if (fromRho) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(ready.url, { waitUntil: 'networkidle' });
      await page.getByText('plant growth').first().click();
      const box = page.locator('#conversation-input');
      await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
      await box.waitFor({ timeout: 30000 });
      // One message as the person writes it, then wait until the Agent has answered. A permission
      // the Agent asks for is recorded and left for the person; this run decides none.
      const message = async (text, name, button) => {
        const started = Date.now();
        await box.fill(text);
        await page.getByRole('button', { name: button, exact: true }).click();
        await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 60000 }).catch(() => {});
        let ending = 'answered';
        for (;;) {
          if (await page.locator('.turn-permission').count()) { ending = 'permission pending'; break; }
          if (await page.getByRole('button', { name: 'Send', exact: true }).count()) break;
          if (Date.now() - started > 15 * 60000) { ending = 'timed out'; break; }
          await page.waitForTimeout(2000);
        }
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(evidence, name + '.png') });
        return { name, ending, elapsedMs: Date.now() - started };
      };
      report.turns = [await message(prompt, 'turn-1', 'Start')];
      if (report.turns[0].ending === 'answered' && !await fitted()) report.turns.push(await message(reply, 'turn-2', 'Send'));
      report.reply = report.turns.length > 1 ? reply : null;
      report.panel = await page.locator('section.conversation').innerText().catch(() => null);
    } finally { await browser.close(); }
  } else {
    const granted = await operator.call('session.grant', { projectId: opened.id, externalSessionId: 'claude-code' });
    const mcp = path.join(run, 'mcp.json');
    await fs.writeFile(mcp, JSON.stringify({ mcpServers: { rho: { command: process.execPath, args: [cli, '--mcp', granted.connectionFile] } } }), { mode: 0o600 });
    report.reply = reply;
    const args = (message, resume) => ['--print', message, ...(resume ? ['--resume', resume] : []), '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', mcp,
      '--permission-mode', 'dontAsk', '--allowedTools', tools.join(','), '--max-turns', '40', ...(settings.model ? ['--model', settings.model] : [])];
    // The person's Claude Code with their provider settings; its own HOME has no shell profile, so
    // its shell keeps this PATH. Its credentials stay in the environment, never in evidence.
    const turn = async (message, resume, name) => {
      const started = Date.now();
      const agent = spawn(claude, args(message, resume), { cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, ...settings.env, ...(settings.model ? { ANTHROPIC_MODEL: settings.model } : {}) } });
      const stream = createWriteStream(path.join(evidence, name + '.jsonl'), { mode: 0o600 });
      const errors = createWriteStream(path.join(evidence, name + '-stderr.txt'), { mode: 0o600 });
      agent.stdout.pipe(stream); agent.stderr.pipe(errors);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-agent.pid, 'SIGTERM'); } catch {} }, 15 * 60000);
      const exitCode = await new Promise(resolve => { agent.once('error', () => resolve(-1)); agent.once('close', resolve); });
      clearTimeout(timer); await Promise.all([finished(stream), finished(errors)]);
      const lines = (await fs.readFile(path.join(evidence, name + '.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      return { name, exitCode, timedOut, elapsedMs: Date.now() - started, lines, final: lines.find(line => line.type === 'result') ?? null };
    };
    const first = await turn(prompt, null, 'turn-1');
    const second = first.final?.session_id ? await turn(reply, first.final.session_id, 'turn-2') : null;
    report.turns = [first, second].filter(Boolean).map(({ lines, ...rest }) => ({ ...rest, final: rest.final?.result ?? null, turns: rest.final?.num_turns ?? null }));

    // What the Agent did, from its own stream: each tool call and how it came back.
    for (const { name, lines } of [first, second].filter(Boolean)) {
      const results = new Map();
      for (const line of lines) for (const part of line.message?.content ?? []) if (part.type === 'tool_result') results.set(part.tool_use_id, part);
      for (const line of lines) for (const part of line.message?.content ?? []) if (part.type === 'tool_use') {
        const result = results.get(part.id), text = typeof result?.content === 'string' ? result.content : (result?.content ?? []).map(c => c.text ?? '').join('');
        report.calls.push({ turn: name, tool: part.name, input: part.input, error: !!result?.is_error, result: text.slice(0, 1200) });
      }
    }
  }
  // What Rho holds: the project's kernel record and what a person's page would read.
  report.kernel = await kernelState();
  report.environments = await fs.readdir(project).then(names => names.filter(name => name.startsWith('.') && name !== '.rho'));
  report.work = await fetch(new URL('/api/v2/project.work.read', ready.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: opened.id }) }).then(r => r.json()).catch(error => ({ error: String(error) }));
} finally {
  service.kill('SIGTERM');
  await new Promise(resolve => service.once('close', resolve));
  report.serviceStderr = Buffer.concat(serviceErr).toString('utf8').slice(-4000);
  // A conversation Rho started keeps its steps in Rho's own record of it.
  const find = async directory => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []), found = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await find(file));
      else if (path.basename(directory) === 'conversations' && entry.name.endsWith('.json')) found.push(JSON.parse(await fs.readFile(file, 'utf8')));
    }
    return found;
  };
  if (fromRho) report.conversations = [...await find(state), ...await find(path.join(project, '.rho'))];
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(path.join(evidence, 'report.json'));
}
