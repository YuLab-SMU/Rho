// Graph acceptance: a controlled ACP peer does two messages of R work in a disposable project
// through the real service and Chrome; it runs the real Rscript, so the outputs are real. No
// model credentials are used. It checks that the Graph stays on screen while the Agent works and
// shows where it is, that each message is a row from what it read to what changed while its
// command ran, that a later row refers to an earlier output, that cards preview tables and
// figures, that choosing a node shows its path and the file in its own view, that a replay
// narrates the work, and that the files the Agent touched open in the one shared workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

const rscript = process.env.RHO_RSCRIPT ?? 'Rscript';
const evidence = path.resolve(process.env.RHO_GRAPH_EVIDENCE ?? 'work/graph-acceptance/' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.realpath(await fs.mkdtemp('/tmp/rho-graph-acceptance-'));
const report = { passed: false, root, checks: [], screenshots: [], browserErrors: [] };
const passed = name => { report.checks.push(name); process.stdout.write('ok · ' + name + '\n'); };
let service, browser, page;
const peer = `import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const at=p=>path.join(process.cwd(),p);
const update=update=>out({method:'session/update',params:{sessionId:'g',update}});
const tool=async(id,name,kind,input,ms,during)=>{
 update({sessionUpdate:'tool_call',toolCallId:id,title:name,name,kind,status:'in_progress',rawInput:input,...(input.file_path?{locations:[{path:input.file_path}]}:{})});
 await sleep(ms); if(during)during(); await sleep(400);
 update({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed'});
};
const R=file=>execFileSync(${JSON.stringify(rscript)},[file],{cwd:process.cwd()});
const say=(id,text)=>update({sessionUpdate:'agent_message_chunk',messageId:id,content:{type:'text',text}});
createInterface({input:process.stdin}).on('line',async line=>{
 const r=JSON.parse(line),p=r.params,reply=result=>out({id:r.id,result});
 if(!r.method)return;
 if(r.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(r.method==='session/new')return reply({sessionId:'g'});
 if(r.method==='session/load')return reply({});
 if(r.method!=='session/prompt')return;
 if(p.prompt[0].text.includes('Plot')){
  await tool('p1','Read','read',{file_path:at('results/monthly_ozone.csv')},900);
  await tool('p2','Write','edit',{file_path:at('plot.R')},900,()=>fs.writeFileSync(at('plot.R'),'m <- read.csv("results/monthly_ozone.csv")\\npng("results/ozone_by_month.png", width = 640, height = 400)\\nbarplot(m$mean_ozone, names.arg = month.abb[m$Month], col = "#2f7a5b", border = NA, ylab = "Mean ozone (ppb)")\\ninvisible(dev.off())\\n'));
  await tool('p3','Bash','execute',{command:'Rscript plot.R'},700,()=>R('plot.R'));
  await tool('p4','Edit','edit',{file_path:at('notes.md')},800,()=>fs.appendFileSync(at('notes.md'),'\\nOzone peaks in July and August.\\n'));
  say('b','Drew mean ozone by month and noted the July–August peak.');
  await sleep(1500);
  return reply({stopReason:'end_turn'});
 }
 await tool('a1','Read','read',{file_path:at('data/airquality.csv')},2500);
 await tool('a2','Edit','edit',{file_path:at('analysis.R')},900,()=>fs.writeFileSync(at('analysis.R'),'air <- read.csv("data/airquality.csv")\\nm <- aggregate(Ozone ~ Month, data = air, FUN = mean)\\nnames(m)[2] <- "mean_ozone"\\nm$mean_ozone <- round(m$mean_ozone, 2)\\ndir.create("results", showWarnings = FALSE)\\nwrite.csv(m, "results/monthly_ozone.csv", row.names = FALSE)\\n'));
 await tool('a3','Bash','execute',{command:'Rscript analysis.R'},800,()=>R('analysis.R'));
 say('a','Mean ozone rises from 23.6 ppb in May to 60 in August, then falls in September.');
 await sleep(1500);
 reply({stopReason:'end_turn'});
});
`;
async function until(read, accept, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read().catch(error => ({ error: error.message }));
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  // Cards are named by what they say, which is what a failure needs.
  const shown = Array.isArray(value) && value.every(v => v?.label) ? value.map(v => v.label) : value;
  throw new Error(label + ' did not happen. Last: ' + JSON.stringify(shown).slice(0, 1600));
}
const shot = async name => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(path.basename(file)); };
const cards = () => page.evaluate(() => [...document.querySelectorAll('.graph-node')].map(n => ({ id: n.dataset.node, label: n.getAttribute('aria-label'), later: n.hasAttribute('data-later'), dimmed: n.hasAttribute('data-dimmed'), flag: n.querySelector('.graph-flag')?.textContent ?? null })));
const lines = () => page.evaluate(() => [...document.querySelectorAll('.graph-edge')].map(g => g.getAttribute('class').replace('graph-edge ', '') + ' · ' + (g.querySelector('text')?.textContent ?? '')));
try {
  await fs.writeFile(path.join(root, 'peer.mjs'), peer);
  const project = path.join(root, 'ozone');
  await fs.mkdir(path.join(project, 'data'), { recursive: true });
  execFileSync(rscript, ['-e', `write.csv(airquality, "${project}/data/airquality.csv", row.names = FALSE)`]);
  await fs.writeFile(path.join(project, 'analysis.R'), '# Monthly ozone\n');
  await fs.writeFile(path.join(project, 'notes.md'), '# Notes\n\nHow does ozone change over the summer? 臭氧\n');
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: path.join(root, 'absent-core'), rscript,
    claudeAcp: { command: { file: process.execPath, args: [path.join(root, 'peer.mjs')] } }, conversations: { stopGraceMs: 1000 } }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const opened = await admin.call('project.open', { path: 'ozone' });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.goto(service.url);
  await page.locator('.project-row').first().click();
  const nav = page.locator('.project-nav');
  await nav.getByRole('button', { name: 'Graph', exact: true }).click();
  await page.getByRole('heading', { name: 'Nothing to draw yet' }).waitFor();
  await shot('01-empty');
  passed('the Graph says what it will draw before anything has been asked');

  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  await page.getByRole('textbox', { name: 'Start a conversation' }).fill('How does ozone change by month?');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const live = await until(cards, c => c.some(card => card.flag === 'Claude Code · Reading' && /airquality\.csv/.test(card.label)), 'the Agent shown reading on its card');
  await page.locator('.graph-tools .follow-toggle[aria-pressed=true]').waitFor();
  assert.ok(await page.locator('.graph-page').isVisible(), 'the Graph stays on screen while the Agent works');
  assert.equal(await page.locator('.graph-now').textContent(), 'Live');
  await shot('02-live');
  passed('sending from the Graph keeps it on screen and follows: the card the Agent is reading carries its flag');
  void live;

  await until(() => page.locator('.graph-now').textContent(), t => t === 'Now', 'the first message ending', 40000);
  await page.getByRole('textbox', { name: /Message|Reply/ }).fill('Plot the monthly means and note the finding.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => page.locator('.graph-now').textContent(), t => t === 'Live', 'the second message running');
  await until(() => page.locator('.graph-now').textContent(), t => t === 'Now', 'the second message ending', 40000);
  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  await page.getByRole('button', { name: 'Fit the graph' }).click();
  await page.waitForTimeout(600);
  const drawn = await until(cards, c => c.filter(card => !card.id.startsWith('p')).length === 10 && c.some(card => /ozone_by_month\.png/.test(card.label)), 'both messages drawn');
  const ids = drawn.map(c => c.id).sort();
  assert.deepEqual(ids, ['f:analysis.R', 'f:data/airquality.csv', 'f:notes.md', 'f:plot.R', 'f:results/monthly_ozone.csv', 'f:results/ozone_by_month.png', 'p1:f:results/monthly_ozone.csv', ...ids.filter(id => /^q:|^r:/.test(id))].sort());
  assert.equal(ids.filter(id => id.startsWith('q:')).length, 2);
  assert.equal(ids.filter(id => id.startsWith('r:')).length, 2);
  const drawnLines = await lines();
  assert.equal(drawnLines.filter(l => l === 'observed · changed while it ran').length, 2, 'both outputs changed while their command ran');
  assert.ok(drawnLines.includes('named · runs') && drawnLines.includes('reported · read') && drawnLines.includes('reported · edited'), drawnLines.join(', '));
  await page.locator('.graph-node[data-node="f:data/airquality.csv"] .graph-preview.table small').filter({ hasText: '153 rows × 6 columns' }).waitFor();
  await until(() => page.locator('.graph-node[data-node="f:results/ozone_by_month.png"] .graph-preview img').evaluate(img => img.naturalWidth), w => w === 640, 'the figure previewed on its card');
  await shot('03-two-rows');
  passed('each message is a row from what it read to what changed while its command ran; a later row refers to an earlier output; cards preview tables and figures');

  await page.locator('.graph-node[data-node="f:results/ozone_by_month.png"]').click();
  await page.locator('.graph-overlay').filter({ hasText: 'the path to and from ozone_by_month.png' }).waitFor();
  const focused = await cards();
  assert.deepEqual(focused.filter(c => c.dimmed).map(c => c.id), ['f:notes.md'], 'only what is off the figure\'s path steps back');
  const inspector = page.getByRole('complementary', { name: /Figure ozone_by_month\.png/ });
  await until(() => inspector.locator('[data-owner-view] img, img').first().evaluate(img => img.naturalWidth).catch(() => 0), w => w === 640, 'the figure in its own view');
  assert.match(await inspector.locator('.graph-relations li').first().textContent(), /Rscript plot\.R.*changed while it ran/);
  await shot('04-figure-path');
  // The keyboard walks the path: left from the figure is the command that ran while it changed.
  await page.locator('.graph-node[data-node="f:results/ozone_by_month.png"]').focus();
  await page.keyboard.press('ArrowLeft');
  assert.match(await page.evaluate(() => document.activeElement?.dataset.node ?? ''), /^r:/);
  passed('choosing a figure shows its path back to the data and the question, and the figure itself; arrows walk the path');

  // The reference in the second row goes to the output where the first row made it.
  await page.keyboard.press('Escape');
  // Walking centred the command; fitting brings the second row's reference back in view.
  await page.getByRole('button', { name: 'Fit the graph' }).click();
  await page.waitForTimeout(500);
  await page.locator('.graph-ref').click();
  await page.getByRole('complementary', { name: /Result monthly_ozone\.csv/ }).waitFor();
  await page.locator('.graph-inspector .ag-row[row-index="0"]').first().waitFor();
  passed('a reference goes to the output in the row that made it, shown in its table');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'Play the work from the start' }).click();
  const caption = await until(() => page.locator('.graph-caption').textContent(), t => /changed while Rscript analysis\.R ran/.test(t ?? ''), 'the replay narrating the first output', 20000);
  assert.ok((await cards()).some(c => c.later), 'later work is drawn faintly during the replay');
  await shot('05-replay');
  await until(() => page.locator('.graph-now').getAttribute('aria-pressed'), v => v === 'true', 'the replay returning to now', 30000);
  passed('Play narrates the work in order and returns to now: ' + caption.replace(/^\d\d:\d\d:\d\d/, '').trim());

  await page.locator('.graph-node[data-node="f:results/monthly_ozone.csv"]').click();
  await page.getByRole('button', { name: 'Open in workspace' }).click();
  await page.locator('.location-name').filter({ hasText: 'Workspace' }).waitFor();
  await page.getByRole('tab', { name: /monthly_ozone\.csv/, selected: true }).waitFor();
  const snapshot = await admin.call('observation.snapshot', { projectId: opened.id });
  assert.deepEqual(snapshot.compositions.map(c => c.compositionId), ['workspace']);
  const titles = (await admin.call('composition.read', { projectId: opened.id, compositionId: 'workspace' })).views.map(v => v.props.title).sort();
  assert.deepEqual(titles, ['airquality.csv', 'analysis.R', 'monthly_ozone.csv', 'notes.md', 'ozone_by_month.png', 'plot.R']);
  await shot('06-workspace');
  passed('while the Graph followed, the Agent\'s files opened in the one shared workspace; a node opens there');

  await nav.getByRole('button', { name: 'Graph', exact: true }).click();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width);
    await shot('07-graph-' + width);
  }
  assert.deepEqual(report.browserErrors, []);
  passed('no horizontal overflow at 1024 and 390, and no page errors');
  report.passed = true;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 1));
  await browser?.close();
  await service?.close().catch(() => {});
}
