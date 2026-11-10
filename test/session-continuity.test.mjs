import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { RhoClient } from '../dist/client.js';

// Sessions an Agent keeps in its own files, started outside Rho, are listed with the project's
// conversations and continue through the same session, or a copy while another window holds it.
const shortTemp = process.platform === 'win32' ? tmpdir() : '/tmp';
// An ACP Agent that writes each request it gets to requests.jsonl and answers in the session it was given.
const peer = `import fs from 'node:fs';import readline from 'node:readline';
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');let sid='new-session';
readline.createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l),reply=result=>out({id:r.id,result});
 if(r.method)fs.appendFileSync(process.env.PEER_LOG,JSON.stringify({method:r.method,sessionId:r.params?.sessionId??null,pid:process.pid})+'\\n');
 if(r.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{fork:{}}}});
 if(r.method==='session/new')reply({sessionId:sid});
 if(r.method==='session/load'){sid=r.params.sessionId;reply({});}
 if(r.method==='session/fork'){sid='forked-'+r.params.sessionId;reply({sessionId:sid});}
 if(r.method==='session/prompt'){out({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Continued '+sid},messageId:'m'}}});reply({stopReason:'end_turn'});}});`;
const claudeId = '0f1e2d3c-4b5a-4968-8776-655443322110', codexId = '01a1b242-0000-7000-8000-000000000001';

async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(shortTemp, 'rho-continue-')));
  const config = path.join(root, 'claude'), codex = path.join(root, 'codex');
  process.env.CLAUDE_CONFIG_DIR = config; process.env.CODEX_HOME = codex; process.env.PEER_LOG = path.join(root, 'requests.jsonl');
  await fs.writeFile(path.join(root, 'peer.mjs'), peer); await fs.mkdir(path.join(root, 'project'));
  const command = { command: { file: process.execPath, args: [path.join(root, 'peer.mjs')] } };
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing', claudeAcp: command, codexAcp: command }).start();
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const admin = new RhoClient({ url: service.url, token: service.adminToken }), p = await admin.call('project.open', { path: 'project' }), person = new BrowserClient({ url: service.url });
  // A Claude Code session started in a terminal in the project folder, and a Codex app session.
  const folder = path.join(config, 'projects', p.root.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(folder, { recursive: true });
  const at = (s) => new Date(Date.now() - 3600000 + s * 1000).toISOString();
  await fs.writeFile(path.join(folder, claudeId + '.jsonl'), [
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, entrypoint: 'cli', cwd: p.root, sessionId: claudeId, timestamp: at(0), message: { role: 'user', content: 'Plot ozone by month.' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, entrypoint: 'cli', cwd: p.root, sessionId: claudeId, timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'Rscript plot.R' } }], stop_reason: 'tool_use' } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', isSidechain: false, entrypoint: 'cli', cwd: p.root, sessionId: claudeId, timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'saved ozone.png' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', isSidechain: false, entrypoint: 'cli', cwd: p.root, sessionId: claudeId, timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: 'The plot is in ozone.png.' }], stop_reason: 'end_turn' } },
    { type: 'ai-title', aiTitle: 'Ozone by month', sessionId: claudeId }
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  // Another folder's session sharing the same projects folder name is not this project's.
  await fs.writeFile(path.join(folder, '11111111-2222-4333-8444-555555555555.jsonl'), JSON.stringify({ type: 'user', uuid: 'x', cwd: p.root + '-other', entrypoint: 'cli', timestamp: at(0), message: { role: 'user', content: 'Elsewhere' } }) + '\n');
  const day = path.join(codex, 'sessions', '2026', '11', '07'); await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, 'rollout-2026-11-07T01-00-00-' + codexId + '.jsonl'), [
    { timestamp: at(10), type: 'session_meta', payload: { id: codexId, cwd: p.root, originator: 'Codex Desktop' } },
    { timestamp: at(11), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: at(11), type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'UserMessage', id: 'um', content: [{ type: 'text', text: '# Files mentioned by the user:\n\n## My request:\nCount the rows.' }] } } },
    { timestamp: at(12), type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'CommandExecution', id: 'c1', command: ['/bin/zsh', '-lc', 'wc -l data.csv'], status: 'completed', exit_code: 0, aggregated_output: '154 data.csv' } } },
    { timestamp: at(13), type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'AgentMessage', id: 'am', content: [{ type: 'Text', text: '153 rows.' }] } } },
    { timestamp: at(13), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const call = (m, b = {}) => person.call(m, { projectId: p.id, ...b });
  const requests = async () => (await fs.readFile(process.env.PEER_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { root, config, p, call, requests, admin };
}
async function answered(call, conversationId) {
  for (let i = 0; i < 300; i++) {
    const read = await call('conversation.read', { conversationId }), last = read.turns.at(-1);
    if (last.state !== 'running') return read;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('The message was not answered.');
}
const hold = (config, sessionId) => fs.mkdir(path.join(config, 'sessions'), { recursive: true }).then(() => fs.writeFile(path.join(config, 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId, cwd: '', kind: 'interactive', entrypoint: 'cli', startedAt: Date.now() })));
const release = config => fs.rm(path.join(config, 'sessions', process.pid + '.json'), { force: true });

test('Agent sessions in the project folder are listed and read from the Agents\' own files, starting nothing', async t => {
  const { call, requests } = await setup(t);
  const { sessions } = await call('agent.sessions.list');
  const claude = sessions.find(s => s.producer === 'claude-code'), codex = sessions.find(s => s.producer === 'codex');
  assert.equal(sessions.length, 2, 'the other folder\'s session is not listed');
  assert.deepEqual({ title: claude.title, where: claude.where, continueWith: claude.continueWith, open: claude.open, state: claude.state }, { title: 'Ozone by month', where: 'Terminal', continueWith: 'claude-acp', open: null, state: 'completed' });
  assert.match(claude.resume, /claude --resume 0f1e2d3c-4b5a-4968-8776-655443322110$/);
  assert.deepEqual({ title: codex.title, where: codex.where, continueWith: codex.continueWith }, { title: 'Count the rows.', where: 'Codex app', continueWith: 'codex-acp' });
  const read = await call('agent.sessions.read', { session: claude.id });
  assert.deepEqual(read.turns.map(t => ({ prompt: t.prompt, reply: t.reply, state: t.state, where: t.where, tools: t.tools.map(x => [x.name, x.detail, x.outcome, x.output]) })),
    [{ prompt: 'Plot ozone by month.', reply: 'The plot is in ozone.png.', state: 'completed', where: 'Terminal', tools: [['Bash', 'Rscript plot.R', 'returned', 'saved ozone.png']] }]);
  const counted = await call('agent.sessions.read', { session: codex.id });
  assert.deepEqual(counted.turns.map(t => ({ prompt: t.prompt, reply: t.reply, tools: t.tools.map(x => [x.name, x.detail, x.exitCode]) })), [{ prompt: 'Count the rows.', reply: '153 rows.', tools: [['Command', 'wc -l data.csv', 0]] }]);
  assert.deepEqual(await requests(), [], 'no Agent was started to list or read');
  assert.equal((await call('conversation.list')).conversations.length, 0);
});

test('the next message continues the same session; a held session is refused unless continued as a copy', async t => {
  const { call, config, requests } = await setup(t);
  const listed = async producer => (await call('agent.sessions.list')).sessions.find(s => s.producer === producer && !s.conversationId);
  // Held open by a live interactive Claude Code: nothing is sent into it.
  await hold(config, claudeId);
  const held = await listed('claude-code');
  assert.deepEqual(held.open && { where: held.open.where, pid: held.open.pid }, { where: 'Terminal', pid: process.pid });
  await assert.rejects(call('conversation.start', { changeId: 'held', text: 'Go on.', continue: { session: held.id } }), e => e.error?.kind === 'condition' && /open in Terminal/.test(e.message));
  assert.deepEqual(await requests(), []);
  // A copy leaves the held session alone.
  const copy = await call('conversation.start', { changeId: 'copy', text: 'Go on in a copy.', continue: { session: held.id, copy: true } });
  const copied = await answered(call, copy.conversation.conversationId);
  assert.deepEqual(copied.conversation.origin, { producer: 'claude-code', where: 'Terminal', copyOf: claudeId });
  assert.equal(copied.conversation.sessionId, 'forked-' + claudeId);
  assert.equal(copied.conversation.title, 'Ozone by month');
  assert.ok((await requests()).some(r => r.method === 'session/fork' && r.sessionId === claudeId));
  assert.ok(!(await requests()).some(r => r.method === 'session/load' && r.sessionId === claudeId), 'the held session was not opened');
  // Released, it continues in place: the Agent loads that very session.
  await release(config);
  const free = await listed('claude-code');
  assert.equal(free.open, null);
  const started = await call('conversation.start', { changeId: 'same', text: 'Go on.', continue: { session: free.id } });
  const read = await answered(call, started.conversation.conversationId);
  assert.equal(read.conversation.sessionId, claudeId); assert.equal(read.conversation.origin.copyOf, undefined);
  assert.equal(read.turns.at(-1).steps.find(s => s.kind === 'text').text, 'Continued ' + claudeId);
  assert.ok((await requests()).some(r => r.method === 'session/load' && r.sessionId === claudeId));
  assert.equal((await call('agent.sessions.list')).sessions.find(s => s.sessionId === claudeId).conversationId, started.conversation.conversationId);
  await assert.rejects(call('conversation.start', { changeId: 'again', text: 'Again.', continue: { session: free.id } }), e => e.error?.kind === 'conflict');
  // Opened again in a terminal later, Rho does not write into it.
  await hold(config, claudeId);
  await assert.rejects(call('conversation.send', { conversationId: started.conversation.conversationId, changeId: 'later', text: 'More.' }), e => e.error?.kind === 'condition' && /open in Terminal/.test(e.message));
  await release(config);
  // A Codex session continues with Codex.
  const codex = await listed('codex');
  const viaCodex = await call('conversation.start', { changeId: 'codex', text: 'Go on.', continue: { session: codex.id } });
  const codexRead = await answered(call, viaCodex.conversation.conversationId);
  assert.equal(codexRead.conversation.client, 'codex'); assert.equal(codexRead.conversation.sessionId, codexId);
  // Codex's writer lock names no process. While Rho's own connection keeps the thread open, the
  // lock is that connection's: the next message goes on in the same session.
  const lock = path.join(process.env.CODEX_HOME, 'thread-writer-locks', codexId + '.lock');
  await fs.mkdir(path.dirname(lock), { recursive: true }); await fs.writeFile(lock, '');
  assert.equal((await call('agent.sessions.list')).sessions.find(s => s.sessionId === codexId).open, null);
  await call('conversation.send', { conversationId: viaCodex.conversation.conversationId, changeId: 'codex-next', text: 'More.' });
  assert.equal((await answered(call, viaCodex.conversation.conversationId)).turns.at(-1).state, 'completed');
  // Without that connection, a held thread is another window's.
  process.kill((await requests()).findLast(r => r.method === 'session/prompt').pid, 'SIGKILL');
  for (let i = 0; i < 200 && !(await call('agent.sessions.list')).sessions.find(s => s.sessionId === codexId).open; i++) await new Promise(r => setTimeout(r, 20));
  await assert.rejects(call('conversation.send', { conversationId: viaCodex.conversation.conversationId, changeId: 'codex-held', text: 'More.' }), e => e.error?.kind === 'condition' && /open in Codex/.test(e.message));
  await fs.rm(lock);
});
