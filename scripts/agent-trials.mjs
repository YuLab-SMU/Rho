// Real Agent trials. Each run starts an owned Rho service on a disposable project, gives Claude
// Code a case's prompt through the Agent panel's own operation (conversation.start), waits for the
// answer and tallies what happened: where scripts ran, the shell commands, whether each saved image
// is a figure or a picture, whether the answer board can preview each CSV, and the time taken.
// Runs of a case go in parallel, so a question about the Agent's behaviour gets a rate, not one run.
//
//   npm run build && node scripts/agent-trials.mjs <case.json> [--runs 3] [--model ROUTE] [--out DIR]
//   node scripts/agent-trials.mjs --retally DIR     counts finished runs again, without the Agent
//
// A case is JSON: { "name", "prompt", "files": { "project/path": "/absolute/source", ... },
// "readme": "text of the project's README.md", "path": ["/dir/first/on/PATH"], "minutes": 25 }.
// Claude Code runs with its own HOME in the run folder, allowed Rho's tools and reading files, and
// refusing anything else instead of asking, as the Agent panel's default mode does. The gateway
// settings in ~/.claude/settings.json are read by a wrapper at each Claude start and never written
// into a run; MODEL (or --model) names the route set into every model slot. R_LIBS_USER is passed
// through. The protected resources are this machine's processor and the run folders: runs share
// the machine, and each run folder is kept for inspection.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const casePath = args.find(a => a.endsWith('.json'));
const retally = option('retally');
if (!casePath && !retally) { console.error('usage: node scripts/agent-trials.mjs <case.json> [--runs N] [--model ROUTE] [--out DIR] | --retally DIR'); process.exit(2); }
const trial = retally ? JSON.parse(await fs.readFile(path.join(retally, 'trial.json'), 'utf8')) : JSON.parse(await fs.readFile(casePath, 'utf8'));
const runs = Number(option('runs', '3'));
const model = retally ? trial.model : option('model', process.env.MODEL ?? 'westlakehpc/glm-5.3-flash');
const out = retally ? path.resolve(retally) : path.resolve(option('out', path.join(os.tmpdir(), 'rho-trials', `${trial.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
const minutes = Number(trial.minutes ?? 25);
const claude = process.env.RHO_TRIAL_CLAUDE ?? path.join(os.homedir(), '.local/bin/claude');
const settingsFile = path.join(os.homedir(), '.claude/settings.json');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { RhoClient } = await import(path.join(repo, 'dist/client.js'));
const projectName = trial.project ?? 'trial';
const images = /\.(png|jpe?g|svg|pdf|tiff?|bmp)$/i;

async function oneRun(n) {
  const run = path.join(out, `run-${n}`);
  const home = path.join(run, 'home'), project = path.join(run, 'projects', projectName);
  await fs.mkdir(path.join(home, '.claude'), { recursive: true, mode: 0o700 });
  await fs.mkdir(project, { recursive: true });
  for (const [to, from] of Object.entries(trial.files ?? {})) { await fs.mkdir(path.dirname(path.join(project, to)), { recursive: true }); await fs.copyFile(from, path.join(project, to)); }
  if (trial.readme) await fs.writeFile(path.join(project, 'README.md'), trial.readme);
  const tools = ['mcp__rho__rho_index', 'mcp__rho__rho_resolve', 'mcp__rho__rho_call', 'mcp__rho__rho_read', 'Read', 'Glob', 'Grep'];
  await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: tools } }), { mode: 0o600 });
  const slots = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];
  const wrapper = path.join(run, 'claude');
  await fs.writeFile(wrapper, `#!${process.execPath}
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(${JSON.stringify(settingsFile)}, 'utf8'));
const models = Object.fromEntries(${JSON.stringify(slots)}.map(k => [k, ${JSON.stringify(model)}]));
const child = spawn(${JSON.stringify(claude)}, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, ...s.env, ...models } });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
`, { mode: 0o700 });
  const env = { PATH: [...(trial.path ?? []), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', path.dirname(process.execPath)].join(':'), HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8', RHO_CLAUDE: wrapper, MPLCONFIGDIR: path.join(run, 'mpl'), ...(process.env.R_LIBS_USER ? { R_LIBS_USER: process.env.R_LIBS_USER } : {}) };
  const service = spawn(process.execPath, [path.join(repo, 'dist/cli.js'), '--root', path.join(run, 'projects'), '--state-dir', path.join(run, 'state'), '--example', 'off', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = await fs.open(path.join(run, 'service.log'), 'w');
  let printed = ''; service.stdout.on('data', c => { printed += c; log.write(c); }); service.stderr.on('data', c => log.write(c));
  const result = { run: n, state: 'not started' };
  try {
    for (let i = 0; i < 300 && !printed.includes('\n'); i++) await new Promise(r => setTimeout(r, 100));
    const ready = JSON.parse(printed.split('\n')[0]).ready;
    // The person at this machine: a request from here with no credential, as the browser page sends.
    const person = { call: async (method, body) => {
      const r = await (await fetch(new URL('/api/v2/' + method, ready.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (!r.ok) throw Object.assign(new Error(r.error?.message ?? method + ' failed'), { error: r.error });
      return r.value;
    } };
    const operator = await RhoClient.fromFile(ready.connectionFile);
    const { id: projectId } = await operator.call('project.open', { path: projectName });
    const client = person;
    await fs.writeFile(path.join(run, 'service.json'), JSON.stringify({ url: ready.url, projectId }, null, 2));
    const started = Date.now();
    const { conversation } = await client.call('conversation.start', { projectId, changeId: `trial-${n}-${started}`, text: trial.prompt });
    let read;
    for (;;) {
      await new Promise(r => setTimeout(r, 5000));
      read = await client.call('conversation.read', { projectId, conversationId: conversation.conversationId });
      const turn = read.turns.at(-1);
      if (read.conversation.waitingPermission) { result.state = 'permission pending'; break; }
      if (turn && turn.state !== 'running') { result.state = turn.state; break; }
      if (Date.now() - started > minutes * 60000) { result.state = 'timed out'; await client.call('conversation.stop', { projectId, conversationId: conversation.conversationId, turnId: read.turns.at(-1)?.id }).catch(() => {}); break; }
    }
    result.seconds = Math.round((Date.now() - started) / 1000);
    const turn = read.turns.at(-1);
    const words = (turn?.steps ?? []).filter(s => s.kind === 'text').map(s => s.text ?? '').join('\n').trim();
    result.answer = words.slice(-600);
    Object.assign(result, await tally(run, project, rel => client.call('agent.activity.capture', { projectId, path: rel })));
  } catch (error) { result.error = String(error?.message ?? error).slice(0, 300); }
  finally {
    service.kill('SIGTERM'); await new Promise(r => setTimeout(r, 1500)); if (service.exitCode === null) service.kill('SIGKILL');
    await log.close();
  }
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

// What the run's transcript and project hold.
async function tally(run, project, capture) {
  const shell = { scripts: [], probes: 0, other: 0 }, session = { scripts: [], cells: 0 };
  const transcripts = [];
  for (const dir of await fs.readdir(path.join(run, 'home/.claude/projects')).catch(() => [])) for (const f of await fs.readdir(path.join(run, 'home/.claude/projects', dir))) if (f.endsWith('.jsonl')) transcripts.push(path.join(run, 'home/.claude/projects', dir, f));
  const seen = new Set();
  for (const file of transcripts) for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
    if (!line) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    for (const b of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (b.type !== 'tool_use' || seen.has(b.id)) continue; seen.add(b.id);
      const input = b.input ?? {};
      if (b.name === 'Bash') {
        const cmd = String(input.command ?? '');
        // A script file, also after flags such as python3 -I; not code given with -e or -c.
        const script = cmd.match(/(?:^|[\s;&|(])(Rscript|python3?|\S*\/python3?)((?:\s+-[A-Za-z]+)*)\s+([^\s'"-]\S*\.(?:R|r|py))(?=\s|$|[;&|)])/);
        if (script) shell.scripts.push(`${path.basename(script[1])}${script[2]} ${script[3]}`);
        else if (/^\s*(\S*\/)?(python3?|Rscript)\b/.test(cmd) || /\bRscript -e\b|\bpython3? -c\b/.test(cmd)) shell.probes++;
        else shell.other++;
      } else if (JSON.stringify(input).includes('kernel.run')) {
        session.cells++;
        const code = String(input.input?.code ?? '');
        const ran = code.match(/source\(\s*["']([^"']+)["']|exec\((?:compile\()?open\(\s*["']([^"']+)["']|%run\s+(\S+)|runpy\.run_path\(\s*["']([^"']+)["']/);
        if (ran) session.scripts.push(ran.slice(1).find(Boolean));
      }
    }
  }
  const state = JSON.parse(await fs.readFile(path.join(project, '.rho/plugins/kernel/state.json'), 'utf8').catch(() => '{"cells":[]}'));
  const saved = new Map();
  for (const cell of state.cells ?? []) for (const s of cell.saved ?? []) saved.set(s.sha256, { cell: cell.number, figure: s.figure, problem: s.figureProblem });
  const files = [], csv = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), rel = path.relative(project, p);
      if (e.isDirectory()) { if (!['.rho', '.venv', 'node_modules', '.git'].includes(e.name)) await walk(p); continue; }
      if (images.test(e.name)) {
        const hit = saved.get(createHash('sha256').update(await fs.readFile(p)).digest('hex'));
        files.push({ path: rel, as: hit?.figure ? 'figure' : hit ? 'saved, not a figure' : 'picture', ...(hit?.figure ? { marks: hit.figure.marks, bound: hit.figure.bound } : {}), ...(hit?.problem ? { problem: hit.problem } : {}) });
      } else if (/\.csv$/i.test(e.name) && !rel.startsWith('data/')) {
        const r = await capture(rel).then(() => 'previews', error => `refused: ${error?.error?.message ?? error?.message ?? error}`);
        csv.push({ path: rel, preview: r });
      }
    }
  }
  await walk(project);
  return { shell, session, files, csv };
}

let results;
if (retally) {
  // The answer board's preview of a CSV is the Tables plugin's lexical declaration.
  const { lexicalCsvDeclaration } = await import(path.join(repo, 'node_modules/@rho-workspace/plugin-tables/dist/index.js'));
  results = [];
  for (const dir of (await fs.readdir(out)).filter(d => /^run-\d+$/.test(d)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))) {
    const before = JSON.parse(await fs.readFile(path.join(out, dir, 'result.json'), 'utf8'));
    const project = path.join(out, dir, 'projects', trial.project ?? 'trial');
    const counted = await tally(path.join(out, dir), project, async rel => lexicalCsvDeclaration(await fs.readFile(path.join(project, rel)), rel));
    results.push({ ...before, ...counted });
    await fs.writeFile(path.join(out, dir, 'result.json'), JSON.stringify(results.at(-1), null, 2));
  }
} else {
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'trial.json'), JSON.stringify({ ...trial, model }, null, 2));
  console.log(`${trial.name}: ${runs} runs on ${model} in ${out}`);
  results = await Promise.all(Array.from({ length: runs }, (_, i) => oneRun(i + 1)));
}
const rows = results.map(r => `| ${r.run} | ${r.state}${r.error ? ` (${r.error})` : ''} | ${r.seconds ?? '–'} | ${r.session?.scripts.length ?? '–'} | ${r.shell?.scripts.join(', ') || (r.shell ? '–' : '?')} | ${r.shell ? `${r.shell.probes} / ${r.shell.other}` : '?'} | ${(r.files ?? []).map(f => `${f.path}: ${f.as}${f.marks !== undefined ? ` (${f.bound}/${f.marks})` : ''}`).join('<br>') || '–'} | ${(r.csv ?? []).map(c => `${c.path}: ${c.preview}`).join('<br>') || '–'} |`);
const summary = [`# ${trial.name}`, '', `${results.length} runs, model \`${model}\`, ${new Date().toISOString()}`, '',
  '| Run | Ended | Seconds | Scripts run in the session | Scripts run from a shell | Shell probes / other | Saved images (bound/marks) | CSV previews |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
await fs.writeFile(path.join(out, 'summary.md'), summary);
await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(summary);
