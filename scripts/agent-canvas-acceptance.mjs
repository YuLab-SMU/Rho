// Agent canvas acceptance: a controlled ACP peer reads, edits and runs project files through
// the real service and Chrome, and writes an output no step names. No model credentials are
// used. It checks that the sidebar counts the project's contents, that a message sent from the
// Agent panel opens the Agent canvas, that each file the Agent works on opens there with the
// Agent's place on its tab, that an edit shows the text now on disk, that an output appearing
// during the turn is shown, and that choosing another view stops following until asked again.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

const evidence = path.resolve(process.env.RHO_AGENT_CANVAS_EVIDENCE ?? 'work/agent-canvas-acceptance/' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-agent-canvas-acceptance-');
const report = { passed: false, root, checks: [], screenshots: [], browserErrors: [] };
const passed = name => { report.checks.push(name); process.stdout.write('ok · ' + name + '\n'); };
let service, browser, page;
const peer = `import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const at=p=>path.join(process.cwd(),p);
const update=update=>out({method:'session/update',params:{sessionId:'canvas-session',update}});
const tool=async(id,name,kind,input,ms,during)=>{
 update({sessionUpdate:'tool_call',toolCallId:id,title:name,name,kind,status:'in_progress',rawInput:input,...(input.file_path?{locations:[{path:input.file_path}]}:{})});
 await sleep(ms); if(during)during(); await sleep(300);
 update({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed'});
};
createInterface({input:process.stdin}).on('line',async line=>{
 const r=JSON.parse(line),p=r.params,reply=result=>out({id:r.id,result});
 if(!r.method)return;
 if(r.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(r.method==='session/new')return reply({sessionId:'canvas-session'});
 if(r.method==='session/load')return reply({});
 if(r.method!=='session/prompt')return;
 if(p.prompt[0].text.includes('notes')){
  await sleep(2500);
  await tool('read-notes','Read','read',{file_path:at('notes.md')},2500);
  update({sessionUpdate:'agent_message_chunk',messageId:'notes',content:{type:'text',text:'The notes ask about ozone by month.'}});
  await sleep(3000);
  return reply({stopReason:'end_turn'});
 }
 await tool('read-1','Read','read',{file_path:at('data/airquality.csv')},2500);
 await tool('read-2','Read','read',{file_path:at('analysis.R')},1500);
 await tool('edit-1','Edit','edit',{file_path:at('analysis.R')},1500,()=>fs.writeFileSync(at('analysis.R'),'# analysis\\nair <- read.csv(\"data/airquality.csv\")\\nfit <- lm(ozone ~ temp, data = air)\\n'));
 await tool('bash-1','Bash','execute',{command:'Rscript analysis.R'},1500,()=>{fs.mkdirSync(at('results'),{recursive:true});fs.writeFileSync(at('results/ozone.svg'),'<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"80\"><rect x=\"10\" y=\"20\" width=\"30\" height=\"50\" fill=\"#2a78d6\"/><rect x=\"60\" y=\"5\" width=\"30\" height=\"65\" fill=\"#2a78d6\"/></svg>');});
 update({sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text:'I fitted ozone on temperature and drew the chart.'}});
 // Long enough for one bounded folder walk to observe the new output while the turn runs.
 await sleep(7000);
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
  throw new Error(label + ' did not happen. Last: ' + JSON.stringify(value).slice(0, 600));
}
const shot = async name => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(path.basename(file)); };
const tabs = () => page.evaluate(() => [...document.querySelectorAll('.shell-tabs [role=tab]')].map(tab => ({ name: tab.querySelector('.shell-tab-name')?.textContent ?? '', selected: tab.getAttribute('aria-selected') === 'true', presence: tab.querySelector('.agent-presence')?.textContent ?? null })));
try {
  await fs.writeFile(path.join(root, 'peer.mjs'), peer);
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'data'), { recursive: true });
  await fs.writeFile(path.join(project, 'data', 'airquality.csv'), 'month,temp,ozone\n5,67,41\n6,72,36\n7,84,59\n');
  await fs.writeFile(path.join(project, 'analysis.R'), '# analysis\n');
  await fs.writeFile(path.join(project, 'notes.md'), '# Notes\n\nHow does ozone change by month? 臭氧\n');
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: path.join(root, 'absent-core'), rscript: 'Rscript',
    claudeAcp: { command: { file: process.execPath, args: [path.join(root, 'peer.mjs')] } }, conversations: { stopGraceMs: 1000 } }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const opened = await admin.call('project.open', { path: 'project' });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.goto(service.url);
  await page.locator('.project-row').first().click();

  const nav = page.locator('.project-nav');
  const counts = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.project-nav .nav-row')].map(row => [row.querySelector('.nav-row-name')?.textContent ?? '', row.querySelector('.nav-row-count')?.textContent ?? null])));
  await until(counts, c => c.Data === '1' && c.Code === '1' && c.Notes === '1' && c['Results & figures'] === '0', 'sidebar counts by kind');
  for (const name of ['Overview', 'Studio', 'Activity', 'Data', 'Code', 'Results & figures', 'Notes', 'Files']) await nav.getByRole('button', { name, exact: true }).waitFor();
  await nav.getByRole('button', { name: 'Data', exact: true }).click();
  await nav.locator('.nav-file').filter({ hasText: 'airquality.csv' }).waitFor();
  await shot('01-sidebar-data');
  passed('the sidebar names the project places and counts its data, code, results and notes');

  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('textbox', { name: 'Start a conversation' }).fill('Fit ozone on temperature and draw it.');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.locator('.location-name').filter({ hasText: 'Agent canvas' }).waitFor();
  await page.locator('.follow-toggle[aria-pressed=true]').waitFor();
  await page.locator('.agent-chip').waitFor();
  await nav.locator('.nav-badge.working').waitFor();
  passed('sending from the Agent panel opens the Agent canvas, following, with the Agent working in the topbar and sidebar');

  const reading = await until(tabs, t => t.some(tab => tab.name === 'airquality.csv' && tab.selected && tab.presence === 'Reading'), 'the read file shown with the Agent reading it');
  await page.locator('.ag-row[row-index="0"]').first().waitFor();
  await shot('02-reading-table');
  passed('a file the Agent reads opens on the canvas in its table view, marked as being read');

  await until(tabs, t => t.some(tab => tab.name === 'analysis.R' && tab.selected), 'the edited script brought forward');
  await until(() => page.locator('[data-owner-view] .cm-content').first().innerText(), text => /fit <- lm/.test(text), 'the edited script showing the text on disk');
  await page.locator('.rho-doc-agent-line').first().waitFor();
  await shot('03-edited-script');
  passed('an edit made outside Rho shows the new text in the editor, with the changed lines highlighted');

  await until(tabs, t => t.some(tab => tab.name === 'ozone.svg'), 'the output that appeared during the turn', 40000);
  await page.locator('[data-owner-view] img').first().waitFor();
  await shot('04-output');
  passed('an output that appears on disk during the turn is shown, without a step naming it');

  await until(() => page.locator('.agent-chip').count(), n => n === 0, 'the turn ending', 30000);
  const canvas = await admin.call('composition.read', { projectId: opened.id, compositionId: 'agent-canvas' });
  const titles = canvas.views.map(v => v.props.title).sort();
  assert.deepEqual(titles, ['airquality.csv', 'analysis.R', 'ozone.svg']);
  const split = canvas.nodes.find(n => n.id === canvas.rootId);
  assert.equal(split.presentation?.mode, 'split');
  assert.deepEqual(split.children, ['canvas-code', 'canvas-data']);
  await until(counts, c => c['Results & figures'] === '1', 'the new output counted');
  passed('the canvas is one saved layout: code on the left, data and figures on the right, each file once');

  // The person chooses another view: following stops, and the Agent's next file waits.
  await page.getByRole('textbox', { name: /Message|Reply/ }).fill('Now read the notes.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.follow-toggle[aria-pressed=true]').waitFor();
  await page.getByRole('tab', { name: 'airquality.csv' }).click();
  await page.locator('.follow-toggle[aria-pressed=false]').waitFor();
  await page.waitForTimeout(5500);
  let now = await tabs();
  assert.ok(now.find(tab => tab.name === 'airquality.csv')?.selected, 'the person keeps the view they chose');
  assert.ok(!now.some(tab => tab.name === 'notes.md'), 'nothing is opened while not following');
  await shot('05-person-chose');
  await page.locator('.follow-toggle[aria-pressed=false]').click();
  now = await until(tabs, t => t.some(tab => tab.name === 'notes.md' && tab.selected), 'following again brings the Agent\'s file forward');
  await shot('06-follow-again');
  passed('choosing another view stops following; Follow brings the Agent\'s newest file forward');

  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width);
    await shot('07-canvas-' + width);
  }
  assert.deepEqual(report.browserErrors, []);
  passed('no horizontal overflow at 1024 and 390, and no page errors');
  report.passed = true;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 1));
  await browser?.close();
  await service?.close().catch(() => {});
}
