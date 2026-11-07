import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';
import { observeDshSession } from '@rho-workspace/plugin-agent/dsh-session';
// A Unix Host's socket lies under its project, within the socket path limit; Windows Hosts use pipes.
const shortTemp = process.platform === 'win32' ? tmpdir() : '/tmp';

// An ACP peer that offers a model and an effort setting, and answers with the model in use.
const peer = `import fs from 'node:fs';
import {createInterface} from 'node:readline';
const log=v=>fs.appendFileSync(process.env.RHO_ACP_TEST_LOG,JSON.stringify(v)+'\\n');
const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const settings=[
 {id:'model',name:'Model',category:'model',type:'select',currentValue:'default-model',options:[{group:'local',name:'Local',options:[{value:'default-model',name:'Default model'},{value:'fast-model',name:'Fast model'}]},{group:'lab',name:'Lab',options:[{value:'lab/large',name:'Lab large'}]}]},
 {id:'effort',name:'Effort',category:'thought_level',type:'select',currentValue:'high',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]}];
let n=0;
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),p=r.params,reply=result=>out({id:r.id,result});
 if(!r.method)return;
 log({kind:r.method,sessionId:p?.sessionId,configId:p?.configId,value:p?.value,text:p?.prompt?.[0]?.text});
 if(r.method==='initialize')return reply({protocolVersion:1,agentInfo:{name:'test-agent',version:'1.0.0'},agentCapabilities:{loadSession:true,sessionCapabilities:{close:{},delete:{}}}});
 if(r.method==='session/new')return reply({sessionId:'s-'+(++n),configOptions:settings});
 if(r.method==='session/load')return reply({configOptions:settings});
 if(r.method==='session/set_config_option'){settings.find(x=>x.id===p.configId).currentValue=p.value;return reply({configOptions:settings});}
 if(r.method==='session/delete'||r.method==='session/close')return reply({});
 if(r.method==='session/prompt'){
  out({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'model '+settings[0].currentValue},messageId:'a'}}});
  return reply({stopReason:'end_turn'});
 }
});`;
async function setup(root) {
  const file = path.join(root, 'peer.mjs'), log = path.join(root, 'calls.jsonl');
  await fs.writeFile(file, peer); await fs.mkdir(path.join(root, 'project'), { recursive: true });
  const agent = { command: { file: process.execPath, args: [file] }, env: { RHO_ACP_TEST_LOG: log } };
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: path.join(root, 'absent-core'), rscript: 'Rscript', claudeAcp: agent, codexAcp: agent }).start();
  const operator = new CheckedClient({ url: service.url, token: service.adminToken }), person = new BrowserClient({ url: service.url });
  const project = await operator.call('project.open', { path: 'project' });
  const call = (method, body = {}) => person.call(method, { projectId: project.id, ...body });
  return { service, call, project,
    async calls() { return (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse); },
    async record(id) { return JSON.parse(await fs.readFile(path.join(project.root, '.rho/rho/conversations', id + '.json'), 'utf8')); },
    async until(read, predicate) { for (let i = 0; i < 200; i++) { const r = await read(); if (predicate(r)) return r; await new Promise(r => setTimeout(r, 15)); } throw new Error('Condition not reached.'); }
  };
}
const ended = r => r.turns.at(-1).state !== 'running';
const current = (holder, id) => (holder.config ?? holder).options.find(o => o.id === id).current;

test('Agent settings are offered, chosen, applied before the first message and changed between messages', async () => {
  const root = await fs.mkdtemp(path.join(shortTemp, 'rho-agent-settings-')), f = await setup(root);
  try {
    let settings = await f.call('conversation.settings.read');
    assert.deepEqual([settings.version, settings.backend, settings.serviceBackend, settings.offered], [0, null, 'claude-acp', {}]);
    assert.equal((await f.calls()).length, 0, 'reading the settings starts nothing');
    await assert.rejects(f.call('conversation.settings.update', { expectedVersion: 0, choices: { 'claude-acp': { model: 'fast-model' } } }), e => e.error.kind === 'unavailable');

    // A first conversation without choices shows what the Agent offers by default.
    const plain = await f.call('conversation.start', { changeId: 'plain', text: 'hello' }), plainId = plain.conversation.conversationId;
    await f.until(() => f.call('conversation.read', { conversationId: plainId }), ended);
    settings = await f.until(() => f.call('conversation.settings.read'), s => !!s.offered['claude-acp']);
    assert.equal(settings.offered['claude-acp'].source, 'conversation');
    assert.deepEqual(settings.offered['claude-acp'].options[0].values.map(v => [v.value, v.group]), [['default-model', 'Local'], ['fast-model', 'Local'], ['lab/large', 'Lab']]);

    // A check opens a session, reads its settings, removes it and sends nothing.
    const before = (await f.calls()).length;
    settings = await f.call('conversation.settings.check', { backend: 'codex-acp' });
    const check = (await f.calls()).slice(before).map(x => x.kind);
    assert.deepEqual(check, ['initialize', 'session/new', 'session/delete']);
    assert.equal(settings.offered['codex-acp'].source, 'check');
    assert.deepEqual(settings.offered['codex-acp'].adapter, { name: 'test-agent', version: '1.0.0' });
    assert.equal(current(settings.offered['codex-acp'], 'model'), 'default-model');
    assert.deepEqual(settings.checking, []);

    settings = await f.call('conversation.settings.update', { expectedVersion: 0, backend: 'codex-acp', choices: { 'codex-acp': { model: 'lab/large', effort: 'low' } } });
    assert.deepEqual([settings.version, settings.backend, settings.choices['codex-acp']], [1, 'codex-acp', { model: 'lab/large', effort: 'low' }]);
    await assert.rejects(f.call('conversation.settings.update', { expectedVersion: 0, backend: null }), e => e.error.kind === 'conflict');
    await assert.rejects(f.call('conversation.settings.update', { expectedVersion: 1, choices: { 'codex-acp': { model: 'absent' } } }), e => e.error.kind === 'invalid' && /does not offer absent/.test(e.error.message));

    // A new conversation uses the saved Agent and settings, applied before the message is sent.
    const mark = (await f.calls()).length;
    const chosen = await f.call('conversation.start', { changeId: 'chosen', text: 'which model' }), id = chosen.conversation.conversationId;
    let read = await f.until(() => f.call('conversation.read', { conversationId: id }), ended);
    assert.equal(chosen.conversation.client, 'codex');
    assert.deepEqual(read.config, { model: 'lab/large', effort: 'low' });
    assert.equal(read.turns[0].model, 'lab/large');
    assert.match(read.turns[0].steps.find(s => s.kind === 'text').text, /model lab\/large/);
    const order = (await f.calls()).slice(mark).map(x => x.kind + (x.configId ? ':' + x.configId : ''));
    assert.ok(order.indexOf('session/set_config_option:model') < order.indexOf('session/prompt'), order.join(' '));
    assert.equal(current(read.observation, 'effort'), 'low');

    // Between messages, an open session changes now and the next message uses it.
    const changed = await f.call('conversation.configure', { conversationId: id, configId: 'model', value: 'fast-model' });
    assert.equal(current(changed.observation, 'model'), 'fast-model');
    assert.deepEqual(changed.config, { model: 'fast-model', effort: 'low' });
    await assert.rejects(f.call('conversation.configure', { conversationId: id, configId: 'model', value: 'absent' }), e => e.error.kind === 'invalid');
    await f.call('conversation.send', { conversationId: id, changeId: 'next', text: 'which model' });
    read = await f.until(() => f.call('conversation.read', { conversationId: id }), r => r.turns.length === 2 && ended(r));
    assert.equal(read.turns[1].model, 'fast-model');
    assert.deepEqual((await f.record(id)).config, { model: 'fast-model', effort: 'low' });
    assert.equal((await f.call('conversation.settings.read')).choices['codex-acp'].model, 'lab/large', 'a conversation\'s change leaves the defaults');

    // A closed session records the choice and applies it when the session opens again.
    await f.service.close();
    const g = await setup(root);
    try {
      const closed = await g.call('conversation.configure', { conversationId: id, configId: 'model', value: 'lab/large' });
      assert.equal(closed.observation.connected, false);
      assert.deepEqual(closed.config, { model: 'lab/large', effort: 'low' });
      const start = (await g.calls()).length;
      await g.call('conversation.send', { conversationId: id, changeId: 'after', text: 'which model' });
      read = await g.until(() => g.call('conversation.read', { conversationId: id }), r => r.turns.length === 3 && ended(r));
      assert.equal(read.turns[2].model, 'lab/large');
      const applied = (await g.calls()).slice(start).filter(x => x.kind === 'session/set_config_option').map(x => x.configId + '=' + x.value);
      assert.deepEqual(applied, ['model=lab/large', 'effort=low']);
    } finally { await g.service.close(); }
  } finally { await f.service.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); }
});

test('an ACP Agent added in Rho is checked once, offered for new conversations and kept by its conversations after removal', async () => {
  const root = await fs.mkdtemp(path.join(shortTemp, 'rho-agent-added-')), f = await setup(root);
  const saved = { log: process.env.RHO_ACP_TEST_LOG, path: process.env.PATH };
  // The added Agent runs with the service's own environment, as a person's installed Agent does.
  process.env.RHO_ACP_TEST_LOG = path.join(root, 'calls.jsonl');
  const peer = [process.execPath, path.join(root, 'peer.mjs')];
  try {
    let settings = await f.call('conversation.settings.read');
    assert.deepEqual(settings.added, []);
    assert.equal((await f.calls()).length, 0, 'reading the settings starts nothing');

    // A program Rho cannot find, or one that does not answer as an ACP Agent, is not added.
    await assert.rejects(f.call('conversation.agents.add', { command: ['rho-absent-agent-program', 'acp'] }), e => e.error.kind === 'unavailable' && /not found on PATH/.test(e.error.message));
    await assert.rejects(f.call('conversation.agents.add', { command: [process.execPath, '-e', 'process.exit(0)'] }), e => e.error.kind === 'unavailable' && /did not start as an ACP Agent .*Nothing was added\.$/.test(e.error.message));
    assert.deepEqual((await f.call('conversation.settings.read')).added, []);

    // Adding starts it once (a session opened and removed, nothing sent) and keeps what it offered.
    const before = (await f.calls()).length;
    settings = await f.call('conversation.agents.add', { command: peer });
    assert.deepEqual((await f.calls()).slice(before).map(x => x.kind), ['initialize', 'session/new', 'session/delete']);
    assert.equal(settings.added.length, 1);
    const [added] = settings.added, which = added.backend;
    assert.deepEqual([which, added.name, added.command], ['acp:test-agent', 'test-agent', peer]);
    assert.equal(settings.offered[which].source, 'check');
    assert.deepEqual(settings.agents[which], { found: true, name: 'test-agent' });
    // The same command again is checked again, not added twice.
    settings = await f.call('conversation.agents.add', { command: peer });
    assert.deepEqual(settings.added.map(a => a.backend), [which]);

    await assert.rejects(f.call('conversation.settings.update', { expectedVersion: settings.version, backend: 'acp:not-added' }), e => e.error.kind === 'invalid');
    settings = await f.call('conversation.settings.update', { expectedVersion: settings.version, backend: which, choices: { [which]: { model: 'fast-model' } } });
    assert.equal(settings.backend, which);

    // A new conversation uses it, and its record keeps the command it started with.
    const started = await f.call('conversation.start', { changeId: 'added', text: 'which model' }), id = started.conversation.conversationId;
    assert.deepEqual([started.conversation.client, started.conversation.backend], ['acp', which]);
    let read = await f.until(() => f.call('conversation.read', { conversationId: id }), ended);
    assert.match(read.turns[0].steps.find(s => s.kind === 'text').text, /model fast-model/);
    assert.deepEqual((await f.record(id)).acpCommand, { file: peer[0], args: peer.slice(1) });

    // Removing it takes it out of new conversations; its conversation continues with its own command.
    settings = await f.call('conversation.agents.remove', { backend: which });
    assert.deepEqual([settings.added, settings.backend, settings.offered[which], settings.agents[which]], [[], null, undefined, undefined]);
    await assert.rejects(f.call('conversation.agents.remove', { backend: which }), e => e.error.kind === 'not_found');
    await assert.rejects(f.call('conversation.start', { changeId: 'gone', text: 'hello', backend: which }), e => e.error.kind === 'unavailable' && /not added in Rho/.test(e.error.message));
    await f.service.close();
    const g = await setup(root);
    try {
      await g.call('conversation.send', { conversationId: id, changeId: 'after', text: 'which model' });
      read = await g.until(() => g.call('conversation.read', { conversationId: id }), r => r.turns.length === 2 && ended(r));
      assert.equal(read.turns[1].state, 'completed');
    } finally { await g.service.close(); }

    // An Agent Rho knows is listed when its program is on PATH, with the command it starts as.
    if (process.platform !== 'win32') {
      const bin = path.join(root, 'bin'); await fs.mkdir(bin);
      await fs.writeFile(path.join(bin, 'hermes'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.PATH = bin + path.delimiter + saved.path;
      const h = await setup(root);
      try {
        const listed = (await h.call('conversation.settings.read')).installed.find(a => a.id === 'hermes');
        assert.deepEqual(listed, { id: 'hermes', name: 'Hermes Agent', command: [path.join(bin, 'hermes'), 'acp'] });
      } finally { await h.service.close(); }
    }
  } finally {
    if (saved.log === undefined) delete process.env.RHO_ACP_TEST_LOG; else process.env.RHO_ACP_TEST_LOG = saved.log;
    process.env.PATH = saved.path;
    await f.service.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true });
  }
});

// A Harness session in the project folder continues in Rho only through Harness's own ACP
// command: added in Rho, or named when Rho started. Another ACP command does not continue it.
test('a DeepSeek Harness session continues with an added Harness, never with another ACP Agent', { skip: process.platform === 'win32' && 'a POSIX launcher stands in for dsh' }, async () => {
  const root = await fs.mkdtemp(path.join(shortTemp, 'rho-agent-harness-')), f = await setup(root);
  const saved = process.env.RHO_ACP_TEST_LOG;
  process.env.RHO_ACP_TEST_LOG = path.join(root, 'calls.jsonl');
  try {
    const project = f.project;
    const events = [['turn/start', { turn: 1 }], ['user/message', { source: { kind: 'user' }, content: 'Count rows' }], ['turn/end', { turn: 1, reason: { kind: 'completed' } }]].map(([type, data], seq) => ({ seq, type, data, time: 1000 + seq }));
    observeDshSession(project.root, { version: 4, id: 'harness-conversation', cwd: project.root, createdAt: 1000 }, events);
    const harness = async () => (await f.call('agent.sessions.list')).sessions.find(s => s.sessionId === 'harness-conversation');
    assert.equal((await harness()).continueWith, null);
    // A stand-in for Harness's launcher, answering ACP as `dsh acp`.
    const bin = path.join(root, 'bin'); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'dsh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'peer.mjs')}"\n`, { mode: 0o755 });
    const settings = await f.call('conversation.agents.add', { command: [path.join(bin, 'dsh'), 'acp'] });
    assert.deepEqual(settings.added.map(a => [a.backend, a.name]), [['acp:dsh', 'DeepSeek Harness']]);
    assert.equal((await harness()).continueWith, 'acp:dsh');
    await f.call('conversation.agents.remove', { backend: 'acp:dsh' });
    assert.equal((await harness()).continueWith, null);
  } finally {
    if (saved === undefined) delete process.env.RHO_ACP_TEST_LOG; else process.env.RHO_ACP_TEST_LOG = saved;
    await f.service.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true });
  }
  // A service started with another ACP command does not hand Harness's sessions to it.
  const other = await fs.mkdtemp(path.join(shortTemp, 'rho-agent-other-'));
  await fs.mkdir(path.join(other, 'project'));
  const service = await new RhoService({ root: other, stateDir: path.join(other, '.service'), coreBinary: path.join(other, 'absent-core'), rscript: 'Rscript', acpCommand: { file: path.join(other, 'opencode'), args: ['acp'] } }).start();
  try {
    const project = await new CheckedClient({ url: service.url, token: service.adminToken }).call('project.open', { path: 'project' });
    observeDshSession(project.root, { version: 4, id: 'harness-conversation', cwd: project.root, createdAt: 1000 }, [{ seq: 0, type: 'turn/start', data: { turn: 1 }, time: 1000 }, { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 1001 }]);
    const listed = await new BrowserClient({ url: service.url }).call('agent.sessions.list', { projectId: project.id });
    assert.equal(listed.sessions.find(s => s.sessionId === 'harness-conversation').continueWith, null);
  } finally { await service.close(); await fs.rm(other, { recursive: true, force: true }); }
});
