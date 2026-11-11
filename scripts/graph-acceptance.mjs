// Graph acceptance: a controlled ACP peer does two messages of R work in a disposable project
// through the real service and Chrome; it runs the real Rscript, so the outputs are real. No
// model credentials are used. It checks that the Graph stays on screen while the Agent works and
// shows where it is; that the work is one line that opens into its messages, a message into its
// activities and an activity into its recorded steps, with every line to a file moving to the
// node on screen; that a figure is drawn on its card and can be followed to the step that made
// it and that step's record; that a replay narrates the work; and that a file a person opens
// goes to the one shared workspace.
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
    if (process.env.RHO_GRAPH_DEBUG && Array.isArray(value)) { const seen = JSON.stringify(value.filter(v => v?.flag || v?.kind === 'line' || v?.kind === 'frame').map(v => [v.kind, v.flag, (v.label ?? '').slice(0, 50)])); if (seen !== until.last) { until.last = seen; process.stdout.write('  · ' + seen + '\n'); } }
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  // Cards are named by what they say, which is what a failure needs.
  const shown = Array.isArray(value) && value.every(v => v?.label) ? value.map(v => v.label) : value;
  throw new Error(label + ' did not happen. Last: ' + JSON.stringify(shown).slice(0, 1600));
}
const shot = async name => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(path.basename(file)); };
const cards = () => page.evaluate(() => [...document.querySelectorAll('.graph-node')].map(n => ({ id: n.dataset.node, kind: n.dataset.kind, label: n.getAttribute('aria-label') ?? n.querySelector('.lg-main')?.getAttribute('aria-label') ?? '', later: n.hasAttribute('data-later'), dimmed: n.hasAttribute('data-dimmed'), flag: n.querySelector('.graph-flag')?.textContent ?? null })));
// What each drawn link says, whether or not the zoom is near enough to print it on the line.
const lines = () => page.evaluate(() => [...document.querySelectorAll('.graph-edge')].map(g => g.dataset.kind + ' · ' + g.getAttribute('class').split(' ')[1] + ' · ' + (g.getAttribute('data-label') ?? '')));
const titles = kind => page.locator('.lg-row.level-' + kind + ' .lg-title').allTextContents();
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
  const nav = page.locator('.project-nav, .place-tabs');
  await nav.getByRole('button', { name: 'Graph', exact: true }).click();
  await page.getByRole('heading', { name: 'Nothing to draw yet' }).waitFor();
  await shot('01-empty');
  passed('the Graph says what it will draw before anything has been asked');

  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  await page.getByRole('textbox', { name: 'Start a conversation' }).fill('How does ozone change by month?');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  // Following opens the line and the message the Agent is in; its flag is on the activity under way.
  await until(cards, c => c.some(card => card.kind === 'activity' && card.flag === 'Claude Code · Reading' && /airquality\.csv/.test(card.label)), 'the Agent shown reading on its activity');
  await page.locator('.graph-tools .follow-toggle[aria-pressed=true]').waitFor();
  assert.ok(await page.locator('.graph-page').isVisible(), 'the Graph stays on screen while the Agent works');
  assert.equal(await page.locator('.graph-now').textContent(), 'Live');
  await shot('02-live');
  passed('sending from the Graph keeps it on screen and follows: the line and message open, and the activity the Agent is in carries its flag');

  await until(() => page.locator('.graph-now').textContent(), t => t === 'Now', 'the first message ending', 40000);
  await page.getByRole('textbox', { name: /Message|Reply/ }).fill('Plot the monthly means and note the finding.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => page.locator('.graph-now').textContent(), t => t === 'Live', 'the second message running');
  await until(() => page.locator('.graph-now').textContent(), t => t === 'Now', 'the second message ending', 40000);
  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();

  // The top level: one line of work standing for both messages and every step.
  await page.getByRole('button', { name: 'Close all' }).click();
  await until(cards, c => c.length === 1 && c[0].kind === 'line' && /^Line of work: .*2 messages, 9 steps, 5 files made$/.test(c[0].label), 'the work as one line of 2 messages, 9 steps and 5 files made');
  assert.match(await page.locator('.graph-heading p').textContent(), /1 line of work, 2 messages, 9 recorded steps/);
  await until(() => page.locator('.lg-line .graph-preview img').evaluate(img => img.naturalWidth).catch(() => 0), w => w === 640, 'the newest figure on the line\'s card');
  await shot('03-line');
  passed('closed, the project is one line of work that says what it stands for: 2 messages, 9 steps, 5 files made, with its newest figure');

  // Opened: what it used, the two messages, what they made. Each link is on the message.
  await page.locator('.lg-line .lg-toggle').click();
  await page.locator('.lg-frame').waitFor();
  assert.deepEqual(await page.locator('.lg-label').allTextContents(), ['Used', 'Work', 'Made']);
  assert.equal((await titles('ask')).length, 2);
  const open = await cards();
  assert.deepEqual(open.filter(c => c.kind === 'file').map(c => c.id.split('|')[1]).sort(), ['analysis.R', 'data/airquality.csv', 'notes.md', 'plot.R', 'results/monthly_ozone.csv', 'results/ozone_by_month.png']);
  assert.match(open.find(c => c.id.endsWith('|analysis.R')).label, /Was here before; changed/);
  let drawn = await lines();
  assert.equal(drawn.filter(l => /^makes · observed · .*changed/.test(l)).length, 2, 'both outputs changed while a command of their message ran: ' + drawn.join(', '));
  assert.ok(drawn.includes('uses · reported · read') && drawn.some(l => /^makes · reported · .*edited/.test(l)), drawn.join(', '));
  await until(() => page.locator('.lg-file[data-node$="|results/ozone_by_month.png"] .graph-preview img').evaluate(img => img.naturalWidth).catch(() => 0), w => w === 640, 'the figure drawn on its card');
  await shot('04-line-open');
  passed('opened, the line reads from what it used through its two messages to what they made; the figure is drawn on its card');

  // A message into its activities, an activity into its steps; the links move down with them.
  await page.locator('.lg-row.level-ask .lg-main').first().focus();
  await page.keyboard.press('ArrowRight');
  await until(() => titles('activity'), t => t.length === 2, 'the first message\'s activities');
  // One look at the data before the script belongs to writing the script.
  assert.deepEqual(await titles('activity'), ['Edited analysis.R and ran it once', 'Answered']);
  await page.locator('.lg-row.level-activity.kind-build .lg-toggle').click();
  await until(() => titles('step'), t => t.length === 3, 'the steps of the script\'s activity');
  assert.deepEqual(await titles('step'), ['Read data/airquality.csv', 'Edited analysis.R', 'Ran Rscript analysis.R']);
  drawn = await lines();
  const stepWires = await page.evaluate(() => [...document.querySelectorAll('.graph-edge')].filter(g => g.dataset.kind === 'makes').map(g => g.dataset.label));
  assert.ok(stepWires.includes('edited') && stepWires.includes('changed'), 'the step that edited the script and the step whose run changed the result each have their own line: ' + stepWires.join(', '));
  await shot('05-steps');
  passed('a message opens into its activities and an activity into its recorded steps, by key or pointer; each line to a file is on the step it was recorded on');

  // From a result to the step that made it, and that step's record.
  await page.locator('.lg-file[data-node$="|results/ozone_by_month.png"]').click();
  const inspector = page.getByRole('complementary', { name: /Figure ozone_by_month\.png/ });
  await until(() => inspector.locator('[data-owner-view] img, img').first().evaluate(img => img.naturalWidth).catch(() => 0), w => w === 640, 'the figure in its own view');
  const focused = await cards();
  assert.ok(focused.filter(c => !c.dimmed).some(c => c.kind === 'ask' && /Plot the monthly means/.test(c.label)) && focused.find(c => c.id.endsWith('|notes.md')).dimmed, 'only what touched the figure stays');
  await inspector.locator('.graph-history .graph-link', { hasText: 'Ran Rscript plot.R' }).click();
  const record = page.getByRole('complementary', { name: 'Step Ran a command' });
  assert.equal(await record.locator('.graph-command').textContent(), 'Rscript plot.R');
  assert.match(await record.locator('.graph-facts').first().textContent(), /Bash · .*\d\d:\d\d:\d\d/);
  assert.match(await record.locator('.lg-above').textContent(), /Plot the monthly means.*Wrote plot\.R and ran it once/);
  await until(() => page.locator('.lg-row.level-step[data-selected] .lg-title').textContent().catch(() => ''), t => t === 'Ran Rscript plot.R', 'the step shown in the graph, its message and activity opened');
  await shot('06-figure-to-step');
  passed('a figure leads to the step whose run changed it: the message and activity open, the step is chosen and its record shows the command as it ran');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'Fit the graph' }).click();
  await page.getByRole('button', { name: 'Play the work from the start' }).click();
  const caption = await until(() => page.locator('.graph-caption').textContent(), t => /changed while Rscript analysis\.R ran/.test(t ?? ''), 'the replay narrating the first output', 20000);
  assert.ok((await cards()).some(c => c.later), 'later work is drawn faintly during the replay');
  await shot('07-replay');
  await until(() => page.locator('.graph-now').getAttribute('aria-pressed'), v => v === 'true', 'the replay returning to now', 30000);
  passed('Play narrates the work in order and returns to now: ' + caption.replace(/^\d\d:\d\d:\d\d/, '').trim());

  await page.locator('.lg-file[data-node$="|results/monthly_ozone.csv"]').click();
  await page.getByRole('button', { name: /^Open (current file )?in workspace$/ }).click();
  await page.locator('.nav-workspace[aria-current=page]').filter({ hasText: 'Workspace' }).waitFor();
  await page.getByRole('tab', { name: /monthly_ozone\.csv/, selected: true }).waitFor();
  const snapshot = await admin.call('observation.snapshot', { projectId: opened.id });
  assert.deepEqual(snapshot.compositions.map(c => c.compositionId), ['workspace']);
  const viewTitles = (await admin.call('composition.read', { projectId: opened.id, compositionId: 'workspace' })).views.map(v => v.props.title).sort();
  // Following shows the Agent's work on the Graph and the answer board; it does not fill the
  // person's workspace. Only the node they opened is there.
  assert.deepEqual(viewTitles, ['monthly_ozone.csv']);
  await shot('08-workspace');
  passed('following does not open files behind the person; a file they open goes to the one shared workspace');

  await nav.getByRole('button', { name: 'Graph', exact: true }).click();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width);
    await shot('09-graph-' + width);
  }
  assert.deepEqual(report.browserErrors, []);
  passed('no horizontal overflow at 1024 and 390, and no page errors');
  report.passed = true;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 1));
  await browser?.close();
  await service?.close().catch(() => {});
}
