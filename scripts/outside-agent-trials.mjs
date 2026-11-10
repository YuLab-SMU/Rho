// Outside-Agent trials. A person asks an Agent that runs outside Rho (Claude Code here; WorkBuddy,
// Codex and others in practice) to do something with Rho in one of their own folders. Each run gets
// a throwaway home holding a copy of that folder, `rho` on PATH (this checkout's build), and an
// `open`/`xdg-open` that records what would have opened instead of opening it. The Agent gets the
// request once, with its shell and file tools and nothing to approve. Variants: `bare` (only `rho`
// on PATH, as an Agent that never installed the Skill) and `skill` (the Skill this checkout ships,
// installed in the Agent's skills folder). Runs go in parallel, so a question gets a rate.
//
//   npm run build && node scripts/outside-agent-trials.mjs <case.json> [--runs 3] [--variants bare,skill] [--model ROUTE] [--out DIR]
//
// A case is JSON: { "name", "prompt", "copy": "/absolute/folder", "folder": "Projects/<name>",
// "exclude": ["names", "not", "copied"], "minutes": 10, "before": "open" }; "before": "open" runs
// `rho open --no-browser` in the folder first, as when the person asked earlier. Runs live under
// /tmp, outside any checkout whose instructions the Agent would read, in paths short enough for a
// project's Host socket (103 bytes on macOS); this Node comes first on PATH. Afterwards each run records the time to
// Rho's first ready line, every shell command, whether the Skill was read, every Rho the run
// started and whether it still answered after the Agent's process ended, whether the folder is
// one of its projects, what was opened, and the answer the person read. Each Rho a run started is
// then stopped. The protected resources are this machine's processor and the run folders.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const casePath = args.find(a => a.endsWith('.json'));
if (!casePath) { console.error('usage: node scripts/outside-agent-trials.mjs <case.json> [--runs N] [--variants bare,skill] [--model ROUTE] [--out DIR]'); process.exit(2); }
const trial = JSON.parse(await fs.readFile(casePath, 'utf8'));
const runs = Number(option('runs', '3')), variants = option('variants', 'bare,skill').split(',');
const model = option('model', process.env.MODEL ?? 'westlakehpc/glm-5.3-flash');
const out = path.resolve(option('out', `/tmp/ro-${Date.now().toString(36)}`));
const minutes = Number(trial.minutes ?? 10);
const claude = process.env.RHO_TRIAL_CLAUDE ?? path.join(os.homedir(), '.local/bin/claude');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = path.join(repo, 'dist/cli.js');
const gateway = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude/settings.json'), 'utf8')).env ?? {};
const slots = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];
const run = (file, argv, options) => new Promise(resolve => execFile(file, argv, { timeout: 60000, ...options }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));

async function oneRun(variant, n) {
  const dir = path.join(out, `${variant[0]}${n}`), home = path.join(dir, 'h'), bin = path.join(dir, 'bin');
  const folder = path.join(home, trial.folder);
  await fs.mkdir(bin, { recursive: true }); await fs.mkdir(path.join(home, '.claude'), { recursive: true, mode: 0o700 });
  const skip = new Set(trial.exclude ?? []);
  await fs.cp(trial.copy, folder, { recursive: true, filter: source => !skip.has(path.basename(source)) });
  await fs.writeFile(path.join(bin, 'rho'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o755 });
  for (const opener of ['open', 'xdg-open']) await fs.writeFile(path.join(bin, opener), `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(dir, 'opened.log'))}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Skill'] } }), { mode: 0o600 });
  const env = { PATH: [bin, path.dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8',
    ...(process.env.R_LIBS_USER ? { R_LIBS_USER: process.env.R_LIBS_USER } : {}), ...gateway, ...Object.fromEntries(slots.map(k => [k, model])) };
  if (variant === 'skill') await run(process.execPath, [cli, '--install-skill', path.join(home, '.claude/skills/rho')], { env });
  if (trial.before === 'open') { const opened = await run(process.execPath, [cli, 'open', '--no-browser'], { env, cwd: folder }); if (opened.code) throw new Error('rho open failed: ' + opened.stderr); }

  const began = Date.now(), lines = [];
  const agent = spawn(claude, ['-p', trial.prompt, '--output-format', 'stream-json', '--verbose'], { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffered = '';
  agent.stdout.on('data', chunk => { buffered += chunk; let i; while ((i = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, i); buffered = buffered.slice(i + 1); try { lines.push({ t: (Date.now() - began) / 1000, ...JSON.parse(line) }); } catch {} } });
  let stderr = ''; agent.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  const timer = setTimeout(() => agent.kill('SIGTERM'), minutes * 60000);
  const code = await new Promise(resolve => agent.on('exit', c => resolve(c)));
  clearTimeout(timer);
  await fs.writeFile(path.join(dir, 'stream.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  // What the Agent did, from its own stream.
  const calls = [], results = new Map();
  for (const l of lines) for (const c of l.message?.content ?? []) {
    if (c.type === 'tool_use') calls.push({ t: l.t, id: c.id, name: c.name, input: c.input });
    if (c.type === 'tool_result') results.set(c.tool_use_id, { t: l.t, text: (Array.isArray(c.content) ? c.content.map(x => x.text ?? '').join('') : String(c.content ?? '')) });
  }
  const readyAt = [...results.values()].filter(r => r.text.includes('{"ready"')).map(r => r.t).sort((a, b) => a - b)[0] ?? null;
  const final = lines.find(l => l.type === 'result');
  const skillRead = calls.some(c => c.name === 'Skill' || (c.name === 'Read' && /skills\/rho\//.test(c.input?.file_path ?? '')));
  const commands = calls.filter(c => c.name === 'Bash').map(c => `${c.t.toFixed(0)}s ${String(c.input?.command ?? '').replace(/\s+/g, ' ').slice(0, 220)}`);
  // When the Agent first used Rho's own commands, and how often it read Rho's state files instead.
  const said = c => c.name === 'Bash' ? String(c.input?.command ?? '') : c.name === 'Read' ? String(c.input?.file_path ?? '') : '';
  const firstRhoAt = calls.find(c => /\brho(\.cmd)? (tool|open|connect)\b/.test(said(c)))?.t ?? null;
  const stateReads = calls.filter(c => /\.rho\/(rho|plugins|agent)\//.test(said(c))).length;

  // Every Rho this run started: the notes in its home, and processes started with a state in it.
  const notes = await fs.readdir(path.join(home, 'Rho/running')).catch(() => []);
  const states = new Set();
  for (const name of notes) { try { states.add(JSON.parse(await fs.readFile(path.join(home, 'Rho/running', name), 'utf8')).stateDirectory); } catch {} }
  const ps = await run('/bin/ps', ['-axo', 'command']);
  for (const line of ps.stdout.split('\n').filter(l => l.includes(dir) && l.includes('--state-dir'))) { const m = line.match(/--state-dir[= ]("[^"]+"|\S+)/); if (m) states.add(m[1].replace(/"/g, '')); }
  const services = [];
  const realFolder = await fs.realpath(folder);
  const { RhoClient } = await import(path.join(repo, 'dist/client.js'));
  for (const state of states) {
    const status = JSON.parse((await run(process.execPath, [cli, '--status', '--state-dir', state], { env })).stdout || '{}').status ?? {};
    let project = null;
    if (status.running) { try { const list = await (await RhoClient.fromFile(path.join(state, 'connection.json'))).call('project.list', {}); const p = list.find(x => x.root === realFolder || x.root === folder); project = p ? p.id : false; } catch {} }
    services.push({ state: path.relative(home, state), running: status.running, answers: status.answers, folderIsProject: project === null ? null : !!project, projectId: project || undefined });
    if (status.running) await run(process.execPath, [cli, '--stop', '--state-dir', state], { env, timeout: 130000 });
  }
  const opened = (await fs.readFile(path.join(dir, 'opened.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const answer = final?.result ?? '';
  const result = { variant, n, exit: code, seconds: Math.round((Date.now() - began) / 1000), turns: final?.num_turns, readyAt, firstRhoAt, stateReads, skillRead, toolCalls: calls.length,
    byTool: calls.reduce((m, c) => (m[c.name] = (m[c.name] ?? 0) + 1, m), {}), services, opened,
    told: { browser: /浏览器|browser/i.test(answer), address: /http:\/\/127\.0\.0\.1:\d+/.test(answer) }, commands, answer, stderr: code ? stderr : undefined };
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'trial.json'), JSON.stringify({ ...trial, model, runs, variants }, null, 2));
const all = await Promise.all(variants.flatMap(v => Array.from({ length: runs }, (_, i) => oneRun(v, i + 1))));
await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(all.map(({ commands, answer, ...r }) => r), null, 2));
for (const r of all) console.log(JSON.stringify({ run: `${r.variant}-${r.n}`, seconds: r.seconds, readyAt: r.readyAt, firstRhoAt: r.firstRhoAt, stateReads: r.stateReads, skill: r.skillRead, calls: r.toolCalls, services: r.services.map(s => `${s.state}:${s.running ? 'up' : 'down'}${s.folderIsProject ? '+project' : ''}`), opened: r.opened.length, told: r.told }));
console.log(out);
