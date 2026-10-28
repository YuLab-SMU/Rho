import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RhoService } from '../dist/server.js';
import { CheckedClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';

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
  return { service, call,
    async calls() { return (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse); },
    async record(id) { return JSON.parse(await fs.readFile(path.join(project.root, '.rho/rho/conversations', id + '.json'), 'utf8')); },
    async until(read, predicate) { for (let i = 0; i < 200; i++) { const r = await read(); if (predicate(r)) return r; await new Promise(r => setTimeout(r, 15)); } throw new Error('Condition not reached.'); }
  };
}
const ended = r => r.turns.at(-1).state !== 'running';
const current = (holder, id) => (holder.config ?? holder).options.find(o => o.id === id).current;

test('Agent settings are offered, chosen, applied before the first message and changed between messages', async () => {
  const root = await fs.mkdtemp('/tmp/rho-agent-settings-'), f = await setup(root);
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
