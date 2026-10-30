import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RhoService } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { RhoClient } from '../dist/client.js';

// An Agent that reads the same unchanged data file many times, then writes its result.
const peer = `import fs from 'node:fs';import readline from 'node:readline';
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const update=u=>out({method:'session/update',params:{sessionId:'test',update:u}});
readline.createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l),reply=result=>out({id:r.id,result});
 if(r.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(r.method==='session/new')reply({sessionId:'test'});if(r.method==='session/load')reply({});
 if(r.method==='session/prompt'){
  for(let i=0;i<12;i++)update({sessionUpdate:'tool_call',toolCallId:'read-'+i,title:'Read',kind:'read',status:'completed',locations:[{path:process.cwd()+'/data.csv'}],rawInput:{file_path:process.cwd()+'/data.csv'}});
  fs.mkdirSync('results',{recursive:true});fs.writeFileSync('results/out.csv','id,n\\n1,'+Date.now()+'\\n');
  update({sessionUpdate:'tool_call',toolCallId:'write',title:'Write',kind:'edit',status:'completed',locations:[{path:process.cwd()+'/results/out.csv'}],rawInput:{file_path:process.cwd()+'/results/out.csv'}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'See results/out.csv.'},messageId:'m'});
  reply({stopReason:'end_turn'});}});`;

async function setup(t, conversations = {}) {
  const root = await fs.mkdtemp('/tmp/rho-decisions-');
  await fs.writeFile(path.join(root, 'peer.mjs'), peer); await fs.mkdir(path.join(root, 'project'));
  await fs.writeFile(path.join(root, 'project', 'data.csv'), 'id,x\n1,2\n');
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing', conversations, claudeAcp: { command: { file: process.execPath, args: [path.join(root, 'peer.mjs')] } } }).start();
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const admin = new RhoClient({ url: service.url, token: service.adminToken }), p = await admin.call('project.open', { path: 'project' }), person = new BrowserClient({ url: service.url });
  return { service, admin, p, root, call: (m, b = {}) => person.call(m, { projectId: p.id, ...b }) };
}
async function answered(call, conversationId) {
  for (let i = 0; i < 300; i++) {
    const read = await call('conversation.read', { conversationId }), last = read.turns.at(-1);
    if (last.state !== 'running' && last.evidence?.records.every(r => r.state !== 'pending')) return read;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('The message was not answered.');
}

test('reading an unchanged file again spends no capture budget, and the result is still kept', async t => {
  const { call } = await setup(t, { maxCaptureFiles: 8 });
  const started = await call('conversation.start', { changeId: 'one', text: 'answer' });
  const read = await answered(call, started.conversation.conversationId), records = read.turns[0].evidence.records;
  const data = records.filter(r => r.path === 'data.csv');
  assert.equal(data.length, 1, 'one record for twelve reads of the same bytes');
  assert.equal(data[0].state, 'captured');
  assert.ok(records.some(r => r.path === 'results/out.csv' && r.state === 'captured'));
  assert.equal(read.turns[0].evidence.omitted, 0);
});

test('a person decides on an answer for the versions it kept; retries and later decisions keep every fact', async t => {
  const { call, admin, p } = await setup(t);
  const started = await call('conversation.start', { changeId: 'one', text: 'answer' }), conversationId = started.conversation.conversationId;
  const read = await answered(call, conversationId), turnId = read.turns[0].id;
  const kept = read.turns[0].evidence.records.find(r => r.path === 'results/out.csv').snapshots.at(-1).resource;
  await assert.rejects(call('conversation.decide', { conversationId, turnId, changeId: 'no-reason', decision: 'needs-changes' }), e => e.error?.kind === 'invalid');
  const accepted = await call('conversation.decide', { conversationId, turnId, changeId: 'accept', decision: 'accepted' });
  const first = accepted.turn.decisions[0];
  assert.equal(first.decision, 'accepted'); assert.equal(first.by, 'browser:local'); assert.equal(first.supersedes, null);
  assert.deepEqual(first.results.find(r => r.path === 'results/out.csv').resource, kept);
  // A lost response retried under the same identity records nothing new; another intent under it is refused.
  assert.equal((await call('conversation.decide', { conversationId, turnId, changeId: 'accept', decision: 'accepted' })).turn.decisions.length, 1);
  await assert.rejects(call('conversation.decide', { conversationId, turnId, changeId: 'accept', decision: 'needs-changes', note: 'x' }), e => e.error?.kind === 'conflict');
  const changed = await call('conversation.decide', { conversationId, turnId, changeId: 'change', decision: 'needs-changes', note: '  Use both measurements. 保留 🧬 ' });
  assert.deepEqual(changed.turn.decisions.map(d => [d.decision, d.note, d.supersedes]), [['accepted', null, null], ['needs-changes', 'Use both measurements. 保留 🧬', 'accept']]);
  // Only the person at this machine decides; the operator's credential does not.
  await assert.rejects(admin.call('conversation.decide', { projectId: p.id, conversationId, turnId, changeId: 'operator', decision: 'accepted' }), e => e.error?.kind === 'unauthorized');
});

test('the person runs and stops Console commands; an Agent may read them but never run one', async t => {
  const { service, admin, call, p, root } = await setup(t);
  const run = await call('console.run', { command: 'echo made > made.txt; echo printed', changeId: 'c1' });
  assert.equal(run.command.by, 'browser:local');
  let listed;
  for (let i = 0; i < 200; i++) { listed = await call('console.list', {}); if (listed.commands[0].state !== 'running') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(listed.commands[0].state, 'exited'); assert.deepEqual(listed.commands[0].exit, { code: 0, signal: null });
  assert.equal((await call('console.output', { commandId: run.command.commandId })).text, 'printed\n');
  assert.equal(await fs.readFile(path.join(p.root, 'made.txt'), 'utf8'), 'made\n');
  assert.equal((await call('console.run', { command: 'echo made > made.txt; echo printed', changeId: 'c1' })).command.commandId, run.command.commandId);
  await assert.rejects(admin.call('console.run', { projectId: p.id, command: 'true', changeId: 'operator' }), e => e.error?.kind === 'unauthorized');
  const grant = path.join(root, 'agent.json');
  await assert.rejects(service.agentConnection(p.id, 'console-run', grant, ['console.run']), /operator-only|Unknown/);
  const connection = await service.agentConnection(p.id, 'console-read', grant);
  assert.ok(connection.methods.includes('console.list') && connection.methods.includes('console.output'));
  assert.ok(!connection.methods.includes('console.run') && !connection.methods.includes('console.stop'));
  const agent = new RhoClient(JSON.parse(await fs.readFile(grant, 'utf8')));
  assert.equal((await agent.call('console.list', { projectId: p.id })).commands.length, 1);
  await assert.rejects(agent.call('console.run', { projectId: p.id, command: 'true', changeId: 'agent' }), e => e.error?.kind === 'unauthorized');
});
