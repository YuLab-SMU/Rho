// Agent panel acceptance: a controlled ACP peer streams text, tool calls, a plan and a
// permission request through the real service and Chrome. No model credentials are used.
// It checks that the panel shows each action as it happens, keeps reading in place while
// the person scrolls up, renders the Agent's Markdown, and records a human choice.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

const evidence = path.resolve(process.env.RHO_AGENT_UI_EVIDENCE ?? 'work/agent-ui-acceptance/' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-agent-ui-acceptance-');
const report = { passed: false, root, checks: [], screenshots: [], follow: null, browserErrors: [] };
const passed = name => { report.checks.push(name); process.stdout.write('ok · ' + name + '\n'); };
let service, browser, page, shot = 0;
const peer = `import fs from 'node:fs';
import {createInterface} from 'node:readline';
const log=v=>fs.appendFileSync(process.env.RHO_ACP_TEST_LOG,JSON.stringify({t:Date.now(),...v})+'\\n');
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chunks=['**I will inspect the input table.** ','It has one header row and three columns. ','Then I will run the analysis. ','The model uses temperature and wind. ','Now writing the result table. ','One command needs your approval. ','**Findings**\\n\\n- alpha is 7\\n- beta is 11\\n\\n\\x60\\x60\\x60\\nalpha + beta = 18\\n\\x60\\x60\\x60\\n\\nNo files were modified.'];
let active=null, permission=null;
const update=update=>out({method:'session/update',params:{sessionId:'ui-session',update}});
createInterface({input:process.stdin}).on('line',async line=>{
 const r=JSON.parse(line),p=r.params,reply=result=>out({id:r.id,result});
 if(!r.method){log({kind:'choice',value:r.result});if(permission){permission=null;await finish();}return;}
 log({kind:r.method});
 if(r.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(r.method==='session/new')return reply({sessionId:'ui-session'});
 if(r.method==='session/load')return reply({});
 if(r.method==='session/cancel'){if(active)out({id:active,result:{stopReason:'cancelled'}});active=null;return;}
 if(r.method!=='session/prompt')return;
 active=r.id;
 if(p.prompt[0].text.includes('long')){
  for(let i=0;i<30;i++){update({sessionUpdate:'agent_message_chunk',messageId:'long',content:{type:'text',text:'Streaming line '+i+' of a longer reply. '}});await sleep(110);}
  out({id:active,result:{stopReason:'end_turn'}});active=null;return;
 }
 update({sessionUpdate:'plan',entries:[
  {content:'Inspect the input table',status:'in_progress',priority:'high'},
  {content:'Fit the model and write results',status:'pending',priority:'medium'},
  {content:'Check the result',status:'pending',priority:'medium'}]});
 update({sessionUpdate:'tool_call',toolCallId:'read-1',title:'Read data/airquality.csv',name:'Read',kind:'read',status:'in_progress',rawInput:{file_path:process.cwd()+'/data/airquality.csv'},locations:[{path:process.cwd()+'/data/airquality.csv'}]});
 await sleep(160);
 update({sessionUpdate:'tool_call_update',toolCallId:'read-1',status:'completed'});
 for(let i=0;i<3;i++){update({sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text:chunks[i]}});await sleep(80);}
 update({sessionUpdate:'tool_call',toolCallId:'bash-1',title:'Run the analysis',name:'Bash',kind:'execute',status:'in_progress',rawInput:{command:'Rscript analysis.R --input data/airquality.csv'}});
 await sleep(500);
 update({sessionUpdate:'tool_call_update',toolCallId:'bash-1',status:'completed'});
 update({sessionUpdate:'usage_update',used:18420,size:200000});
 for(let i=3;i<5;i++){update({sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text:chunks[i]}});await sleep(80);}
 update({sessionUpdate:'tool_call',toolCallId:'write-1',title:'Write results/summary.csv',name:'Write',kind:'edit',status:'in_progress',rawInput:{file_path:process.cwd()+'/results/summary.csv'},locations:[{path:process.cwd()+'/results/summary.csv'}]});
 await sleep(260);
 update({sessionUpdate:'tool_call_update',toolCallId:'write-1',status:'completed'});
 update({sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text:chunks[5]}});
 permission=r.id;
 out({id:'permission',method:'session/request_permission',params:{sessionId:'ui-session',toolCall:{toolCallId:'cleanup-1',title:'Remove the temporary folder',rawInput:{command:'rm -rf temp/'}},options:[{optionId:'yes',kind:'allow_once',name:'Allow once'},{optionId:'no',kind:'reject_once',name:'Reject'}]}});
});
async function finish(){
 for(let i=6;i<chunks.length;i++){update({sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text:chunks[i]}});await sleep(80);}
 update({sessionUpdate:'plan',entries:[
  {content:'Inspect the input table',status:'completed',priority:'high'},
  {content:'Fit the model and write results',status:'completed',priority:'medium'},
  {content:'Check the result',status:'completed',priority:'medium'}]});
 if(active){out({id:active,result:{stopReason:'end_turn'}});active=null;}
}
`;
try {
  await fs.writeFile(path.join(root, 'peer.mjs'), peer);
  await fs.mkdir(path.join(root, 'project', 'data'), { recursive: true });
  await fs.mkdir(path.join(root, 'project', 'results'), { recursive: true });
  await fs.writeFile(path.join(root, 'project', 'data', 'airquality.csv'), 'temp,wind,ozone\n72,7.4,41\n75,9.7,36\n');
  await fs.writeFile(path.join(root, 'project', 'analysis.R'), '# analysis\n');
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: path.join(root, 'absent-core'), rscript: 'Rscript',
    claudeAcp: { command: { file: process.execPath, args: [path.join(root, 'peer.mjs')] }, env: { RHO_ACP_TEST_LOG: path.join(root, 'peer.jsonl') } },
    conversations: { stopGraceMs: 1000 } }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await admin.call('project.open', { path: 'project' }); report.project = project.id;
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => report.browserErrors.push(e.message));
  const snap = async name => { const file = path.join(evidence, String(++shot).padStart(2, '0') + '-' + name + '.png'); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(path.basename(file)); };
  await page.goto(service.url);
  await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  await page.locator('.project-row').first().click();
  await page.getByRole('button', { name: 'Agent panel', exact: true }).click();
  const panel = page.locator('[aria-label="Agent panel"]');
  await panel.locator('#conversation-input').fill('Analyse the air quality table and write the main findings to the shared notes.');
  await panel.getByRole('button', { name: 'Start', exact: true }).click();
  await page.locator('.turn-ending.running').waitFor();

  // Text grows in place before the turn ends: this is actual streaming, not one final reply.
  const lengths = new Set();
  for (let i = 0; i < 30; i++) {
    const length = await panel.locator('.turn-text').last().innerText().then(text => text.length).catch(() => 0);
    if (length) lengths.add(length);
    if (await panel.locator('.turn-ending.running').count() === 0) break;
    await page.waitForTimeout(120);
  }
  assert.ok(lengths.size >= 2, 'the reply text arrives in more than one visible piece');
  passed('reply text streams into the open message');

  // Every action is visible while it happens, with its meaning rather than a tool id.
  // Each row is a flex line, so its innerText separates the verb and target with a newline.
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Agent panel"] .activity-row').length >= 3, null, { timeout: 15000 });
  const rows = await panel.locator('.activity-row summary').allInnerTexts();
  assert.ok(rows.some(text => /Read\s+data\/airquality\.csv/.test(text)), 'the file read is named');
  assert.ok(rows.some(text => /Ran\s+Rscript analysis\.R --input data\/airquality\.csv/.test(text)), 'the command is named');
  assert.ok(rows.some(text => /Wrote\s+results\/summary\.csv/.test(text)), 'the written file is named');
  passed('each action appears with its file, command or project operation');
  await snap('streaming-actions');

  const plan = panel.locator('.conversation-plan > summary');
  assert.match(await plan.innerText(), /Plan · Inspect the input table/);
  passed('the plan line follows the entry in progress');

  // A blocking permission request is its own surface, not a line in the transcript.
  const permission = panel.locator('.turn-permission');
  await permission.waitFor();
  assert.match(await permission.innerText(), /Needs your choice/);
  assert.match(await permission.innerText(), /Remove the temporary folder/);
  assert.match(await permission.innerText(), /rm -rf temp\//);
  await snap('permission');
  await permission.getByRole('button', { name: 'Allow once', exact: true }).click();
  await panel.locator('.turn-ending').last().getByText(/Done in/).waitFor({ timeout: 20000 });
  // Once the message ends, what the Agent did folds into one line above its answer; the
  // person's choice is kept inside it.
  const work = panel.locator('.turn-work').last();
  assert.equal(await work.evaluate(el => el.open), false, 'the finished work folds');
  assert.match(await work.locator(':scope > summary').innerText(), /Worked[\s\S]*1 choice/);
  await work.locator(':scope > summary').click();
  await panel.getByText(/You chose “Allow once”/).waitFor();
  await snap('work-open');
  passed('a native permission choice is shown, answered and retained as a human decision');

  assert.match(await plan.innerText(), /Plan · complete/);
  const text = panel.locator('.turn-text').last();
  await text.locator('strong', { hasText: 'Findings' }).waitFor();
  assert.ok(await text.locator('.md-list li').count() >= 2);
  assert.match(await text.locator('.md-code').innerText(), /alpha \+ beta = 18/);
  passed('Agent Markdown renders as prose, lists and code without raw HTML');
  await snap('ended');

  // Reading earlier lines keeps that position; the newest activity waits behind an explicit way back.
  await panel.locator('#conversation-input').fill('A longer reply, please. long');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForTimeout(1200);
  // The panel's body is what scrolls; its edge stays beside it.
  const pane = page.locator('.side-panel-body');
  const scrolled = await pane.evaluate(el => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 280); return el.scrollTop; });
  await page.waitForTimeout(1300);
  const held = await pane.evaluate(el => el.scrollTop);
  report.follow = { scrolled, held };
  assert.ok(held <= scrolled + 2, 'streaming does not pull the reader back to the end');
  const jump = panel.getByRole('button', { name: /Jump to latest/ });
  await jump.waitFor();
  assert.match(await jump.getAttribute('aria-label'), /New activity/);
  await snap('reading-earlier');
  await jump.click(); await page.waitForTimeout(400);
  const atEnd = await pane.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 4);
  assert.ok(atEnd, 'Jump to latest returns the reader to the newest activity');
  report.follow.returned = atEnd;
  passed('reading earlier lines is not interrupted, and Jump to latest returns to the stream');
  await panel.locator('.turn-ending').last().getByText(/Done in/).waitFor({ timeout: 15000 });

  assert.deepEqual(report.browserErrors, []);
  passed('no browser page errors');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (page) {
    report.debug = { rows: await page.locator('.activity-row').count().catch(() => -1), panel: await page.locator('[aria-label="Agent panel"]').innerText().catch(() => '') };
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
  process.stdout.write('not ok · ' + report.error + '\n');
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 1));
  await browser?.close().catch(() => {});
  await service?.close().catch(() => {});
  process.stdout.write('evidence · ' + evidence + '\n');
}
