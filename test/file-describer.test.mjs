import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RhoService } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { RhoClient } from '../dist/client.js';
import { fileFacts, describedFiles, holdsOf } from '../dist/file-describer.js';
import { createHash } from 'node:crypto';

const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

test('facts are read from the bytes: a table\'s shape and columns, an image\'s size, a script\'s lines and functions', () => {
  const csv = Buffer.from('strain,"area, mean",n\n1,10,3\n2,12,3\n');
  assert.deepEqual(fileFacts('results/a.csv', csv, csv.length), { facts: '2 rows × 3 columns: strain, area, mean, n', partial: false, textual: true, excerpt: 'strain,"area, mean",n\n1,10,3\n2,12,3\n' });
  assert.equal(fileFacts('results/a.csv', csv.subarray(0, 25), csv.length).facts, 'at least 1 row × 3 columns: strain, area, mean, n');
  const image = fileFacts('results/plot.png', png(1200, 800), 2048);
  assert.deepEqual([image.facts, image.textual, image.excerpt], ['PNG image, 1200 × 800 px, 2 KB', false, '']);
  assert.equal(fileFacts('fig.svg', Buffer.from('<svg xmlns="x" viewBox="0 0 640 480">'), 40).facts, 'SVG image, 640 × 480 px, 40 B');
  const py = Buffer.from('import csv\n\ndef read(p):\n    pass\n\ndef test(x):\n    pass\n');
  assert.equal(fileFacts('analysis.py', py, py.length).facts, 'Python script, 7 lines, 2 functions');
  assert.equal(fileFacts('notes.md', Buffer.from('# Answers\n\nText\n'), 16).facts, 'Markdown, 3 lines; first heading “Answers”');
  assert.equal(fileFacts('out.json', Buffer.from('[{"a":1,"b":2}]'), 15).facts, 'JSON array of 1 item with keys a, b, 15 B');
  const wide = Buffer.from(Array.from({ length: 12 }, (_, i) => 'c' + i).join(',') + '\n');
  assert.equal(fileFacts('w.csv', wide, wide.length).facts, '0 rows × 12 columns: c0, c1, c2, c3, c4, c5, c6, c7, … (4 more)');
  const newest = describedFiles([{ conversationId: 'c', turn: { id: 't1', descriptions: [{ path: 'a.csv', observedAt: '2026-10-30T10:00:00Z', facts: 'old' }] } }, { conversationId: 'c', turn: { id: 't2', descriptions: [{ path: 'a.csv', observedAt: '2026-10-30T10:05:00Z', facts: 'new' }] } }]);
  assert.equal(newest.get('a.csv').facts, 'new'); assert.equal(newest.get('a.csv').turnId, 't2');
});

// An Agent that writes a table and a figure, waits, and answers.
const peer = `import fs from 'node:fs';import readline from 'node:readline';const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
readline.createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l),reply=result=>out({id:r.id,result});
if(r.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true}});if(r.method==='session/new')reply({sessionId:'test'});if(r.method==='session/load')reply({});
if(r.method==='session/prompt'){fs.mkdirSync('results',{recursive:true});fs.writeFileSync('results/table.csv','a,b,c\\n1,2,3\\n4,5,6\\n');fs.writeFileSync('results/plot.png',Buffer.from(${JSON.stringify(png(3, 2).toString('base64'))},'base64'));fs.writeFileSync('project-notes.md','## Notes\\n');
setTimeout(()=>{fs.writeFileSync('results/table.csv','a,b,c\\n7,8,9\\n1,1,1\\n');setTimeout(()=>reply({stopReason:'end_turn'}),800);},1000);}});`;
// Claude Code asked for a description: it records the call and answers in one sentence.
const describer = log => `#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),input})+'\\n');
process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'Three columns of small numbers.',total_cost_usd:0.002,modelUsage:{'fake-model':{}}}));});`;

test('while a message runs, the files it writes get facts at once and a model sentence for text, bound to the version read', async () => {
  const root = await fs.mkdtemp('/tmp/rho-describe-turn-'); let service;
  try {
    const log = path.join(root, 'describe.log'), claude = path.join(root, 'claude');
    await fs.writeFile(path.join(root, 'peer.mjs'), peer); await fs.writeFile(claude, describer(log), { mode: 0o755 }); await fs.mkdir(path.join(root, 'project'));
    const options = { root, stateDir: path.join(root, '.service'), rscript: '/missing', claude, claudeAcp: { command: { file: process.execPath, args: [path.join(root, 'peer.mjs')] } } };
    service = await new RhoService(options).start();
    Object.assign(service.conversations.describing, { everyMs: 200, settleMs: 100 });
    const admin = new RhoClient({ url: service.url, token: service.adminToken }), p = await admin.call('project.open', { path: 'project' }), person = new BrowserClient({ url: service.url });
    const call = (m, b = {}) => person.call(m, { projectId: p.id, ...b });
    const start = await call('conversation.start', { changeId: 'one', text: 'Summarise the plates.' }), id = start.conversation.conversationId;
    let seenWhileRunning = null, turn;
    for (let i = 0; i < 300; i++) {
      turn = (await call('conversation.read', { conversationId: id })).turns.at(-1);
      if (turn.state === 'running' && turn.descriptions?.length && !seenWhileRunning) seenWhileRunning = turn.descriptions.map(d => d.path).sort();
      if (turn.state !== 'running' && turn.descriptions?.every(d => d.state !== 'describing')) break;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.deepEqual(seenWhileRunning, ['results/plot.png', 'results/table.csv'], 'described before the message ended');
    const table = turn.descriptions.find(d => d.path === 'results/table.csv'), plot = turn.descriptions.find(d => d.path === 'results/plot.png');
    assert.equal(table.facts, '2 rows × 3 columns: a, b, c');
    assert.equal(table.state, 'described');
    const first = createHash('sha256').update('a,b,c\n1,2,3\n4,5,6\n').digest('hex'), last = createHash('sha256').update('a,b,c\n7,8,9\n1,1,1\n').digest('hex');
    assert.equal(table.version, last, 'the facts are of the version on disk at the end');
    assert.deepEqual({ ...table.sentence, at: undefined }, { text: 'Three columns of small numbers.', version: first, model: 'fake-model', at: undefined, facts: '2 rows × 3 columns: a, b, c', costUsd: 0.002 }, 'the sentence names the version it read and its reported cost');
    const shown = holdsOf('results/table.csv', new Map(), describedFiles([{ conversationId: id, turn }]));
    assert.deepEqual([shown.source, shown.earlier], ['model', false], 'a later version with the same facts keeps the sentence');
    assert.equal(plot.facts, 'PNG image, 3 × 2 px, 33 B');
    assert.equal(plot.state, 'facts'); assert.match(plot.reason, /figure or PDF/);
    assert.ok(!turn.descriptions.some(d => d.path === 'project-notes.md'), 'the notes are not described');
    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls.length, 1, 'the model is asked once, for the table only, and not again for the same facts');
    assert.deepEqual(calls[0].args.slice(0, 3), ['-p', '--tools', '']);
    assert.match(calls[0].input, /^File: results\/table\.csv\nFacts read from the file: 2 rows × 3 columns: a, b, c\nThe person's request to the Agent: Summarise the plates\.\nFirst lines:\na,b,c/);

    // A description still being written when the service stopped is not known.
    const journal = path.join(p.root, '.rho/rho/conversations', id + '.json');
    await service.close(); service = null;
    const saved = JSON.parse(await fs.readFile(journal, 'utf8'));
    saved.turns[0].descriptions[0].state = 'describing'; await fs.writeFile(journal, JSON.stringify(saved));
    service = await new RhoService(options).start();
    const reopened = await new BrowserClient({ url: service.url }).call('conversation.read', { projectId: p.id, conversationId: id });
    assert.equal(reopened.turns[0].descriptions[0].state, 'unknown');
    assert.match(reopened.turns[0].descriptions[0].reason, /stopped before the description arrived/);
  } finally { await service?.close(); await fs.rm(root, { recursive: true, force: true }); }
});
