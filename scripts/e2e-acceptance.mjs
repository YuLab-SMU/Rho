// W7 exit check (docs/WORKSPACE-PLAN.md): Rho installed from its packed tarball outside every
// checkout, with Claude Code connected the way a person connects it (rho --grant, then the MCP
// server it prints), carries one piece of work through: a task in natural language becomes a
// run the person reviews in a form and starts once; they open what it wrote, ask about one row,
// hand the question over with the request Rho copies, and the Agent's answer appears under the
// question. The run exports as files and the work survives a restart of the installed service.
// E1–E5 and M1–M10 are measured at each state; the install and the cold start are timed.
//
// RHO_E2E_MODEL=1 runs real Claude Code: that is the W7 exit. RHO_E2E_STANDIN=1 runs the same
// path with a scripted Agent for developing this script; its report says so and is not the exit.
// The pairing link, connection files and session tokens stay in memory or in the private run
// directory; the report names none of them.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { rulers, profiles, firstUnit, agentMarker, facts } from './rulers.mjs';
import { runClaude } from './claude-consumer.mjs';
import { mcpToolNames } from './mcp-consumer.mjs';
const tarball = path.resolve(process.argv[2] ?? '');
assert.ok(tarball.endsWith('.tgz'), 'Select the assembled application tarball (scripts/pack-local.mjs).');
const model = process.env.RHO_E2E_MODEL === '1', standIn = process.env.RHO_E2E_STANDIN === '1';
assert.ok(model !== standIn, 'Select RHO_E2E_MODEL=1 (real Claude Code, the W7 exit) or RHO_E2E_STANDIN=1 (a scripted Agent; not the exit).');
const rscript = process.env.RHO_RSCRIPT ?? spawnSync('which', ['Rscript'], { encoding: 'utf8' }).stdout.trim();
assert.ok(path.isAbsolute(rscript), 'Rscript must be installed; set RHO_RSCRIPT to its absolute path.');
const evidence = path.resolve(process.env.RHO_E2E_EVIDENCE ?? 'work/e2e-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
// The run directory holds credentials (connection files); only screenshots and the report leave it.
const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rho-e2e-'));
const env = { ...process.env }; delete env.RHO_CORE_BINARY; delete env.RHO_PACKAGE_ROOT;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { scenario: 'W7-end-to-end', agent: model ? 'real Claude Code' : 'scripted stand-in (not the W7 exit)', passed: false, platform: process.platform + '-' + process.arch, node: process.version,
  tarballSha256: sha256(await fs.readFile(tarball)), timings: {}, memory: {}, contracts: {}, modelRuns: [], checks: [], rulers: [] };
const passed = (name, detail = {}) => { report.checks.push({ name, ...detail }); process.stdout.write(`ok · ${name}\n`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error('Timed out: ' + label + ' · last ' + JSON.stringify(value)?.slice(0, 400)); await sleep(250); }
}
const rss = pid => Number(spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || 0;
let child, browser;
const install = path.join(root, 'installation'), projects = path.join(root, 'projects'), state = path.join(root, 'state');
const bin = path.join(install, 'node_modules/.bin/rho');
function start() {
  child = spawn(bin, ['--root', projects, '--state-dir', state, '--rscript', rscript], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  return new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('The installed launcher did not report ready: ' + stderr)), 60000);
    child.stdout.on('data', d => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { const v = JSON.parse(line); if (v.ready) { clearTimeout(timer); resolve(v.ready); } } catch {} } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('The installed launcher exited ' + code + ': ' + stderr)); });
  });
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; } }
async function restart() { await stop(); for (let attempt = 0; ; attempt++) { try { return await start(); } catch (error) { if (attempt > 10) throw error; await sleep(300); } } }
const measured = (page, name, first, extra = {}) => rulers(page, { name, profile: profiles.shell, first, enforce: true, evidence, report, restore: [1440, 900], ...extra });

try {
  // 1. A clean install from the tarball, outside every checkout, with no development overrides.
  await fs.mkdir(install); await fs.mkdir(projects);
  let t = Date.now();
  const npm = spawnSync('npm', ['install', '--prefix', install, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: root, env, encoding: 'utf8' });
  assert.equal(npm.status, 0, 'npm install failed: ' + npm.stderr.slice(-2000));
  report.timings.installMs = Date.now() - t;
  const pkg = path.join(install, 'node_modules/@rho-workspace/local');
  const { RhoClient } = await import(pathToFileURL(path.join(pkg, 'dist/client.js')).href);
  report.package = { name: '@rho-workspace/local', version: JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8')).version };

  // Cold start: the person's browser is already open; the clock runs from the command to the
  // rendered home page.
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t = Date.now();
  const ready = await start();
  report.timings.readyMs = Date.now() - t;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ready.openUrl).origin });
  await page.goto(ready.openUrl);
  await page.locator('.home-title h1').waitFor();
  report.timings.coldStartMs = Date.now() - t;
  assert.ok(report.timings.coldStartMs <= 3000, `cold start ${report.timings.coldStartMs} ms > 3000`);
  report.memory.serviceIdleRssKiB = rss(child.pid);
  let peak = report.memory.serviceIdleRssKiB; const sampler = setInterval(() => { if (child?.pid) peak = Math.max(peak, rss(child.pid)); }, 250);
  passed('installed from the tarball; the home page renders from a cold start within 3 s', { ...report.timings });

  // The person's project: their plant data, already registered by whoever set the project up.
  let admin = await RhoClient.fromFile(path.join(state, 'connection.json'));
  const project = await admin.call('project.create', { name: 'plants' });
  const call = (m, b = {}) => admin.call(m, { projectId: project.id, ...b });
  const csv = spawnSync(rscript, ['-e', `d <- datasets::PlantGrowth; write.csv(data.frame(plant = sprintf("p%02d", seq_len(nrow(d))), d), ${JSON.stringify(path.join(project.root, 'plants.csv'))}, row.names = FALSE)`], { encoding: 'utf8' });
  assert.equal(csv.status, 0, csv.stderr);
  await call('resource.register', { expectedDigest: sha256(await fs.readFile(path.join(project.root, 'plants.csv'))), declaration: { path: 'plants.csv', kind: 'table', format: { encoding: 'csv',
    columns: [{ name: 'plant', type: 'string', nullValues: [] }, { name: 'weight', type: 'number', nullValues: [] }, { name: 'group', type: 'string', nullValues: [] }], key: { column: 'plant', namespace: 'plants' } } } });

  // Claude Code is connected the way a person connects it: the installed rho grants this
  // project to one session and prints the MCP server to add.
  const grantRun = spawnSync(bin, ['--grant', path.join(state, 'connection.json'), '--project', path.relative(projects, project.root)], { cwd: root, env, encoding: 'utf8' });
  assert.equal(grantRun.status, 0, grantRun.stderr);
  const granted = JSON.parse(grantRun.stdout);
  assert.match(granted.claude, /^claude mcp add rho-\S+ -- /);
  const mcpConfig = path.join(root, 'mcp.json');
  await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { [granted.mcp.name]: { command: granted.mcp.command, args: granted.mcp.args } } }), { mode: 0o600 });
  const agentClient = await RhoClient.fromFile(granted.connectionFile), agent = (m, b = {}) => agentClient.call(m, { projectId: project.id, ...b });
  report.grant = { methods: granted.methods, server: granted.mcp.name };
  const claude = async (label, prompt) => {
    const run = await runClaude(['--print', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', mcpConfig, '--tools', '',
      '--allowedTools', ...mcpToolNames.map(n => `mcp__${granted.mcp.name}__${n}`), '--permission-mode', 'dontAsk', '--setting-sources', '', '--max-turns', '60', prompt], project.root, root, 900000);
    const result = JSON.parse(await fs.readFile(path.join(root, 'claude-result.json'), 'utf8').catch(() => '') || '{}');
    report.modelRuns.push({ label, exitCode: run.exitCode, timedOut: run.timedOut, elapsedMs: run.elapsedMs, client: run.clientVersion, turns: result.num_turns, costUsd: result.total_cost_usd, isError: result.is_error, answer: String(result.result ?? '').slice(0, 1500) });
    assert.equal(run.exitCode, 0, `Claude Code (${label}) exited ${run.exitCode}; a scripted Agent is not substituted.`);
  };
  const activity = async () => (await call('observation.snapshot')).activity?.entries ?? [];

  // 2. Natural language → a proposed run. The person's words only; the shipped Skills say how.
  const task = 'In Rho, compare plant weight across the groups in plants.csv (ctrl, trt1 and trt2). Write the analysis as an R script, analysis.R, that saves a summary table with one row per group (columns group, n, mean, sd), keyed by group so I can ask about a group, and a boxplot of weight by group as a PNG. Don\'t run it yourself: put it in front of me in Rho as a run I can review and start.';
  report.task = task;
  if (model) await claude('task', task);
  else await standInPropose(agent, call);
  const proposals = (await call('observation.snapshot')).compositions.flatMap(c => (c.nodes ?? c.views ?? []).filter(v => v.component === 'rho.action').map(view => ({ compositionId: c.compositionId, view })));
  assert.ok(proposals.length >= 1, 'The Agent proposed no run form (rho.action).');
  const { compositionId, view: proposal } = proposals.at(-1), operationId = proposal.props.operationId;
  report.proposal = { compositionId, title: proposal.props.title, action: proposal.props.action, operationId, inputKeys: Object.keys(proposal.props.input ?? {}) };
  assert.equal((await activity()).some(e => e.method === 'action.submit' && e.outcome === 'returned'), false, 'The Agent submitted a run instead of proposing it.');
  await assert.rejects(call('action.lookup', { operationId }), e => e.error?.kind === 'not_found', 'Nothing runs before the person starts it.');
  passed('a natural-language task becomes a proposed run form; nothing runs until the person starts it', report.proposal);

  // 3. The person opens the layout the Agent arranged and starts the run once.
  // The project was set up after the home page loaded; the person reads the list again.
  await page.reload();
  await page.locator('.project-row').filter({ hasText: 'plants' }).click();
  await page.locator('.project-nav').getByRole('button', { name: new RegExp('^' + compositionId) }).click();
  await page.locator('.shell-stage').waitFor();
  // The person turns to the proposal: in a split it is beside the code, in tabs behind it,
  // and below 768 px one view shows at a time.
  const form = page.locator(`[data-rho-action-form="${operationId}"]`);
  await page.getByRole('tab', { name: proposal.props.title ?? proposal.props.action }).first().click();
  await form.waitFor();
  const runButton = form.getByRole('button', { name: 'Run', exact: true });
  await until(() => runButton.isEnabled(), Boolean, 'the form checks clean against the owner contract');
  await measured(page, 'form', () => form.locator('h2'));
  report.contracts.E1 = { form: await agentMarker(page, profiles.shell) };
  await runButton.click();
  await form.locator(`[data-rho-submitted="${operationId}"]`).waitFor();
  let ran = await until(() => call('action.lookup', { operationId }), r => ['completed', 'failed', 'unknown'].includes(r.execution), 'the run ends', 300000);
  report.run = { operationId, execution: ran.execution, submittedBy: ran.principal.split(':')[0] };
  assert.equal(report.run.submittedBy, 'browser', 'the person submitted it');
  const events = JSON.parse(await fs.readFile(path.join(project.root, '.rho/rho/events.json'), 'utf8')).events.filter(e => e.subject === operationId);
  assert.equal(events.filter(e => e.type === 'operation.delivery').length, 1, 'Core received the person\'s run exactly once.');
  await form.getByRole('button', { name: 'Open run', exact: true }).click();
  let runView = page.locator(`section.shell-run[aria-label="${operationId}"]`);
  await runView.waitFor();
  // A failed run is repaired the way a person repairs one: they copy Rho's request to the Agent.
  if (ran.execution !== 'completed') {
    if (!model) throw new Error('The scripted run did not complete: ' + JSON.stringify(ran.native?.status));
    await runView.getByRole('button', { name: 'Ask the Agent to fix', exact: true }).click();
    await runView.getByRole('button', { name: 'Copy request for the Agent', exact: true }).click();
    await runView.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    await claude('repair', await page.evaluate(() => navigator.clipboard.readText()));
    const repair = await until(async () => (await call('project.runs', { limit: 50 })).runs.find(r => r.repairOf === operationId && ['completed', 'failed', 'unknown'].includes(r.execution)), Boolean, 'the repair ends', 300000);
    report.repair = { operationId: repair.operationId, execution: repair.execution };
    assert.equal(repair.execution, 'completed', 'The repair did not complete.');
    await runView.locator(`[data-rho-repaired-by="${repair.operationId}"]`).click();
    ran = await call('action.lookup', { operationId: repair.operationId });
    runView = page.locator(`section.shell-run[aria-label="${repair.operationId}"]`);
    await runView.waitFor();
  }
  passed('the person starts the proposed run once and it completes', { ...report.run, ...(report.repair ? { repairedBy: report.repair } : {}) });

  // 4. What it wrote: the person checks the files and opens the summary table from the run.
  const finished = ran.operationId;
  const check = runView.getByRole('button', { name: /^(Check|List) its files$/ });
  const tableLink = runView.locator('button[data-rho-artifact]').filter({ hasText: /\.csv$/ }).first();
  await check.or(tableLink).first().waitFor({ timeout: 30000 });
  if (await check.isVisible()) await check.click();
  await tableLink.waitFor({ timeout: 30000 });
  await measured(page, 'run', () => runView.locator('h2'));
  await tableLink.click();
  const result = page.locator('[data-owner-view^="result:"]').last();
  await result.locator('.ag-row').first().waitFor();
  const resultId = await result.getAttribute('data-owner-view'), header = page.locator(`[data-owner-header="${resultId}"]`);
  const shownGroups = await result.locator('.ag-row [col-id="group"]').allTextContents();
  assert.deepEqual([...shownGroups].sort(), ['ctrl', 'trt1', 'trt2'], 'the summary table shows one row per group');
  const tableFirst = width => firstUnit(width < 768 ? page.locator('.shell-panel > .shell-view') : result, 'table');
  await measured(page, 'result', tableFirst);
  report.contracts.E4 = await facts(page);
  passed('the person opens the summary table the run wrote, from the run itself', { groups: shownGroups.length });

  // 5. A question about one row, handed to the Agent with the request Rho copies.
  const trt2 = await result.locator('.ag-row').filter({ has: page.locator('[col-id="group"]', { hasText: /^trt2$/ }) }).getAttribute('row-index');
  await result.locator(`.ag-row[row-index="${trt2}"] input[type="checkbox"]`).first().check();
  await header.getByRole('button', { name: 'Ask about selected rows', exact: true }).click();
  const editor = result.locator('.table-question-editor .cm-content'); await editor.waitFor(); await editor.click();
  const question = 'Is trt2 heavier than ctrl beyond chance? Add a t-test of trt2 against ctrl to the analysis and tell me the p-value.';
  await page.keyboard.type(question);
  await until(() => result.getByRole('button', { name: 'Send question', exact: true }).isEnabled(), Boolean, 'the question draft is confirmed');
  await result.getByRole('button', { name: 'Send question', exact: true }).click();
  const toggle = header.locator('.table-question-toggle');
  const expand = async () => { if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click(); };
  await toggle.filter({ hasText: 'Prepared · not fetched by Agent' }).waitFor();
  await expand();
  await result.getByRole('button', { name: 'Copy request for the Agent', exact: true }).click();
  await result.getByRole('button', { name: 'Copied', exact: true }).waitFor();
  const request = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(request, /^Answer my question in Rho: read context \S+\./);
  // The copied request awaits the person, as the repair request does in the action acceptance.
  await measured(page, 'question', tableFirst, { transientAllowed: true });
  passed('the person asks about one row and copies the request for the Agent');

  // 6. The Agent continues from exactly what the person pastes, and answers under the question.
  if (model) await claude('question', request);
  else await standInAnswer(agent, request);
  const [thread] = await call('annotation.list');
  const reply = thread.messages.find(m => m.replyTo === thread.messages[0].id && m.author.startsWith('agent:'));
  assert.ok(reply, 'The Agent did not reply to the question.');
  report.answer = { text: reply.draft?.text?.slice(0, 600), linkedResults: reply.resources?.length ?? 0 };
  await toggle.filter({ hasText: 'Explicit Agent response' }).waitFor({ timeout: 30000 });
  await expand();
  await result.locator('.table-question-reply').getByText('Agent response', { exact: true }).first().waitFor();
  const contextId = request.match(/read context (\S+?)\./)[1], all = await activity();
  report.contracts.E3 = { contextFetched: all.some(e => e.method === 'context.read' && e.contextId === contextId && e.outcome === 'returned'), replyTo: reply.replyTo === thread.messages[0].id, linkedResults: report.answer.linkedResults };
  assert.ok(report.contracts.E3.contextFetched, 'E3: the Agent read the question\'s context');
  await measured(page, 'answer', tableFirst, { transientAllowed: true });
  // A linked result opens at the exact version the Agent named.
  if (reply.resources?.length) {
    const [linked] = reply.resources;
    await result.locator('.table-question-reply').getByRole('button', { name: 'Open linked result · ' + linked.version.slice(0, 8) }).first().click();
    await page.locator(`[data-owner-view="result:${linked.id.slice(0, 32)}:${linked.version.slice(0, 32)}"]`).waitFor();
    report.contracts.E3.linkedOpens = true;
  }
  report.contracts.E5 = { taskMapDeclares: all.filter(e => e.method === 'task.map.declare').length };
  report.agentActivity = { calls: all.length, rejected: all.filter(e => e.outcome === 'rejected').map(e => [e.method, e.errorKind]), methods: [...new Set(all.map(e => e.method))].sort() };
  passed('the Agent reads the question\'s context and its answer appears under the question', report.answer);

  // 7. The run leaves Rho as files, and the work survives a restart of the installed service.
  if (!await runView.isVisible().catch(() => false)) await page.getByRole('tab', { name: finished }).first().click();
  await runView.waitFor();
  await runView.getByRole('button', { name: 'Export files…', exact: true }).click();
  await runView.getByRole('button', { name: 'Export', exact: true }).click();
  const leave = runView.getByRole('button', { name: 'Leave them out', exact: true });
  await runView.locator('[data-rho-export="done"]').or(leave).first().waitFor();
  if (await leave.isVisible().catch(() => false)) await leave.click();
  await runView.locator('[data-rho-export="done"]').waitFor();
  const exported = path.join(project.root, 'exports', finished), record = JSON.parse(await fs.readFile(path.join(exported, 'provenance.json'), 'utf8'));
  for (const f of record.files.filter(f => f.state === 'exported')) assert.equal(f.sha256, sha256(await fs.readFile(path.join(exported, f.file))), f.file);
  assert.ok(record.files.some(f => f.role === 'output' && f.state === 'exported' && f.path.endsWith('.csv')), 'the summary table is exported');
  report.export = { files: record.files.map(f => [f.file ?? f.path, f.state]), partial: record.partial };
  clearInterval(sampler); report.memory.servicePeakRssKiB = peak;
  await restart();
  admin = await RhoClient.fromFile(path.join(state, 'connection.json'));
  await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor({ timeout: 30000 });
  await page.getByRole('tab', { name: /summary\.csv/ }).first().click();
  await toggle.filter({ hasText: 'Explicit Agent response' }).waitFor({ timeout: 30000 });
  assert.equal((await call('annotation.list'))[0].messages.length, thread.messages.length);
  assert.ok((await call('project.runs', {})).runs.some(r => r.operationId === finished && r.execution === 'completed'));
  passed('the run exports as files with provenance, and the question and answer survive a restart', report.export);

  assert.ok(report.contracts.E1.form.visible, 'E1: the Agent\'s current object is named on the default screen');
  assert.equal(report.contracts.E4.agentInVerified, false, 'E4: the Agent\'s words never wear the verified colour');
  assert.equal(report.contracts.E5.taskMapDeclares, 0, 'E5: no task map is declared');
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack ?? error).slice(0, 4000);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await stop().catch(() => undefined);
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ passed: report.passed, agent: report.agent, report: path.join(evidence, 'report.json') }) + '\n');
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
}

// The scripted stand-in takes the protocol path a model takes, through the same grant.
async function standInPropose(agent, call) {
  const plants = (await call('observation.snapshot')).resources.find(r => r.path === 'plants.csv');
  const script = [
    'args <- commandArgs(trailingOnly = TRUE); out <- args[1]; d <- read.csv(args[2])',
    's <- do.call(rbind, lapply(split(d$weight, d$group), function(w) data.frame(n = length(w), mean = mean(w), sd = sd(w))))',
    's <- data.frame(group = rownames(s), s, row.names = NULL); write.csv(s, file.path(out, "summary.csv"), row.names = FALSE)',
    'png(file.path(out, "boxplot.png"), width = 640, height = 420); boxplot(weight ~ group, data = d); invisible(dev.off())',
    'files <- c("summary.csv", "boxplot.png")',
    'entries <- vapply(files, function(f) { p <- file.path(out, f); sprintf(\'{"path":"%s","bytes":%d,"sha256":"%s"}\', f, as.integer(file.size(p)), unname(tools::sha256sum(p))) }, "")',
    'writeLines(sprintf(\'{"schemaVersion":1,"complete":true,"artifacts":[%s]}\', paste(entries, collapse = ",")), file.path(dirname(out), "inventory.json"))', ''
  ].join('\n');
  let doc = await agent('document.open', { path: 'analysis.R' });
  doc = await agent('document.edit', { documentId: doc.id, expectedVersion: doc.version, edits: [{ from: 0, to: doc.content.length, insert: script }], undoGroup: 'write' });
  doc = await agent('document.save', { documentId: doc.id, expectedVersion: doc.version, expectedDiskDigest: doc.diskDigest ?? null });
  const columns = [['group', 'string'], ['n', 'number'], ['mean', 'number'], ['sd', 'number']].map(([name, type]) => ({ name, type, nullValues: [] }));
  const input = { script: { kind: 'disk', path: 'analysis.R', digest: doc.diskDigest }, args: [{ resource: { id: plants.id, version: plants.version } }], requirements: [], completion: 'inventory.json',
    artifacts: [{ path: 'summary.csv', kind: 'table', format: { encoding: 'csv', columns, key: { column: 'group', namespace: 'plant-groups' } } }, { path: 'boxplot.png', kind: 'media', format: { mimeType: 'image/png' } }] };
  await agent('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'propose-analysis', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['code', 'run'], presentation: { mode: 'split', axis: 'horizontal', weights: [55, 45] } },
    { id: 'code', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'analysis.R' }, bindings: { document: { kind: 'live-document', documentId: doc.id } } },
    { id: 'run', kind: 'view', component: 'rho.action', version: '1', props: { title: 'Compare plant weight by group', action: 'r.execute', actionVersion: '0.2.0', operationId: 'plants-summary', input }, bindings: {} }] }] });
}
async function standInAnswer(agent, request) {
  await agent('context.read', { contextId: request.match(/read context (\S+?)\./)[1] });
  const [thread] = await agent('annotation.list');
  const answer = await agent('document.open', { path: 'answer.md' });
  const written = await agent('document.edit', { documentId: answer.id, expectedVersion: answer.version, edits: [{ from: 0, to: 0, insert: 'trt2 against ctrl: a Welch t-test on the 10 + 10 plants gives p = 0.048.' }], undoGroup: 'answer' });
  await agent('annotation.reply', { annotationId: thread.annotationId, expectedVersion: thread.version ?? 1, changeId: 'answer', replyTo: thread.messages[0].id, draft: { documentId: answer.id, version: written.version }, resources: [] });
}
