// Agent page acceptance: controlled ACP peers stand in for Claude Code and Codex in a disposable
// project, through the real service and Chrome. No model credentials are used. The Claude Code
// peer offers its own model names, models from two providers, effort and mode, and reports a
// session title, context use and cost. It checks that the Agents tab asks an Agent what it offers
// only when the person asks, shows its names, providers and models, and saves the model, effort
// and default Agent; that conversations are rows with the Agent's title, model, effort, context
// and cost, found by search and by Agent; that a row opens to its facts and what it did, with a
// Markdown table rendered, and exports as Markdown; and that the trash keeps, restores and
// deletes a conversation, never while the Agent answers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { BrowserClient } from '../dist/browser.js';

const evidence = path.resolve(process.env.RHO_AGENT_PAGE_EVIDENCE ?? 'work/agent-page-acceptance/' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.realpath(await fs.mkdtemp('/tmp/rho-agent-page-acceptance-'));
const report = { passed: false, root, checks: [], screenshots: [], browserErrors: [] };
const passed = name => { report.checks.push(name); process.stdout.write('ok · ' + name + '\n'); };
let service, browser, page;
const peer = `import {createInterface} from 'node:readline';
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const codex=process.env.PEER_AGENT==='codex';
const settings=codex?[
 {id:'model',name:'Model',category:'model',type:'select',currentValue:'gpt-5.6',options:[{value:'gpt-5.6',name:'GPT-5.6'},{value:'gpt-5.6-mini',name:'GPT-5.6 mini'}]},
 {id:'reasoning',name:'Reasoning',category:'thought_level',type:'select',currentValue:'medium',options:[{value:'low',name:'Low'},{value:'medium',name:'Medium'},{value:'high',name:'High'}]}]:[
 {id:'model',name:'Model',category:'model',type:'select',currentValue:'default',options:[
  {value:'default',name:'Default (recommended)',description:'Opus 5.5'},{value:'opus',name:'Opus 5.5 (opus)',description:'Custom Opus model (lab/opus-5-5)'},{value:'sonnet',name:'Sonnet 5.5 (sonnet)',description:'Custom Sonnet model (lab/sonnet-5-5)'},
  {value:'auto/deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash · routing group'},{value:'auto/claude-sonnet-5-5',name:'Claude Sonnet 5.5 · routing group'},{value:'deepseek/deepseek-v4.1',name:'DeepSeek V4.1 · DeepSeek'}]},
 {id:'effort',name:'Effort',category:'thought_level',type:'select',currentValue:'xhigh',options:[{value:'low',name:'Low'},{value:'high',name:'High'},{value:'xhigh',name:'Xhigh'}]},
 {id:'mode',name:'Mode',category:'mode',type:'select',currentValue:'default',options:[{value:'default',name:'Default'},{value:'plan',name:'Plan'}]}];
const waiting=new Map();
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),p=r.params,reply=result=>out({id:r.id,result});
 if(!r.method)return;
 const update=update=>out({method:'session/update',params:{sessionId:p.sessionId,update}});
 if(r.method==='initialize')return reply({protocolVersion:1,agentInfo:{name:codex?'codex-test-peer':'claude-test-peer',version:'1.2.0'},agentCapabilities:{loadSession:true,sessionCapabilities:{close:{},delete:{}}}});
 if(r.method==='session/new')return reply({sessionId:'s-'+Math.random().toString(16).slice(2,10),configOptions:settings});
 if(r.method==='session/load')return reply({configOptions:settings});
 if(r.method==='session/set_config_option'){settings.find(x=>x.id===p.configId).currentValue=p.value;return reply({configOptions:settings});}
 if(r.method==='session/delete'||r.method==='session/close')return reply({});
 if(r.method==='session/cancel'){const id=waiting.get(p.sessionId);if(id!==undefined){waiting.delete(p.sessionId);out({id,result:{stopReason:'cancelled'}});}return;}
 if(r.method!=='session/prompt')return;
 const text=p.prompt[0].text;
 if(text==='wait'){waiting.set(p.sessionId,r.id);return;}
 if(!codex)update({sessionUpdate:'session_info_update',title:'Ozone summary by month'});
 update({sessionUpdate:'tool_call',toolCallId:'t'+Math.random(),title:'Read',kind:'read',status:'completed',rawInput:{file_path:process.cwd()+'/data/ozone.csv'},locations:[{path:process.cwd()+'/data/ozone.csv'}]});
 update({sessionUpdate:'usage_update',used:12345,size:200000,cost:{amount:0.0421,currency:'USD'}});
 update({sessionUpdate:'agent_message_chunk',messageId:'a',content:{type:'text',text:'Mean ozone by month:\\n| Month | Mean ozone |\\n|---|--:|\\n| May | 23.6 |\\n| Jul | 59.1 |\\nJuly is highest.'}});
 reply({stopReason:'end_turn'});
});
`;
async function until(read, accept, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read().catch(error => ({ error: error.message }));
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(label + ' did not happen. Last: ' + JSON.stringify(value).slice(0, 1200));
}
const shot = async name => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(path.basename(file)); };
try {
  await fs.writeFile(path.join(root, 'peer.mjs'), peer);
  const project = path.join(root, 'ozone');
  await fs.mkdir(path.join(project, 'data'), { recursive: true });
  await fs.writeFile(path.join(project, 'data/ozone.csv'), 'Month,Ozone\n5,41\n7,97\n');
  const command = { file: process.execPath, args: [path.join(root, 'peer.mjs')] };
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: path.join(root, 'absent-core'), rscript: 'Rscript',
    claudeAcp: { command, env: { PEER_AGENT: 'claude' } }, codexAcp: { command, env: { PEER_AGENT: 'codex' } }, conversations: { stopGraceMs: 500 } }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken }), person = new BrowserClient({ url: service.url });
  const opened = await admin.call('project.open', { path: 'ozone' });
  const call = (method, body = {}) => person.call(method, { projectId: opened.id, ...body });
  const ended = async id => until(() => call('conversation.read', { conversationId: id }), r => r.turns?.length && r.turns.at(-1).state !== 'running', 'the message ending');
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.goto(service.url);
  await page.locator('.project-row').first().click();
  const nav = page.locator('.project-nav');
  await nav.getByRole('button', { name: 'Agent', exact: true }).click();

  // The Agents: nothing is asked until the person asks.
  await page.getByRole('tab', { name: 'Agents' }).click();
  const claude = page.locator('.agent-row').filter({ hasText: 'Claude Code' }), codex = page.locator('.agent-row').filter({ hasText: 'Codex' });
  assert.match(await claude.locator('.agent-row-status').textContent(), /Not asked yet/);
  assert.match(await codex.locator('.agent-row-status').textContent(), /Not asked yet/);
  assert.equal(await claude.locator('.agent-default').count(), 1, 'Claude Code is the default');
  await claude.getByRole('button', { name: 'Details' }).click();
  await claude.getByRole('button', { name: 'Ask Claude Code' }).click();
  await until(() => claude.locator('.agent-row-status').textContent(), t => /^Checked today .* · 6 models from 2 providers$/.test(t), 'Claude Code asked');
  assert.match(await claude.locator('.agent-row-version').textContent(), /claude-test-peer 1\.2\.0/);
  assert.deepEqual(await claude.locator('.agent-tiers code').allTextContents(), ['default', 'opus', 'sonnet'], 'Claude Code\'s own names');
  assert.match(await claude.locator('.agent-tiers li').nth(1).textContent(), /Custom Opus model \(lab\/opus-5-5\)/);
  assert.deepEqual(await claude.locator('.agent-provider').evaluateAll(chips => chips.map(chip => chip.querySelector('span:not(.provider-mark)').textContent + ' ' + chip.querySelector('small').textContent)), ['routing group 2', 'DeepSeek 1']);
  assert.equal(await claude.locator('.agent-provider').filter({ hasText: 'DeepSeek' }).locator('svg.maker-deepseek').count(), 1, 'DeepSeek in its own mark');
  await claude.locator('.agent-provider').filter({ hasText: 'DeepSeek' }).click();
  await claude.locator('.agent-model-list').getByRole('button', { name: /DeepSeek V4\.1/ }).click();
  await until(() => call('conversation.settings.read'), s => s.choices['claude-acp']?.model === 'deepseek/deepseek-v4.1', 'the model saved');
  await until(() => claude.locator('.agent-row-model .agent-model-value').textContent(), t => t === 'DeepSeek V4.1', 'the chosen model on the row');
  await claude.getByRole('combobox', { name: 'Effort' }).selectOption('high');
  await until(() => call('conversation.settings.read'), s => s.choices['claude-acp']?.effort === 'high', 'the effort saved');
  await shot('01-agents');
  await codex.getByRole('button', { name: 'Make default' }).click();
  await until(() => call('conversation.settings.read'), s => s.backend === 'codex-acp', 'Codex made the default');
  await codex.locator('.agent-default').waitFor();
  await claude.getByRole('button', { name: 'Make default' }).click();
  await until(() => call('conversation.settings.read'), s => s.backend === 'claude-acp', 'Claude Code the default again');
  passed('the Agents tab asks an Agent only when asked, shows its own names, providers and models, and saves the model, effort and default Agent');

  // Conversations as rows: the Agent's title, model, effort, context and cost.
  const first = (await call('conversation.start', { changeId: 'page-1', text: 'Summarize ozone by month.' })).conversation.conversationId;
  await ended(first);
  await call('conversation.send', { conversationId: first, changeId: 'page-2', text: 'And the highest month?' });
  await ended(first);
  const second = (await call('conversation.start', { changeId: 'page-3', text: 'List the data files.', backend: 'codex-acp' })).conversation.conversationId;
  await ended(second);
  await page.getByRole('tab', { name: /^Conversations/ }).click();
  const row = page.locator('.conv-row').filter({ hasText: 'Ozone summary by month' }), other = page.locator('.conv-row').filter({ hasText: 'List the data files.' });
  await row.waitFor(); await other.waitFor();
  const meta = await row.locator('.conv-meta').textContent();
  assert.match(meta, /DeepSeek V4\.1.*High effort.*2 messages/);
  assert.equal(await row.locator('.conv-context').textContent(), '12K / 200K');
  assert.equal(await row.locator('.conv-cost').textContent(), '$0.042');
  assert.match(await other.locator('.conv-meta').textContent(), /GPT-5\.6.*1 message/);
  assert.equal(await other.locator('svg.maker-codex').count(), 1);
  await page.locator('.conv-filter').getByRole('radio', { name: /Codex/ }).click();
  assert.deepEqual(await page.locator('.conv-row .conv-title').allTextContents(), ['List the data files.']);
  await page.locator('.conv-filter').getByRole('radio', { name: /All/ }).click();
  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('ozone');
  assert.deepEqual(await page.locator('.conv-row .conv-title').allTextContents(), ['Ozone summary by month']);
  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('');
  await shot('02-conversations');
  passed('conversations are rows with the Agent\'s title, model, effort, context and cost, found by search and by Agent');

  // A row opens to its facts and what it did; it exports as Markdown.
  await row.getByRole('button', { name: /^Show details of / }).click();
  const facts = Object.fromEntries(await row.locator('.conv-facts dt').evaluateAll(dts => dts.map(dt => [dt.textContent, dt.nextElementSibling.textContent])));
  assert.match(facts.Model, /^DeepSeek V4\.1 · DeepSeek deepseek\/deepseek-v4\.1$/);
  assert.equal(facts.Settings, 'Effort High');
  assert.equal(facts.Context, '12K of 200K tokens · 6%');
  assert.equal(facts.Cost, '$0.042, as Claude Code reported it');
  assert.equal(facts.Asked, 'Summarize ozone by month.');
  assert.match(facts.Agent, /Claude Code · claude-test-peer 1\.2\.0/);
  await row.locator('.md-table th').first().waitFor();
  assert.deepEqual(await row.locator('.work-turn').last().locator('.md-table th').allTextContents(), ['Month', 'Mean ozone']);
  assert.equal(await row.locator('.work-turn').last().locator('.md-table td').nth(1).evaluate(td => getComputedStyle(td).textAlign), 'right');
  await shot('03-opened');
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: /^Export .* as Markdown$/ }).click()]);
  assert.equal(download.suggestedFilename(), 'Ozone-summary-by-month.md');
  const markdown = await fs.readFile(await download.path(), 'utf8');
  for (const part of ['# Ozone summary by month', '## You · ', 'Summarize ozone by month.', 'And the highest month?', '| Month | Mean ozone |', '- Read `data/ozone.csv`']) assert.ok(markdown.includes(part), 'the export has ' + part);
  assert.ok(!markdown.includes(project), 'paths are written relative to the project');
  passed('a row opens to its model, settings, context, cost and what it did with its table rendered, and exports as Markdown');

  // The trash: never while the Agent answers; kept, restored and deleted from there.
  await call('conversation.send', { conversationId: first, changeId: 'page-4', text: 'wait' });
  await until(() => row.locator('.conv-state').textContent(), t => t === 'Working', 'the row working');
  assert.equal(await row.getByRole('button', { name: /^Move .* to the trash$/ }).isDisabled(), true, 'not while the Agent answers');
  assert.equal(await row.locator('.conv-continue').textContent(), 'Follow');
  await call('conversation.stop', { conversationId: first, turnId: 't3' });
  await ended(first);
  await other.getByRole('button', { name: /^Move .* to the trash$/ }).click();
  await page.locator('.conv-notice').filter({ hasText: 'Moved “List the data files.” to the trash.' }).waitFor();
  await until(() => page.locator('.conv-row .conv-title').allTextContents(), t => t.join() === 'Ozone summary by month', 'the row gone from the list');
  await page.locator('.conv-notice').getByRole('button', { name: 'Undo' }).click();
  await other.waitFor();
  await other.getByRole('button', { name: /^Move .* to the trash$/ }).click();
  await page.getByRole('button', { name: /^Trash/ }).filter({ hasText: '1' }).click();
  const trashed = page.locator('.conv-row.trashed').filter({ hasText: 'List the data files.' });
  await trashed.getByRole('button', { name: 'Restore' }).click();
  await until(() => call('conversation.list'), r => r.conversations.length === 2, 'restored');
  await page.getByRole('button', { name: /^Trash/ }).click();
  await other.getByRole('button', { name: /^Move .* to the trash$/ }).click();
  await page.getByRole('button', { name: /^Trash/ }).filter({ hasText: '1' }).click();
  await trashed.getByRole('button', { name: /^Delete / }).click();
  await shot('04-delete');
  await page.locator('.conv-confirm').getByRole('button', { name: 'Delete' }).click();
  await page.locator('.conv-notice').filter({ hasText: 'Deleted “List the data files.”.' }).waitFor();
  await page.getByText('The trash is empty.').waitFor();
  await assert.rejects(call('conversation.read', { conversationId: second }), error => error.error?.kind === 'not_found');
  passed('the trash keeps a conversation until restored or deleted, with Undo, and never takes one the Agent is answering');

  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    for (const tab of ['Agents', /^Conversations/]) {
      if (width === 390 && !(await page.getByRole('tab', { name: tab }).isVisible())) continue;
      await page.getByRole('tab', { name: tab }).click();
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width);
    }
    await shot('05-' + width);
  }
  assert.deepEqual(report.browserErrors, []);
  passed('no horizontal overflow at 1024 and 390, and no page errors');
  report.passed = true;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 1));
  await browser?.close();
  await service?.close().catch(() => {});
}
