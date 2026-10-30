import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RhoService } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { RhoClient } from '../dist/client.js';

// An Agent whose table gains a column with each message.
const peer = `import fs from 'node:fs';import readline from 'node:readline';let n=0;const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
readline.createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l),reply=result=>out({id:r.id,result});
if(r.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true}});if(r.method==='session/new')reply({sessionId:'test'});if(r.method==='session/load')reply({});
if(r.method==='session/prompt'){n++;const cols=Array.from({length:n+1},(_,i)=>'c'+i);fs.writeFileSync('t.csv',cols.join(',')+'\\n'+cols.map((_,i)=>i).join(',')+'\\n');
out({method:'session/update',params:{sessionId:'test',update:{sessionUpdate:'tool_call',toolCallId:'w'+n,title:'Write',kind:'edit',status:'completed',locations:[{path:process.cwd()+'/t.csv'}],rawInput:{file_path:process.cwd()+'/t.csv'}}}});reply({stopReason:'end_turn'});}});`;

test('a table version whose columns changed is declared from its own header, so every kept version pages', async () => {
  const root = await fs.mkdtemp('/tmp/rho-capture-columns-'); let service;
  try {
    await fs.writeFile(path.join(root, 'peer.mjs'), peer); await fs.mkdir(path.join(root, 'project'));
    service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing', claudeAcp: { command: { file: process.execPath, args: [path.join(root, 'peer.mjs')] } } }).start();
    const admin = new RhoClient({ url: service.url, token: service.adminToken }), p = await admin.call('project.open', { path: 'project' }), person = new BrowserClient({ url: service.url });
    const call = (m, b = {}) => person.call(m, { projectId: p.id, ...b });
    const done = async id => { for (let i = 0; i < 200; i++) { const r = await call('conversation.read', { conversationId: id }); const t = r.turns.at(-1); if (t.state !== 'running' && t.evidence?.records.length && t.evidence.records.every(x => x.state !== 'pending')) return r; await new Promise(r => setTimeout(r, 20)); } throw Error('capture timeout'); };
    const id = (await call('conversation.start', { changeId: 'one', text: 'write' })).conversation.conversationId;
    await done(id);
    await call('conversation.send', { conversationId: id, changeId: 'two', text: 'write again' });
    const read = await done(id);
    const kept = read.turns.flatMap(t => t.evidence.records.flatMap(r => r.snapshots)).filter(s => s.source.kind === 'disk');
    assert.equal(new Set(kept.map(s => s.resource.version)).size, 2);
    for (const [index, snapshot] of kept.entries()) {
      const page = await call('data.page', { resource: snapshot.resource, offset: 0, limit: 3 });
      assert.equal(page.columns?.length ?? Object.keys(page.rows?.[0] ?? {}).length, index + 2, 'version ' + (index + 1) + ' pages with its own columns');
    }
  } finally { await service?.close(); await fs.rm(root, { recursive: true, force: true }); }
});
