import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RhoService } from '../dist/server.js';
import { CheckedClient } from './checked-client.mjs';
import { ExternalAcpObserver, readExternalAcp } from '@rho-workspace/plugin-agent/external-acp';
import { BrowserClient } from '../dist/browser.js';

// Independent protocol peer for application identity/storage/authorization checks.
const peer = `import fs from 'node:fs';
import {createInterface} from 'node:readline';
const log=v=>fs.appendFileSync(process.env.RHO_ACP_TEST_LOG,JSON.stringify(v)+'\\n');
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
let active, permission;
log({kind:'process',pid:process.pid});
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),p=r.params,reply=result=>out({id:r.id,result});
 const update=update=>out({method:'session/update',params:{sessionId:'kept-session',update}});
 if(!r.method){log({kind:'choice',value:r.result});if(permission){out({id:permission,result:{stopReason:'end_turn'}});permission=null;}return;}
 log({kind:r.method,sessionId:p?.sessionId,text:p?.prompt?.[0]?.text,mcp:p?.mcpServers?.[0]?.env?.find(x=>x.name==='RHO_AGENT_CONNECTION')?.value});
 if(r.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(r.method==='session/new')return reply({sessionId:'kept-session'});
 if(r.method==='session/load'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'HISTORY'}});return reply({});}
 if(r.method==='session/cancel'){if(active)out({id:active,result:{stopReason:'cancelled'}});active=null;permission=null;return;}
 if(r.method==='session/prompt'){
  active=r.id;const text=p.prompt[0].text;update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'kept '+text},messageId:'answer'});
  if(text==='observe'){
    update({sessionUpdate:'tool_call',toolCallId:'notes',title:'Read',status:'completed',locations:[{path:process.cwd()+'/project-notes.md'}]});
    update({sessionUpdate:'plan',entries:[{content:'Initial plan',status:'in_progress',priority:'medium'}]});
    setTimeout(()=>update({sessionUpdate:'plan',entries:[{content:'Idle replacement 你好',status:'completed',priority:'medium'}]}),100);
  }
  if(text==='write'){fs.mkdirSync('results',{recursive:true});fs.writeFileSync('results/out.csv','a\\n1\\n');fs.rmSync('old.txt',{force:true});}
  if(text==='drop')return process.exit(7);
  if(text==='wait')return;
  if(text==='permission'){permission=r.id;out({id:'permission',method:'session/request_permission',params:{sessionId:'kept-session',toolCall:{toolCallId:'write',title:'Write notes',rawInput:{file_path:'notes.txt'}},options:[{optionId:'yes',kind:'allow_once',name:'Allow once'},{optionId:'no',kind:'reject_once',name:'Reject'}]}});return;}
  active=null;return reply({stopReason:'end_turn'});
 }
});`;
async function setup(root, budgets = {}) {
  const file = path.join(root, 'peer.mjs'), log = path.join(root, 'calls.jsonl');
  await fs.writeFile(file, peer); await fs.mkdir(path.join(root, 'project'), { recursive: true });
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: path.join(root, 'absent-core'), rscript: 'Rscript',
    codexAcp: { command: { file: process.execPath, args: [file] }, env: { RHO_ACP_TEST_LOG: log } },
    claudeAcp: { command: { file: process.execPath, args: [file] }, env: { RHO_ACP_TEST_LOG: log } }, conversations: { stopGraceMs: 200, ...budgets } }).start();
  const operator = new CheckedClient({ url: service.url, token: service.adminToken }), person = new BrowserClient({ url: service.url });
  const project = await operator.call('project.open', { path: 'project' });
  return { service, operator, person, project,
    call: (method, body) => person.call(method, { projectId: project.id, ...body }),
    async calls() { return (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse); },
    async record(id) { return JSON.parse(await fs.readFile(path.join(project.root, '.rho/rho/conversations', id + '.json'), 'utf8')); },
    async wait(id, predicate) { for (let i = 0; i < 200; i++) { const r = await person.call('conversation.read', { projectId: project.id, conversationId: id }); if (predicate(r)) return r; await new Promise(r => setTimeout(r, 15)); } throw new Error('ACP conversation did not reach expected state'); }
  };
}
const ended = r => r.turns.at(-1).state !== 'running';
test('Rho keeps ACP message identities, one grant per connection and the original session across loss/restart', async () => {
  const root = await fs.mkdtemp('/tmp/rho-acp-ledger-'); let f = await setup(root);
  try {
    const first = await f.call('conversation.start', { changeId: 'first', text: 'hello 你好' }), id = first.conversation.conversationId;
    await f.wait(id, ended);
    const session = (await f.record(id)).acpSessionId;
    assert.equal(session, 'kept-session'); assert.equal((await f.record(id)).nativeSessionId, null);
    const file = (await f.calls()).find(x => x.kind === 'session/new').mcp, grant = await fs.readFile(file, 'utf8');
    await f.call('conversation.send', { conversationId: id, changeId: 'second', text: 'second' }); await f.wait(id, ended);
    assert.equal(await fs.readFile(file, 'utf8'), grant, 'a persistent MCP process keeps its original credential');
    assert.equal((await f.calls()).filter(x => x.kind === 'process').length, 1);
    assert.equal((await f.call('conversation.start', { changeId: 'first', text: 'hello 你好' })).conversation.conversationId, id);
    await assert.rejects(f.call('conversation.send', { conversationId: id, changeId: 'second', text: 'changed' }), e => e.error.kind === 'conflict');
    await f.call('conversation.send', { conversationId: id, changeId: 'lost', text: 'drop' });
    const lost = await f.wait(id, ended); assert.equal(lost.turns.at(-1).state, 'unknown'); assert.match(lost.turns.at(-1).steps[0].text, /kept drop/);
    await f.call('conversation.send', { conversationId: id, changeId: 'lost', text: 'drop' });
    assert.equal((await f.calls()).filter(x => x.kind === 'session/prompt').length, 3);
    await f.service.close(); f = await setup(root);
    assert.equal((await f.call('conversation.read', { conversationId: id })).turns.at(-1).state, 'unknown');
    assert.equal((await f.calls()).filter(x => x.kind === 'process').length, 1, 'reads after restart start nothing');
    await f.call('conversation.send', { conversationId: id, changeId: 'next', text: 'continue explicitly' });
    const recovered = await f.wait(id, ended);
    assert.equal(recovered.turns.length, 4); assert.equal(recovered.turns.at(-1).state, 'completed');
    assert.ok(!JSON.stringify(recovered).includes('HISTORY'));
    assert.equal((await f.record(id)).acpSessionId, session);
    assert.equal((await f.calls()).filter(x => x.kind === 'session/new').length, 1);
    assert.deepEqual((await f.calls()).filter(x => x.kind === 'session/load').map(x => x.sessionId), [session]);
    await assert.rejects(fs.stat(path.join(f.project.root, '.rho/host.sock')), { code: 'ENOENT' });
  } finally { await f.service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
test('project work links session reports to current files and the single notes buffer; reads never connect', async () => {
  const root = await fs.mkdtemp('/tmp/rho-acp-work-'); let f = await setup(root, { idleMs: 500 });
  try {
    const empty = await f.call('project.work.read', {});
    assert.deepEqual(empty.sessions, []); assert.equal(empty.native.state, 'unavailable'); assert.equal((await f.calls()).length, 0);
    const note = await f.call('project.openFile', { path: 'project-notes.md', compositionId: 'notes', expectedVersion: 0, changeId: 'open-notes' });
    const again = await f.call('project.openFile', { path: 'project-notes.md', compositionId: 'notes', expectedVersion: note.composition.version, changeId: 'open-again' });
    assert.equal(note.document.id, again.document.id); assert.equal(note.viewId, again.viewId);
    await fs.writeFile(path.join(f.project.root, 'project-notes.md'), 'Human instruction 你好');
    const started = await f.call('conversation.start', { changeId: 'observe', text: 'observe' }), id = started.conversation.conversationId;
    const idle = await f.wait(id, r => r.observation?.plan?.entries[0]?.content === 'Idle replacement 你好');
    assert.equal(idle.turns.length, 1); assert.equal(idle.turns[0].state, 'completed'); assert.equal(idle.observation.connected, true);
    const work = await f.call('project.work.read', {});
    assert.equal(work.sessions[0].conversationId, id); assert.equal(work.notes.documentId, note.document.id);
    assert.equal(work.files[0].state, 'observed'); assert.equal(work.files[0].references[0].session, work.sessions[0].id);
    assert.equal(work.sessions[0].observation.plan.entries[0].content, 'Idle replacement 你好');
    await f.call('conversation.send', { conversationId: id, changeId: 'next', text: 'next' }); await f.wait(id, ended);
    await f.wait(id, r => !r.observation.connected);
    assert.equal((await f.record(id)).turns.length, 2, 'idle projection flush cannot overwrite a newer turn');
    // Operator access is deliberately insufficient for a local person's conversation.
    await assert.rejects(f.operator.call('project.work.read', { projectId: f.project.id }));
    await f.service.close(); f = await setup(root);
    const before = (await f.calls()).length, retained = await f.call('project.work.read', {});
    assert.equal(retained.sessions[0].observation.connected, false); assert.equal((await f.calls()).length, before);
    assert.equal(retained.sessions[0].observation.plan.entries[0].content, 'Idle replacement 你好');
  } finally { await f.service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
test('a message records the project files that changed on disk while it ran, and says when the comparison was partial', async () => {
  const root = await fs.mkdtemp('/tmp/rho-acp-files-'); let f = await setup(root);
  try {
    await fs.writeFile(path.join(f.project.root, 'old.txt'), 'old'); await fs.writeFile(path.join(f.project.root, 'kept.txt'), 'kept');
    const id = (await f.call('conversation.start', { changeId: 'files', text: 'write' })).conversation.conversationId;
    const files = (await f.wait(id, ended)).turns.at(-1).files;
    assert.deepEqual(files.changed.map(c => [c.path, c.change, c.bytes]), [['results/out.csv', 'added', 4], ['old.txt', 'removed', null]]);
    assert.equal(files.partial, false); assert.equal(files.omitted, 0);
    await f.service.close();
    f = await setup(root, { maxComparedFiles: 1 });
    await fs.writeFile(path.join(f.project.root, 'old.txt'), 'again');
    const next = (await f.call('conversation.start', { changeId: 'partial', text: 'write' })).conversation.conversationId;
    const partial = (await f.wait(next, ended)).turns.at(-1).files;
    assert.equal(partial.partial, true, 'a comparison stopped at its limit says so');
    assert.ok(partial.changed.every(c => c.change !== 'removed'), 'nothing is called removed from a partial comparison');
  } finally { await f.service.close(); }
});

test('a conversation in the trash is kept whole, frees its place, cannot be continued, and is deleted only from there', async () => {
  const root = await fs.mkdtemp('/tmp/rho-acp-trash-'); let f = await setup(root, { maxConversations: 2 });
  try {
    const first = (await f.call('conversation.start', { changeId: 'trash-1', text: 'hello' })).conversation.conversationId;
    await f.wait(first, ended);
    const second = (await f.call('conversation.start', { changeId: 'trash-2', text: 'wait' })).conversation.conversationId;
    // A list carries what a row shows without reading each record.
    const listed = (await f.call('conversation.list', {})).conversations.find(c => c.conversationId === first);
    assert.equal(listed.backend, 'claude-acp'); assert.equal(listed.trashedAt, null); assert.ok('usage' in listed && 'sessionId' in listed);
    await assert.rejects(f.call('conversation.start', { changeId: 'trash-3', text: 'hello' }), e => e.error?.kind === 'limit');
    await assert.rejects(f.call('conversation.trash', { conversationId: second }), e => e.error?.kind === 'conflict', 'not while the Agent answers');
    await assert.rejects(f.call('conversation.delete', { conversationId: first }), e => e.error?.kind === 'conflict', 'only from the trash');
    const trashed = await f.call('conversation.trash', { conversationId: first });
    assert.ok(trashed.conversation.trashedAt);
    assert.deepEqual((await f.call('conversation.list', {})).conversations.map(c => c.conversationId), [second]);
    assert.deepEqual((await f.call('conversation.list', { trashed: true })).conversations.map(c => c.conversationId), [first]);
    assert.ok(!(await f.person.call('observation.snapshot', { projectId: f.project.id })).conversations.some(c => c.conversationId === first), 'the project no longer lists it');
    assert.equal((await f.call('conversation.read', { conversationId: first })).turns.length, 1, 'kept whole');
    await assert.rejects(f.call('conversation.send', { conversationId: first, changeId: 'again', text: 'more' }), e => e.error?.kind === 'conflict');
    const third = (await f.call('conversation.start', { changeId: 'trash-3', text: 'hello' })).conversation.conversationId;
    await f.wait(third, ended);
    await assert.rejects(f.call('conversation.restore', { conversationId: first }), e => e.error?.kind === 'limit', 'restoring respects the limit');
    await f.call('conversation.trash', { conversationId: third });
    assert.equal((await f.call('conversation.restore', { conversationId: first })).conversation.trashedAt, null);
    const deleted = await f.call('conversation.delete', { conversationId: third });
    assert.deepEqual(deleted, { conversationId: third, deleted: true });
    await assert.rejects(f.call('conversation.read', { conversationId: third }), e => e.error?.kind === 'not_found');
    await assert.rejects(f.call('conversation.start', { changeId: 'trash-3', text: 'hello' }), e => e.error?.kind === 'conflict', 'the deleted request is not started again');
    await f.call('conversation.stop', { conversationId: second, turnId: 't1' });
    await f.wait(second, ended);
  } finally { await f.service.close(); }
});

test('Agent permission choices are scoped, conditional, retained, and cancelled with the original turn', async () => {
  const root = await fs.mkdtemp('/tmp/rho-acp-choice-'), f = await setup(root);
  try {
    const first = await f.call('conversation.start', { changeId: 'first', text: 'permission' }), id = first.conversation.conversationId;
    const waiting = await f.wait(id, r => r.turns[0].permissions?.length), p = waiting.turns[0].permissions[0];
    assert.equal(p.details, 'notes.txt');
    const choice = { conversationId: id, turnId: 't1', permissionId: p.id, optionId: 'yes' };
    await assert.rejects(f.operator.call('conversation.permission', { projectId: f.project.id, ...choice }), e => e.error.kind === 'unauthorized');
    await assert.rejects(f.call('conversation.permission', { ...choice, optionId: 'forged' }), e => e.error.kind === 'invalid');
    // An actual failed atomic replace must not acknowledge or forward a choice.
    // Once storage recovers, the same user action can still complete exactly once.
    const file = path.join(f.project.root, '.rho/rho/conversations', id + '.json');
    await fs.rename(file, file + '.saved'); await fs.mkdir(file);
    await assert.rejects(f.call('conversation.permission', choice));
    assert.equal((await f.call('conversation.read', { conversationId: id })).turns[0].permissions[0].state, 'pending');
    assert.equal((await f.calls()).filter(x => x.kind === 'choice').length, 0);
    await fs.rmdir(file); await fs.rename(file + '.saved', file);
    await f.call('conversation.permission', choice); await f.wait(id, ended); await f.call('conversation.permission', choice);
    await assert.rejects(f.call('conversation.permission', { ...choice, optionId: 'no' }), e => e.error.kind === 'conflict');
    assert.equal((await f.calls()).filter(x => x.kind === 'choice').length, 1);
    await f.call('conversation.send', { conversationId: id, changeId: 'second', text: 'permission' });
    await f.wait(id, r => r.turns.at(-1).permissions?.length);
    await f.call('conversation.stop', { conversationId: id, turnId: 't2' });
    const stopped = await f.wait(id, ended);
    assert.equal(stopped.turns.at(-1).state, 'stopped'); assert.equal(stopped.turns.at(-1).result.reason, 'cancelled');
    assert.equal(stopped.turns.at(-1).permissions[0].state, 'cancelled');
  } finally { await f.service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
test('connection capacity releases idle Agents without losing conversations or starting them on reads', async () => {
  const root = await fs.mkdtemp('/tmp/rho-acp-cap-'), f = await setup(root, { maxConnections: 1 });
  try {
    const a = (await f.call('conversation.start', { changeId: 'a', text: 'first' })).conversation.conversationId; await f.wait(a, ended);
    const b = (await f.call('conversation.start', { changeId: 'b', text: 'second' })).conversation.conversationId; await f.wait(b, ended);
    assert.equal((await f.calls()).filter(x => x.kind === 'process').length, 2);
    await f.call('conversation.read', { conversationId: a });
    assert.equal((await f.calls()).filter(x => x.kind === 'process').length, 2);
    await f.call('conversation.send', { conversationId: a, changeId: 'c', text: 'after eviction' }); await f.wait(a, ended);
    assert.equal((await f.calls()).filter(x => x.kind === 'session/load').length, 1);
  } finally { await f.service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a selected Codex backend survives restart and cannot change under an existing message identity', async () => {
  const root = await fs.mkdtemp('/tmp/rho-codex-ledger-'); let f = await setup(root);
  try {
    const input = { changeId: 'codex', text: 'hello', backend: 'codex-acp' };
    const first = await f.call('conversation.start', input), id = first.conversation.conversationId;
    assert.equal(first.conversation.client, 'codex'); await f.wait(id, ended);
    assert.equal((await f.record(id)).backend, 'codex-acp');
    assert.equal((await f.call('conversation.start', input)).conversation.conversationId, id);
    await assert.rejects(f.call('conversation.start', { ...input, backend: 'claude-acp' }), e => e.error.kind === 'conflict');
    await f.service.close(); f = await setup(root);
    await f.call('conversation.send', { conversationId: id, changeId: 'next', text: 'continue' }); await f.wait(id, ended);
    assert.equal((await f.calls()).filter(c => c.kind === 'session/new').length, 1);
    assert.equal((await f.calls()).filter(c => c.kind === 'session/load').length, 1);
    assert.equal((await f.call('project.work.read', {})).sessions[0].agent, 'codex');
  } finally { await f.service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
test('external ACP joins the project read without acquiring input or runtime ownership', async () => {
  const root = await fs.mkdtemp('/tmp/rho-external-app-'); let f = await setup(root), external;
  try {
    external = new ExternalAcpObserver(f.project.root, 'codex');
    external.client({ id: 1, method: 'session/new', params: { cwd: f.project.root } });
    external.agentMessage({ id: 1, result: { sessionId: 'external-session' } });
    const work = await f.call('project.work.read', {}), entry = work.sessions[0];
    assert.equal(entry.source, 'external-acp'); assert.equal(entry.conversationId, undefined); assert.equal(entry.observation.connected, true);
    assert.equal((await f.call('observation.snapshot', {})).conversations.length, 0);
    await assert.rejects(f.call('conversation.send', { conversationId: entry.id, changeId: 'no', text: 'must not run' }));
    await f.service.close(); assert.equal(readExternalAcp(f.project.root).sessions[0].connected, true);
    f = await setup(root); assert.equal((await f.call('project.work.read', {})).sessions[0].id, entry.id); assert.equal((await f.calls()).length, 0);
  } finally { external?.close(); await f.service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
