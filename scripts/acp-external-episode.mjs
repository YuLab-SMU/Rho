// A real external ACP client owns input. Rho observes its relay, including through Rho loss.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { westlakeCodexEnv } from './acp-westlake.mjs';
const { values } = parseArgs({ options: { 'package-root': { type: 'string' } } });
const packageRoot = await fs.realpath(values['package-root'] ?? process.cwd()), require = createRequire(path.join(packageRoot, 'package.json'));
const { RhoService } = await import(pathToFileURL(path.join(packageRoot, 'dist/server.js')));
const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')));
const { BrowserClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/browser.js')));
const agentRequire = createRequire(require.resolve('@rho-workspace/plugin-agent'));
const acp = await import(pathToFileURL(agentRequire.resolve('@agentclientprotocol/sdk')));
const root = await fs.mkdtemp('/tmp/rho-acp-external-'), evidence = path.resolve(process.env.RHO_ACP_EVIDENCE ?? 'work/acp-external-source'); await fs.mkdir(evidence, { recursive: true });
if (values['package-root']) {
  for (const source of ['.', '../Rho-plugins', '../Rho-core']) assert.ok(!packageRoot.startsWith(await fs.realpath(source) + path.sep));
  for (const entry of ['@rho-workspace/plugin-agent', '@agentclientprotocol/sdk', '@agentclientprotocol/codex-acp', '@openai/codex/package.json']) {
    const resolved = await fs.realpath(agentRequire.resolve(entry)); assert.ok(resolved.startsWith(packageRoot + path.sep), 'Installed dependency must not resolve from a source checkout: ' + entry);
  }
}
const auth = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude/settings.json'), 'utf8')).env, model = 'westlakehpc/deepseek-v4.1-flash';
const env = { ...process.env, ...await westlakeCodexEnv(auth, root, model) };
const options = { root, stateDir: path.join(root, '.service'), coreBinary: values['package-root'] ? path.join(packageRoot, 'vendor/rho-core') : path.resolve('../Rho-core/target/debug/rho-core'), rscript: 'Rscript', webRoot: path.join(packageRoot, 'dist/web') };
const report = { passed: false, root, mode: values['package-root'] ? 'installed' : 'source', packageRoot, provider: 'Westlake HPC', model, checks: [], screenshots: [], browserErrors: [], permissions: 0 };
const peers = [], pids = new Set(); let service, browser, page, project, person, serial = 0;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(read, valid, label, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await read(); if (valid(v)) return v; }
    catch (e) { if (e.message !== 'fetch failed') throw e; report.readReconnects = (report.readReconnects ?? 0) + 1; }
    if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(200);
  }
}
async function start() { service = await new RhoService(options).start(); options.port = Number(new URL(service.url).port); person = new BrowserClient({ url: service.url }); }
const work = () => person.call('project.work.read', { projectId: project.id });
async function snap(name) { const file = `${++serial}-${name}.png`; await page.screenshot({ path: path.join(evidence, file), fullPage: true }); report.screenshots.push(file); }
async function peer(relay) {
  const args = relay ? [path.join(packageRoot, 'dist/cli.js'), '--acp', project.root, '--acp-agent', 'codex'] : [agentRequire.resolve('@agentclientprotocol/codex-acp')];
  const child = spawn(process.execPath, args, { cwd: project.root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
  const text = [];
  const connection = acp.client({ name: 'external-acceptance-client' })
    .onNotification(acp.methods.client.session.update, ({ params }) => { const u = params.update; if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') text.push(u.content.text); })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      report.permissions++; const option = params.options.find(o => o.kind === 'allow_once');
      return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
    }).connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const item = { child, connection, text, sessionId: null, canClose: false, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (item.sessionId && item.canClose && !connection.signal.aborted) await Promise.race([
      connection.agent.request(acp.methods.agent.session.close, { sessionId: item.sessionId }).catch(() => {}), delay(5000)
    ]);
    connection.close(); child.stdin.end(); await Promise.race([new Promise(r => child.once('close', r)), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  } };
  peers.push(item);
  const init = await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: 1, clientInfo: { name: 'external-acceptance-client', version: '1' }, clientCapabilities: {} });
  assert.equal(init.protocolVersion, 1); assert.equal(init.agentCapabilities.loadSession, true); report.adapter = init.agentInfo;
  item.canClose = init.agentCapabilities.sessionCapabilities?.close != null;
  return item;
}
const prompt = (p, sessionId, text) => p.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
try {
  await start(); project = await new RhoClient({ url: service.url, token: service.adminToken }).call('project.create', { name: 'External ACP episode' }); report.project = project.id;
  await fs.writeFile(path.join(project.root, 'input.txt'), 'alpha=7\nbeta=11\n');
  await fs.writeFile(path.join(project.root, 'gate.py'), 'import os,pathlib,time\np=pathlib.Path(".")\nwith (p/"gate.count").open("a") as f:f.write("run\\n")\n(p/"gate.pid").write_text(str(os.getpid()))\nwhile not (p/"gate.release").exists(): time.sleep(.05)\nprint("external gate completed")\n');
  const original = await peer(false), created = await original.connection.agent.request(acp.methods.agent.session.new, { cwd: project.root, mcpServers: [] });
  const sessionId = created.sessionId; original.sessionId = sessionId; report.sessionId = sessionId;
  assert.equal((await prompt(original, sessionId, 'Remember silver lake 你好. Read input.txt with a native tool and report alpha plus beta. Do not modify files.')).stopReason, 'end_turn');
  assert.match(original.text.join(''), /18/); await original.close();
  assert.equal((await work()).sessions.length, 0, 'an unconnected native session is not discovered or started by a read');
  let external = await peer(true); await external.connection.agent.request(acp.methods.agent.session.load, { sessionId, cwd: project.root, mcpServers: [] });
  external.sessionId = sessionId;
  const attached = await until(work, w => w.sessions.some(s => s.source === 'external-acp'), 'external load observed');
  const identity = attached.sessions[0].id; assert.equal(attached.sessions[0].sessionId, sessionId); assert.ok(attached.sessions[0].observation.historyUpdates > 0);
  assert.equal((await person.call('observation.snapshot', { projectId: project.id })).conversations.length, 0);
  report.checks.push('an existing externally created Codex session loaded through the ACP relay; original identity and replay retained, with no Rho conversation or prompt');
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => report.browserErrors.push(e.message));
  await page.goto(service.url); await page.locator('.project-row').filter({ hasText: 'External ACP episode' }).click(); await page.getByText('Input stays in the original client', { exact: true }).waitFor(); await snap('external-attached');
  const running = prompt(external, sessionId, 'Use update_plan to report two steps: run the gate, then write the result. Run python3 gate.py exactly once in the foreground with exec_command yield_time_ms=30000. Do not background, retry or edit gate.py. After it finishes, use apply_patch to create external-result.txt containing the remembered phrase and sum, then mark the plan complete.');
  running.catch(() => {});
  const pid = Number(await until(() => fs.readFile(path.join(project.root, 'gate.pid'), 'utf8').catch(() => ''), Boolean, 'external foreground gate')); pids.add(pid);
  await until(work, w => w.sessions[0].state === 'running' && w.sessions[0].observation.plan?.entries.length, 'live external plan');
  await page.locator('.session-plan').waitFor(); await snap('live-external-plan');
  assert.equal(await page.getByRole('button', { name: 'Continue conversation', exact: true }).count(), 0);
  await service.close(); service = null;
  assert.equal(external.child.exitCode, null, 'Rho shutdown must not own the external process'); process.kill(pid, 0);
  await start(); await page.reload(); await page.getByText('Input stays in the original client', { exact: true }).waitFor(); await snap('rho-restarted-external-running');
  await until(work, w => w.sessions[0]?.id === identity, 'Rho read connection restored');
  await fs.writeFile(path.join(project.root, 'gate.release'), 'release'); assert.equal((await running).stopReason, 'end_turn');
  const completed = await until(work, w => w.sessions[0].state === 'completed' && w.files.some(f => f.path === 'external-result.txt'), 'external result observed');
  const bytes = await fs.readFile(path.join(project.root, 'external-result.txt')); assert.match(bytes.toString(), /silver lake 你好/); assert.match(bytes.toString(), /18/);
  assert.equal(completed.files.find(f => f.path === 'external-result.txt').sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(await fs.readFile(path.join(project.root, 'gate.count'), 'utf8'), 'run\n');
  report.checks.push('live ACP plans and current result files survive Rho restart while the original external client owns the running command; one native invocation');
  await external.close(); await until(work, w => !w.sessions[0].observation.connected, 'external disconnect observed');
  external = await peer(true); await external.connection.agent.request(acp.methods.agent.session.load, { sessionId, cwd: project.root, mcpServers: [] });
  external.sessionId = sessionId;
  assert.equal((await prompt(external, sessionId, 'State the remembered phrase and sum only. Do not use tools or repeat any command.')).stopReason, 'end_turn');
  assert.match(external.text.join(''), /silver lake/); assert.equal((await work()).sessions[0].id, identity);
  for (const width of [1440, 768, 390]) { await page.setViewportSize({ width, height: 900 }); await page.locator('.work-session').scrollIntoViewIfNeeded(); await delay(300); await snap('external-' + width); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); }
  assert.equal((await person.call('observation.snapshot', { projectId: project.id })).conversations.length, 0); await assert.rejects(fs.stat(path.join(project.root, '.rho/host.sock')), { code: 'ENOENT' });
  await external.close(); report.work = await until(work, w => !w.sessions[0].observation.connected, 'final disconnected projection');
  report.checks.push('external reconnect retains the same source/session and native context; observations never claim the input or create a Core Host');
  assert.deepEqual(report.browserErrors, []); report.passed = true;
} catch (error) { report.failure = String(error.message).replaceAll(auth.ANTHROPIC_BASE_URL, '[gateway]').replace(/https?:\/\/[^\s"'<>]+/g, '[private URL]'); process.exitCode = 1; if (page) await snap('failure').catch(() => {}); }
finally {
  for (const p of peers) await p.close().catch(() => {}); for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {}
  await browser?.close(); await service?.close(); await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failure: report.failure, evidence }));
}
