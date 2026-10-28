// Exercise the rebuilt application with owner-backed resources, a real R run and real Chrome.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { RhoService, RhoClient, native } from './support.mjs';
import { inspectResponsive, inspectPage } from './browser-checks.mjs';
const evidence = path.resolve(process.env.RHO_FRONTEND_EVIDENCE ?? 'work/frontend-reset/browser');
await fs.mkdir(evidence, { recursive: true });
const root = await fs.mkdtemp('/tmp/rho-front-');
const report = { passed: false, checks: [], responsive: [] };
let service, browser, page;
const passed = name => { report.checks.push(name); process.stdout.write('ok · ' + name + '\n'); };
async function poll(read, condition, label) {
  for (let i = 0; i < 120; i++) { const value = await read(); if (condition(value)) return value; await new Promise(r => setTimeout(r, 200)); }
  throw new Error('Timed out: ' + label);
}
try {
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), ...native }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await admin.call('project.create', { name: 'Air quality study' });
  const call = (method, args = {}) => admin.call(method, { projectId: project.id, ...args });
  const script = `out <- commandArgs(trailingOnly=TRUE)[1]
d <- na.omit(airquality)
fit <- lm(Ozone ~ Temp + Wind, d)
result <- data.frame(term=names(coef(fit)), estimate=unname(coef(fit)))
write.csv(result, file.path(out,"coefficients.csv"), row.names=FALSE)
png(file.path(out,"ozone.png"), width=900, height=600, res=120)
par(mar=c(4.5,4.5,2,1), col.axis="#596560", col.lab="#202927")
plot(d$Temp,d$Ozone,pch=19,col="#328361",xlab="Temperature (°F)",ylab="Ozone (ppb)")
dev.off()
files <- c("coefficients.csv", "ozone.png")
items <- lapply(files, function(f) list(path=f, bytes=unname(file.size(file.path(out,f))), sha256=digest::digest(file.path(out,f),algo="sha256",file=TRUE)))
writeLines(jsonlite::toJSON(list(schemaVersion=1L,complete=TRUE,artifacts=items),auto_unbox=TRUE),file.path(dirname(out),"inventory.json"))
`;
  await fs.writeFile(path.join(project.root, 'analysis.R'), script);
  await fs.writeFile(path.join(project.root, 'research-notes.md'), '# Air quality\n\nExplore how temperature and wind relate to ozone.\n\n研究笔记 🧬\n');
  await fs.mkdir(path.join(project.root, 'data'));
  await fs.writeFile(path.join(project.root, 'data', 'README.md'), '# Source data\nR datasets::airquality\n');
  const doc = await call('document.open', { path: 'analysis.R' });
  const notes = await call('document.open', { path: 'research-notes.md' });
  const input = { script: { kind: 'disk', path: 'analysis.R', digest: doc.diskDigest }, args: [], requirements: [{ package: 'digest', source: 'cran' }, { package: 'jsonlite', source: 'cran' }], artifacts: [
    { path: 'coefficients.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'term', type: 'string', nullValues: [] }, { name: 'estimate', type: 'number', nullValues: [] }], key: { column: 'term', namespace: 'model-terms' } } },
    { path: 'ozone.png', kind: 'media', format: { mimeType: 'image/png' } }
  ], completion: 'inventory.json' };
  await call('action.submit', { operationId: 'air-quality-fit', action: 'r.execute', actionVersion: '0.2.0', input });
  const run = await poll(() => call('action.lookup', { operationId: 'air-quality-fit' }), r => !['active', 'unobserved'].includes(r.execution), 'real R run');
  assert.equal(run.execution, 'completed');
  const checked = await call('artifact.check', { operationId: 'air-quality-fit' });
  const table = checked.resources.find(r => r.kind === 'table'), figure = checked.resources.find(r => r.path.endsWith('ozone.png'));
  assert.ok(table && figure);
  await call('task.map.declare', { expectedVersion: 0, changeId: 'analysis-intent', question: 'How do wind and temperature relate to ozone?', vocabulary: { kinds: { check: { label: 'Check' } }, states: { open: { label: 'Needs interpretation', role: 'working' } } }, items: [{ id: 'model', kind: 'check', state: 'open', title: 'Inspect the fitted coefficients', artifact: { id: table.id, version: table.version } }], next: [] });
  const editor = (id, documentId, title) => ({ id, kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title }, bindings: { document: { kind: 'live-document', documentId } } });
  await call('composition.apply', { compositionId: 'Analysis', expectedVersion: 0, changeId: 'initial-views', operations: [{ op: 'replace', rootId: 'root', nodes: [
    { id: 'root', kind: 'group', children: ['table','plot','code','notes'] },
    { id: 'table', kind: 'view', component: 'rho.table', version: '0.2.0', props: { title: 'Coefficients' }, bindings: { data: { id: table.id, version: table.version } } },
    { id: 'plot', kind: 'view', component: 'rho.media', version: '0.2.0', props: { title: 'Ozone & temperature' }, bindings: { data: { id: figure.id, version: figure.version } } },
    editor('code',doc.id,'analysis.R'), editor('notes',notes.id,'Research notes')
  ] }] });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read','clipboard-write'] });
  page = await context.newPage(); page.setDefaultTimeout(15000); report.browser = browser.version();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Opening this url on this machine is the access: no gate, no code, nothing stored in the tab.
  await page.goto(service.url);
  await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  assert.equal(await page.getByText('Open Rho from your Agent').count(), 0);
  assert.deepEqual(await page.evaluate(() => [Object.keys(sessionStorage), location.hash]), [[], '']);
  passed('the service url opens the application directly, with no link and nothing stored');
  // A link that cannot be used leaves the page working as this machine and says so.
  const staleTab = await context.newPage();
  await staleTab.goto(service.url + '/#pair=' + 'x'.repeat(32));
  await staleTab.getByRole('heading', { name: 'Your projects' }).waitFor();
  assert.match(await staleTab.locator('.notice-bar').innerText(), /could not be used/);
  await staleTab.close();
  passed('a link that cannot be used falls back to this machine instead of closing the page');
  const pairing = await admin.call('session.browser.pair', {});
  await page.goto(service.url + '/#pair=' + pairing.code);
  await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  const inspect = name => inspectResponsive(page, { name, evidence, report });
  await inspect('home');
  await page.getByRole('textbox', { name: 'Find a project' }).fill('missing');
  await page.getByText('No projects match').waitFor();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.locator('.project-row').filter({ hasText: project.name }).click();
  await page.locator('.workspace-link').waitFor();
  await inspect('overview');
  passed('project search, empty search and project overview use actual project records');
  const navigate = async name => {
    if (!await page.locator('.project-nav').isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.locator('.project-nav, dialog.drawer').getByRole('button', { name, exact: true }).click();
  };
  await navigate('Files');
  await page.getByRole('button', { name: 'analysis.R', exact: true }).last().waitFor();
  await inspect('files');
  await page.getByRole('textbox', { name: 'Filter files' }).fill('not-here');
  await page.getByText('No files match your search.').waitFor();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'data', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Up one folder' }).click();
  await page.getByRole('button', { name: 'analysis.R', exact: true }).last().waitFor();
  passed('files can be searched, nested folders traversed and the parent restored');
  await navigate('Overview');
  await page.locator('.workspace-link').click();
  await page.getByRole('tab', { name: 'Coefficients', exact: true }).click();
  await page.locator('.ag-row[row-index="0"] [col-id="estimate"]').waitFor();
  await inspect('table');
  await page.getByRole('tab', { name: 'analysis.R', exact: true }).click();
  const editorContent = page.locator('[data-owner-view="code"] .cm-content');
  await editorContent.click(); await page.keyboard.press('Meta+End'); await page.keyboard.insertText('\n# 人类编辑 🧬\n');
  const edited = await poll(() => call('document.read', { documentId: doc.id }), d => d.content.includes('人类编辑'), 'owner receives edit');
  assert.equal(edited.dirty, true);
  await page.getByRole('tab', { name: 'Coefficients', exact: true }).click();
  await page.getByRole('tab', { name: 'analysis.R', exact: true }).click();
  assert.match(await editorContent.innerText(), /人类编辑/);
  await editorContent.click(); await page.keyboard.press('Meta+z');
  await poll(() => call('document.read', { documentId: doc.id }), d => !d.content.includes('人类编辑'), 'undo retained after tab switch');
  passed('Unicode editing and owner undo survive tab switches');
  await page.getByRole('tab', { name: 'Ozone & temperature', exact: true }).click();
  await page.locator('[data-owner-view="plot"] img').waitFor();
  await inspect('figure');
  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  const output = page.getByRole('region', { name: 'Outputs of air-quality-fit' }).getByRole('button', { name: 'coefficients.csv', exact: true });
  await output.click();
  await page.locator('.ag-row[row-index="0"] [col-id="estimate"]').waitFor();
  assert.match(await page.locator('.shell-source:visible').textContent(), /air-quality-fit/);
  // On this machine the panel holds conversations started in Rho; nothing is sent before Start.
  const message = page.getByRole('textbox', { name: 'Start a conversation' });
  await message.fill('Check the effect of Wind. 检查风速。');
  await page.screenshot({ path: path.join(evidence, 'agent-1440.png') });
  await page.getByRole('button', { name: 'Close Agent' }).click();
  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  assert.match(await message.inputValue(), /检查风速/);
  assert.equal(await page.locator('.conversation-list').count(), 0);
  await page.getByRole('button', { name: 'Close Agent' }).click();
  passed('an unsent message to Claude Code survives closing the Agent panel and starts nothing');
  // A tab opened from a link hands a request to an external Agent through the clipboard.
  const linkTab = await context.newPage(); linkTab.setDefaultTimeout(15000);
  await linkTab.goto(service.url + '/#pair=' + (await admin.call('session.browser.pair', {})).code);
  await linkTab.locator('.project-row').filter({ hasText: project.name }).click();
  await linkTab.getByRole('button', { name: 'Agent panel', exact: true }).click();
  await linkTab.getByRole('textbox', { name: 'Work with your Agent' }).fill('Check the effect of Wind. 检查风速。');
  await linkTab.getByRole('button', { name: 'Copy request', exact: true }).click();
  assert.match(await linkTab.evaluate(() => navigator.clipboard.readText()), /Check the effect of Wind/);
  await linkTab.getByText('Copied. Paste it into your Agent to send.').waitFor();
  await linkTab.screenshot({ path: path.join(evidence, 'agent-link-1440.png') });
  await linkTab.getByRole('button', { name: 'Close Agent' }).click();
  await linkTab.getByRole('button', { name: 'Agent panel', exact: true }).click();
  assert.match(await linkTab.getByRole('textbox', { name: 'Work with your Agent' }).inputValue(), /检查风速/);
  await linkTab.close();
  passed('a link tab keeps its request draft across closing the panel; the clipboard is explicitly a handoff');
  await page.getByRole('tab', { name: 'analysis.R', exact: true }).click();
  const groupCount = await page.locator('.shell-group').count();
  await page.getByText('Arrange views', { exact: true }).click();
  await page.locator('.view-menu').getByRole('button', { name: 'Split right', exact: true }).click();
  await page.locator('.shell-split[data-axis="horizontal"]').waitFor();
  await page.screenshot({ path: path.join(evidence, 'split-1440.png') });
  await page.reload();
  await page.locator('.shell-split[data-axis="horizontal"]').waitFor();
  assert.match(await editorContent.innerText(), /Ozone/);
  passed('visible Arrange views menu creates a real split and reload restores it');
  // The same layout by dragging: a tab dropped on another group's tabs joins them and its
  // emptied pane closes; dropped near a group's edge it opens a pane on that side.
  const dragTab = async (name, target, x, y) => {
    const from = await page.getByRole('tab', { name, exact: true }).boundingBox(), box = await target.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 3 });
    await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 10 });
    await page.mouse.up();
  };
  await poll(() => page.locator('.shell-group').count(), n => n === groupCount + 1, 'the split pane is drawn');
  await dragTab('analysis.R', page.locator('.shell-group').first().locator('.shell-tabs'), 0.98, 0.5);
  await poll(() => page.locator('.shell-group').count(), n => n === groupCount, 'the dragged tab joins the first group and its pane closes');
  await dragTab('analysis.R', page.locator('.shell-group').first().locator('.shell-body'), 0.5, 0.93);
  await page.locator('.shell-split[data-axis="vertical"]').waitFor();
  assert.equal(await page.locator('.shell-group').count(), groupCount + 1);
  await page.screenshot({ path: path.join(evidence, 'dragged-1440.png') });
  // Each drop is the saved layout itself, not a local arrangement.
  const saved = await call('composition.read', { compositionId: 'Analysis' }), top = saved.nodes.find(n => n.id === saved.rootId);
  assert.equal(top.presentation?.axis, 'vertical');
  assert.deepEqual(top.children.map(id => saved.nodes.find(n => n.id === id).children), [['table', 'plot', 'notes'], ['code']]);
  passed('dragging a tab joins another group or opens a pane at a side, as the saved layout');
  // The Agent panel's edge widens it; this browser keeps the width.
  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  const side = page.locator('aside[aria-label="Agent panel"]'), narrowWidth = (await side.boundingBox()).width;
  const edge = await page.getByRole('separator', { name: 'Resize Agent panel' }).boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200); await page.mouse.down();
  await page.mouse.move(edge.x - 140, edge.y + 200, { steps: 8 }); await page.mouse.up();
  const wideWidth = (await side.boundingBox()).width;
  assert.ok(wideWidth > narrowWidth + 100, `the panel widened (${narrowWidth} → ${wideWidth})`);
  await page.reload();
  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  assert.equal(Math.round((await side.boundingBox()).width), Math.round(wideWidth));
  await page.getByRole('button', { name: 'Close Agent' }).click();
  passed('the Agent panel widens from its edge and keeps that width after reload');
  await navigate('Agent');
  await page.locator('.activity-row').filter({ hasText: 'air-quality-fit' }).click();
  await page.getByRole('dialog', { name: 'air-quality-fit' }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'run-1440.png') });
  await page.keyboard.press('Escape');
  await inspect('activity');
  await navigate('Project settings'); await inspect('settings');
  // Inject failures at the browser boundary; each retry must repeat its own operation.
  let sourceAttempts = 0, healthAttempts = 0;
  await page.route('**/api/v2/project.source.add', async route => { sourceAttempts++; await route.fulfill({ json: { ok: false, error: { kind: 'internal', message: 'Folder chooser unavailable.' } } }); });
  await page.route('**/api/v2/project.doctor', async route => { healthAttempts++; await route.fulfill({ json: { ok: false, error: { kind: 'internal', message: 'Project health unavailable.' } } }); });
  await page.getByRole('button', { name: 'Add folder…', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Folder chooser unavailable.' }).getByRole('button', { name: 'Try again' }).click();
  await poll(async () => sourceAttempts, n => n === 2, 'retry the source-folder operation');
  assert.equal(healthAttempts, 0);
  await page.getByRole('button', { name: 'Check project', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Project health unavailable.' }).getByRole('button', { name: 'Try again' }).click();
  await poll(async () => healthAttempts, n => n === 2, 'retry the health operation');
  assert.equal(sourceAttempts, 2);
  await page.getByText('Project health unavailable.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'settings-failures-1440.png') });
  await page.unroute('**/api/v2/project.source.add'); await page.unroute('**/api/v2/project.doctor');
  passed('source-folder and health failures retry their own operation');
  await navigate('Plugins'); await inspect('plugins');
  await page.locator('.plugin-card').filter({ hasText: 'Documents' }).click();
  await page.locator('.plugin-detail h1').waitFor(); await inspect('plugin-detail');
  passed('activity, run inspection, settings and plugin details are reachable');
  await page.keyboard.press('Meta+k'); await page.getByRole('combobox', { name: 'Command' }).fill('Overview'); await page.keyboard.press('Enter');
  await page.locator('#overview-title').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('dialog', { name: 'Navigation', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'navigation-390.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Navigation', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  await page.screenshot({ path: path.join(evidence, 'agent-390.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().setOffline(true); await page.reload().catch(() => {});
  await page.context().setOffline(false); await page.reload();
  await page.locator('#overview-title').waitFor();
  passed('command keyboard navigation, mobile dialogs and page recovery work');
  const bounds = await inspectPage(page); assert.equal(bounds.overflow, false);
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (e) {
  report.error = e.stack ?? String(e);
  if (page) { await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  throw e;
} finally {
  if (browser) await browser.close();
  if (service) await service.close();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, { recursive: true, force: true });
}
