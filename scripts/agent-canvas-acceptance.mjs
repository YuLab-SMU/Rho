// Shared workspace acceptance: a controlled ACP peer reads, edits and runs project files through
// the real service and Chrome, and writes an output no step names. No model credentials are
// used. It checks that the sidebar counts the project's contents, that a message sent from
// Studio leaves the person's workspace as they arranged it, that an edit shows the text now on
// disk in the open editor, that Follow opens the conversation's own Studio (its files by role,
// its commands, its parts and its time beside the conversation, replayed together), and that
// the answer board is led by the output the turn made, with the next question following it.
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
 if(p.prompt[0].text.includes('stations')){
  await tool('write-stations','Write','edit',{file_path:at('data/stations.csv')},1000,()=>fs.writeFileSync(at('data/stations.csv'),'station,ozone\\nA,41\\nB,36\\n'));
  await tool('read-stations','Read','read',{file_path:at('data/stations.csv')},1500);
  update({sessionUpdate:'agent_message_chunk',messageId:'stations',content:{type:'text',text:'Two stations.'}});
  await sleep(2500);
  return reply({stopReason:'end_turn'});
 }
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
  for (const name of ['Overview', 'Studio', 'Graph', 'Agent', 'Data', 'Code', 'Results & figures', 'Notes', 'Files']) await nav.getByRole('button', { name, exact: true }).waitFor();
  await nav.getByRole('button', { name: 'Data', exact: true }).click();
  await nav.locator('.nav-file').filter({ hasText: 'airquality.csv' }).waitFor();
  await shot('01-sidebar-data');
  passed('the sidebar names the project places and counts its data, code, results and notes');

  // The person opens the script in Studio first and asks the Agent from there.
  await nav.getByRole('button', { name: 'Code', exact: true }).click();
  await nav.locator('.nav-file').filter({ hasText: 'analysis.R' }).click();
  await page.getByRole('button', { name: 'Open in Studio' }).click();
  await page.locator('.location-name').filter({ hasText: 'Workspace' }).waitFor();
  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  await page.getByRole('textbox', { name: 'Start a conversation' }).fill('Fit ozone on temperature and draw it.');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.locator('.agent-chip').waitFor();
  await nav.locator('.nav-badge.working').waitFor();
  await page.locator('.follow-toggle[aria-pressed=false]').waitFor();
  assert.equal(await page.locator('.location-name').textContent(), 'Workspace', 'the person stays in their own workspace');
  passed('sending from the Agent panel keeps the person in their Studio workspace, with the Agent working in the topbar and sidebar');

  await until(() => page.locator('[data-owner-view] .cm-content').first().innerText(), text => /fit <- lm/.test(text), 'the edited script showing the text on disk');
  await page.locator('.rho-doc-agent-line').first().waitFor();
  await shot('03-edited-script');
  passed('an edit made outside Rho shows the new text in the open editor, with the changed lines highlighted');

  await until(() => page.locator('.agent-chip').count(), n => n === 0, 'the turn ending', 40000);
  const shared = await admin.call('observation.snapshot', { projectId: opened.id });
  assert.deepEqual(shared.compositions.map(c => c.compositionId), ['workspace'], 'one workspace, the person\'s');
  const canvas = await admin.call('composition.read', { projectId: opened.id, compositionId: 'workspace' });
  assert.deepEqual(canvas.views.map(v => v.props.title), ['analysis.R'], 'nothing opened beside the person\'s own view');
  assert.deepEqual((await tabs()).map(tab => tab.name), ['analysis.R']);
  await until(counts, c => c['Results & figures'] === '1', 'the new output counted');
  passed('Studio stays the person\'s own arrangement: the Agent\'s reads and outputs open nothing there; the new output is counted');

  // The Agent page keeps what the turn did; the top bar holds the one way to the Agent panel.
  assert.equal(await page.locator('.topbar').getByRole('button', { name: 'Agent panel', exact: true }).count(), 1, 'the Agent panel opens from the top bar');
  assert.equal(await nav.getByRole('button', { name: 'Agent panel' }).count(), 0, 'and from nowhere else in the sidebar');
  await nav.getByRole('button', { name: 'Agent', exact: true }).click();
  const row = page.locator('.conv-row').filter({ hasText: 'Fit ozone on temperature and draw it.' });
  await row.getByRole('button', { name: /^Show details of / }).click();
  const card = row.locator('.conv-details');
  await card.locator('.work-answer').filter({ hasText: 'I fitted ozone on temperature' }).waitFor();
  const lines = await card.locator('.work-line').evaluateAll(rows => rows.map(row => row.textContent));
  assert.deepEqual(lines, ['Changedanalysis.Redited', 'Looked atairquality.csv']);
  assert.match(await card.locator('.work-commands summary').textContent(), /Ran1 command/);
  assert.match(await card.locator('.work-ending').textContent(), /^Answered/);
  await shot('05a-agent-page');
  await card.locator('.work-file').filter({ hasText: 'airquality.csv' }).click();
  await page.locator('.preview-body .ag-row[row-index="0"]').first().waitFor();
  assert.equal(await page.locator('#preview-title').textContent(), 'airquality.csv');
  passed('the Agent page keeps what the turn changed, read, ran and answered; a file it names shows in place');

  // From Studio again, the next question; Follow opens the conversation's own Studio.
  await page.keyboard.press('Escape');
  await nav.getByRole('button', { name: 'Studio', exact: true }).click();
  await page.locator('.location-name').filter({ hasText: 'Workspace' }).waitFor();
  if (!await page.getByRole('textbox', { name: /Message|Reply/ }).count()) await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  await page.getByRole('textbox', { name: /Message|Reply/ }).fill('Now read the notes.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.follow-toggle[aria-pressed=false]').click();
  await page.locator('.location-name').filter({ hasText: /^Studio · / }).waitFor();
  await page.locator('.conversation-tab[aria-current=page]').waitFor();
  await until(tabs, list => ['airquality.csv', 'analysis.R', 'Commands', 'ozone.svg'].every(name => list.some(tab => tab.name === name)), 'the conversation\'s files and commands in its Studio');
  await page.locator('.side-timeline .side-tl-mark').first().waitFor();
  await page.locator('.steps-chip').waitFor();
  await until(tabs, list => list.some(tab => tab.name === 'notes.md'), 'the notes the follow-up read joining its Studio', 30000);
  await shot('06-conversation-studio');
  passed('Follow opens the conversation\'s own Studio: its data, script, commands and output by role, its parts above and its time beside the conversation');

  // Pressing the top of the timeline shows that moment in the views and the conversation together.
  await until(() => page.locator('.agent-chip').count(), n => n === 0, 'the follow-up ending', 40000);
  const track = await page.locator('.side-tl-track').boundingBox();
  await page.mouse.click(track.x + track.width / 2, track.y + 10);
  await page.locator('.conversation-replay').waitFor();
  await until(tabs, list => !list.some(tab => tab.name === 'ozone.svg' || tab.name === 'notes.md'), 'later files absent at the replayed moment');
  assert.equal(await page.locator('.conversation-turns > li').filter({ hasText: 'Now read the notes.' }).count(), 0, 'the later message is absent from the conversation then');
  await shot('07-replay');
  await page.getByRole('button', { name: 'Back to now' }).click();
  await until(tabs, list => list.some(tab => tab.name === 'notes.md'), 'back to now');
  passed('a moment chosen on the timeline shows the views and the conversation as they were then; Back to now returns');

  // The Overview's answer board follows the answer whose results the next question asks about.
  await nav.getByRole('button', { name: 'Overview', exact: true }).click();
  const board = page.locator('.answer-board');
  await board.locator('h2').filter({ hasText: 'Fit ozone on temperature and draw it.' }).waitFor();
  await board.locator('.board-item.role-primary').filter({ hasText: 'ozone.svg' }).waitFor();
  await board.locator('.board-follow-up').filter({ hasText: 'Now read the notes.' }).waitFor();
  await until(() => board.locator('.board-follow-up .work-answer').innerText(), text => /ozone by month/.test(text), 'the follow-up answered on the board', 30000);
  await shot('08-board');
  passed('the answer board is led by the figure the first message made, and the next question follows it with its answer');

  await nav.getByRole('button', { name: 'Studio', exact: true }).click();
  await page.locator('.location-name').filter({ hasText: /^Studio · / }).waitFor();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width);
    await shot('09-studio-' + width);
  }
  assert.deepEqual(report.browserErrors, []);
  passed('no horizontal overflow at 1024 and 390, and no page errors');
  report.passed = true;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 1));
  await browser?.close();
  await service?.close().catch(() => {});
}
