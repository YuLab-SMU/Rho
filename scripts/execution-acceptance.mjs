// A deterministic consumer of the real stdio MCP boundary, real R execution and
// real browser renderer. This proves the route, not model reasoning quality.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectMcp, callOperation, mcpEnvelope, mcpToolNames } from './mcp-consumer.mjs';

const packageRoot = path.resolve(process.env.RHO_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
const { RhoService } = await import(pathToFileURL(path.join(packageRoot, 'dist/server.js')).href);
const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')).href);
const selected = process.env.RHO_UI_PLAYWRIGHT_MODULE;
const { chromium } = await import(selected ? (selected.startsWith('file:') ? selected : pathToFileURL(selected).href) : import.meta.resolve('@playwright/test'));
const core = process.env.RHO_CORE_BINARY, rscript = process.env.RHO_RSCRIPT;
if (!core || !rscript) { console.error('Execution acceptance needs RHO_CORE_BINARY and RHO_RSCRIPT.'); process.exit(2); }
const evidence = path.resolve(process.env.RHO_EXECUTION_EVIDENCE ?? 'work/execution-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-exec-'));
const project = path.join(root, 'work'); await fs.mkdir(project);
const counts = { hostStarts: 0, nativeDispatches: 0, modelCalls: 0 };
const report = { scenario: 'progressive-mcp-execution-browser', passed: false, counts, checks: [], widths: [], toolReplies: [] };
const check = name => { report.checks.push(name); process.stdout.write('- ' + name + '\n'); };
let service, mcp, browser;
try {
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: core, rscript, resources: { maxReadBytes: 4096 } }).start();
  const start = service.bridge.ensureOwnedHost.bind(service.bridge), native = service.bridge.call.bind(service.bridge);
  service.bridge.ensureOwnedHost = (...args) => { counts.hostStarts++; return start(...args); };
  service.bridge.call = (...args) => { if (args[1] === 'submit') counts.nativeDispatches++; return native(...args); };
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });
  const script = [
    'out <- commandArgs(trailingOnly = TRUE)[1]',
    'png(file.path(out, "cars.png"), width = 640, height = 420)',
    'plot(datasets::cars$speed, datasets::cars$dist, pch = 19, col = "steelblue")',
    'dev.off()',
    'produced <- file.path(out, "cars.png")',
    'manifest <- list(schemaVersion = 1L, complete = TRUE, artifacts = list(list(',
    '  path = "cars.png", bytes = unname(file.size(produced)),',
    '  sha256 = digest::digest(produced, algo = "sha256", file = TRUE))))',
    'writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE), file.path(dirname(out), "inventory.json"))',
    'cat("rows:", nrow(datasets::cars), "\\n")', ''
  ].join('\n');
  await fs.writeFile(path.join(project, 'plot.R'), script);
  const methods = ['document.open', 'document.edit', 'document.save', 'action.submit', 'action.lookup', 'artifact.check', 'composition.apply'];
  const grant = await operator.call('session.grant', { projectId: p.id, externalSessionId: 'execution-acceptance', methods });
  mcp = await connectMcp(packageRoot, grant.connectionFile, (input, reply) => {
    const bytes = Buffer.byteLength(reply.content[0].text);
    assert.ok(bytes <= 65536, input.name + ' exceeds the requested context budget');
    report.toolReplies.push({ tool: input.name, bytes });
  });
  assert.deepEqual((await mcp.listTools()).tools.map(t => t.name), mcpToolNames);
  const index = await mcpEnvelope(mcp, 'rho_index');
  assert.ok(index.value.groups.length > 0); assert.deepEqual(index.value.entries, []);
  const call = async (method, body) => {
    const result = await callOperation(mcp, method, body);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  const doc = await call('document.open', { path: 'plot.R' });
  const edited = await call('document.edit', { documentId: doc.id, expectedVersion: doc.version, expectedRevision: doc.revision, changeId: 'edit-1', undoGroup: 'acceptance', edits: [{ from: 0, to: 0, insert: '# Saved through progressive MCP · 中文 🧬\n' }] });
  const saved = await call('document.save', { documentId: doc.id, expectedVersion: edited.version, expectedRevision: edited.revision, expectedDiskDigest: edited.diskDigest, changeId: 'save-1' });
  assert.equal(saved.dirty, false);
  check('four-tool discovery resolves, edits and conditionally saves through stdio MCP');
  const operationId = 'acceptance-run-1';
  const submitted = await call('action.submit', { operationId, action: 'r.execute', actionVersion: '0.2.0', input: {
    script: { kind: 'disk', path: 'plot.R', digest: saved.diskDigest }, args: [], requirements: [{ package: 'digest', source: 'cran' }, { package: 'jsonlite', source: 'cran' }],
    artifacts: [{ path: 'cars.png', kind: 'media', format: { mimeType: 'image/png' } }], completion: 'inventory.json'
  } });
  assert.ok(['active', 'unobserved'].includes(submitted.execution));
  let run;
  for (let i = 0; i < 120; i++) {
    run = await call('action.lookup', { operationId });
    if (!['active', 'unobserved'].includes(run.execution)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(run.execution, 'completed', JSON.stringify(run));
  check('the original request completes through observation, with no resubmission');
  const facts = await call('artifact.check', { operationId });
  assert.equal(facts.integrity.state, 'verified', JSON.stringify(facts.integrity));
  const resource = facts.resources.find(r => r.path.endsWith('cars.png'));
  assert.ok(resource?.path.startsWith('.rho/')); assert.equal(resource.kind, 'media');
  const ref = { id: resource.id, version: resource.version };
  // The owner supplies this reference. Manual internal-path registration is still refused.
  await assert.rejects(operator.call('resource.register', { projectId: p.id, expectedDigest: resource.version, declaration: { path: resource.path, kind: 'media', format: { mimeType: 'image/png' } } }), e => e.error.kind === 'scope');
  const composition = await call('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'show-produced', operations: [{ op: 'replace', rootId: 'root', nodes: [
    { id: 'root', kind: 'group', children: ['figure'] },
    { id: 'figure', kind: 'view', component: 'rho.media', version: '0.2.0', props: { title: 'cars.png' }, bindings: { data: ref } }
  ] }] });
  assert.equal(composition.availability.figure.state, 'entry-installed');
  assert.equal(composition.availability.figure.visibility, 'unobserved');
  check('artifact.check returns a verified owner-state reference that binds directly');

  const pages = [], failures = [], errors = [];
  browser = await chromium.launch(process.env.RHO_UI_CHROME ? { executablePath: process.env.RHO_UI_CHROME } : {});
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.location().url.endsWith('/favicon.ico')) errors.push(m.text()); });
  page.on('request', req => { if (req.url().endsWith('/resource.read')) pages.push(req.postDataJSON()); });
  page.on('response', res => { if (res.status() >= 400 && new URL(res.url()).pathname !== '/favicon.ico') failures.push({ status: res.status(), path: new URL(res.url()).pathname }); });
  const pair = await operator.call('session.browser.pair', {});
  await page.goto(service.url + '/#pair=' + pair.code);
  await page.locator('.project-row').first().click();
  // The project opens on its overview; the Agent's layout is one choice away in the sidebar.
  await page.getByRole('complementary', { name: 'Project navigation', exact: true }).getByRole('button', { name: /^workspace/ }).click();
  const visible = async () => {
    // The workspace shell keeps one stage at every width; the figure must decode inside it.
    const selector = '.shell-stage';
    const surface = page.locator(selector);
    await surface.waitFor({ state: 'visible' });
    const image = surface.getByRole('img', { name: 'cars.png', exact: true });
    await image.waitFor();
    await page.waitForFunction(selector => { const i = document.querySelector(selector + ' img[alt="cars.png"]'); return i?.complete && i.naturalWidth === 640 && i.naturalHeight === 420; }, selector);
    assert.equal(await image.isVisible(), true);
  };
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 }); await visible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(evidence, 'figure-' + width + '.png') }); report.widths.push(width);
  }
  assert.ok(pages.length > 1); assert.ok(pages.every(p => p.maxBytes === 4096 && p.resource.version === ref.version));
  check('browser decodes the real 640×420 PNG with owner-sized 4096-byte pages at three widths');
  await page.reload(); await visible();
  assert.deepEqual(failures, []); assert.deepEqual(errors, []);
  assert.equal(counts.hostStarts, 1); assert.equal(counts.nativeDispatches, 1);
  check('refresh renders the same version without CSP errors or new native execution');
  report.resource = { version: resource.version, bytes: resource.bytes, kind: resource.kind };
  report.passed = true;
} catch (error) {
  report.failure = { message: error?.message, kind: error?.error?.kind }; throw error;
} finally {
  await browser?.close().catch(() => {}); await mcp?.close().catch(() => {}); await service?.close().catch(() => {});
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(JSON.stringify({ passed: report.passed, counts, checks: report.checks.length, report: path.join(evidence, 'report.json') }) + '\n');
}
