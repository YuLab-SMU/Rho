import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RhoService } from '../dist/server.js';
import { BrowserClient } from '../dist/browser.js';
import { RhoClient } from '../dist/client.js';
import { fileFacts, describedFiles, holdsOf, figureContext } from '../dist/file-describer.js';
import http from 'node:http';
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

// An Agent whose session reports a model, chosen by the order sessions are made. Each message
// writes a table, then runs plot.py, during which a figure is written, and answers.
const peer = `import fs from 'node:fs';import readline from 'node:readline';const out=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const models=JSON.parse(process.env.RHO_TEST_MODELS);let n=0,model='';
readline.createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l),reply=result=>out({id:r.id,result});
if(r.method==='initialize')reply({protocolVersion:1,agentCapabilities:{loadSession:true}});
if(r.method==='session/new'){const counter=process.env.RHO_TEST_COUNTER;let k=0;try{k=+fs.readFileSync(counter,'utf8')}catch{};fs.writeFileSync(counter,String(k+1));n=k+1;model=models[k]??models.at(-1);reply({sessionId:'s'+n,configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:model,options:[{value:model,name:model}]}]});}
if(r.method==='session/load')reply({});
if(r.method==='session/prompt'){const sid=r.params.sessionId,up=u=>out({method:'session/update',params:{sessionId:sid,update:u}});
fs.mkdirSync('results',{recursive:true});fs.writeFileSync('results/table.csv','a,b,c\\n'+n+',2,3\\n4,5,6\\n');fs.writeFileSync('project-notes.md','## Notes\\n');
up({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Now I plot the mean area by ratio.'}});
up({sessionUpdate:'tool_call',toolCallId:'run-'+n,title:'python3 plot.py',kind:'execute',status:'in_progress',rawInput:{command:'python3 plot.py'}});
setTimeout(()=>{fs.writeFileSync('results/plot.png',Buffer.from(${JSON.stringify(png(3, 2).toString('base64'))},'base64'));fs.appendFileSync('results/plot.png',Buffer.from([n]));
setTimeout(()=>{up({sessionUpdate:'tool_call_update',toolCallId:'run-'+n,status:'completed'});setTimeout(()=>{fs.writeFileSync('results/table.csv','a,b,c\\n7,8,9\\n'+n+',1,1\\n');setTimeout(()=>reply({stopReason:'end_turn'}),1500);},1000);},300);},800);}});`;
// Claude Code asked for a description: it records the call and answers in one sentence, with the
// tokens it used and a price it does not know. A model named "liar" refuses images.
const describer = log => `#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{const args=process.argv.slice(2),model=args[args.indexOf('--model')+1],content=JSON.parse(input).message.content;
require('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({args,model,types:content.map(c=>c.type),text:content.at(-1).text,prompt:args[args.indexOf('--system-prompt')+1]})+'\\n');
if(model==='liar-model'&&content.some(c=>c.type==='image')){process.stdout.write(JSON.stringify({type:'result',is_error:true,result:'This model does not support images.'})+'\\n');return;}
process.stdout.write(JSON.stringify({type:'result',is_error:false,result:content.some(c=>c.type==='image')?'Bars of mean area by ratio.':content.at(-1).text.includes('What made it')?'Planned bars of mean area by ratio.':'Three columns of small numbers.',
modelUsage:{[model]:{inputTokens:1000,outputTokens:100,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:0.05,costBasis:'unknown'}}})+'\\n');});`;
const catalog = { local: { models: {
  'seeing-model': { id: 'seeing-model', modalities: { input: ['text', 'image'] }, cost: { input: 1, output: 2 } },
  'reading-model': { id: 'reading-model', modalities: { input: ['text'] }, cost: { input: 1, output: 2 } },
  'liar-model': { id: 'liar-model', modalities: { input: ['text', 'image'] }, cost: { input: 1, output: 2 } } } } };

test('while a message runs, its files get facts at once and a sentence: a figure as an image to a model that takes images, else from what made it', async () => {
  const root = await fs.mkdtemp('/tmp/rho-describe-turn-'); let service;
  const listing = http.createServer((_, res) => res.end(JSON.stringify(catalog)));
  await new Promise(r => listing.listen(0, '127.0.0.1', r));
  try {
    const log = path.join(root, 'describe.log'), claude = path.join(root, 'claude');
    await fs.writeFile(path.join(root, 'peer.mjs'), peer); await fs.writeFile(claude, describer(log), { mode: 0o755 }); await fs.mkdir(path.join(root, 'project'));
    await fs.writeFile(path.join(root, 'project', 'plot.py'), "import matplotlib.pyplot as plt\nplt.bar(ratios, area)\nplt.title('Mean area by ratio')\nplt.savefig('results/plot.png')\n");
    const options = { root, stateDir: path.join(root, '.service'), rscript: '/missing', claude, modelsDev: { url: `http://127.0.0.1:${listing.address().port}/api.json` },
      describe: { everyMs: 200, settleMs: 100 }, claudeAcp: { command: { file: process.execPath, args: [path.join(root, 'peer.mjs')] }, env: { RHO_TEST_COUNTER: path.join(root, 'sessions'), RHO_TEST_MODELS: JSON.stringify(['seeing-model', 'reading-model', 'liar-model', 'seeing-model']) } } };
    service = await new RhoService(options).start();
    const admin = new RhoClient({ url: service.url, token: service.adminToken }), p = await admin.call('project.open', { path: 'project' }), person = new BrowserClient({ url: service.url });
    const call = (m, b = {}) => person.call(m, { projectId: p.id, ...b });
    const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    async function run(changeId, text) {
      const id = (await call('conversation.start', { changeId, text })).conversation.conversationId;
      let seen = null, turn;
      for (let i = 0; i < 400; i++) {
        turn = (await call('conversation.read', { conversationId: id })).turns.at(-1);
        if (turn.state === 'running' && turn.descriptions?.some(d => d.path === 'results/table.csv') && !seen) seen = turn.descriptions.map(d => d.path);
        if (turn.state !== 'running' && turn.descriptions?.length === 2 && turn.descriptions.every(d => d.state !== 'describing')) break;
        await new Promise(r => setTimeout(r, 25));
      }
      return { id, turn, seen, of: path => turn.descriptions.find(d => d.path === path) };
    }

    // A model models.dev lists as taking images is shown the figure.
    const seeing = await run('one', 'Summarise the plates.');
    assert.ok(seeing.seen, 'described before the message ended');
    assert.ok(!seeing.turn.descriptions.some(d => d.path === 'project-notes.md'), 'the notes are not described');
    const table = seeing.of('results/table.csv'), plot = seeing.of('results/plot.png');
    assert.deepEqual([table.facts, table.sentence.text, table.sentence.strategy, table.sentence.model], ['2 rows × 3 columns: a, b, c', 'Three columns of small numbers.', 'text', 'seeing-model']);
    assert.deepEqual(table.sentence.cost, { usd: 0.0012, basis: 'estimated', note: "models.dev's median price for seeing-model across 1 providers" });
    assert.deepEqual([plot.facts, plot.state, plot.sentence.strategy, plot.sentence.text], ['PNG image, 3 × 2 px, 34 B', 'described', 'image', 'Bars of mean area by ratio.']);
    assert.equal(plot.sentence.version, createHash('sha256').update(await fs.readFile(path.join(p.root, 'results/plot.png'))).digest('hex'), 'the sentence names the version it was shown');
    assert.notEqual(table.sentence.version, table.version, 'the table was written again with the same facts after it was described');
    assert.deepEqual(seeing.turn.descriptionSpend, { calls: 2, usd: 0.0024, estimated: 2, unknown: 0 }, 'and the model was not asked again for it');
    let made = await calls();
    assert.deepEqual(made.map(c => c.types.join('+')), ['text', 'image+text']);
    assert.deepEqual(made[0].args.slice(0, 3), ['-p', '--tools', '']);
    assert.match(made[0].text, /^File: results\/table\.csv\nFacts read from the file: 2 rows × 3 columns: a, b, c\nThe person's request to the Agent: Summarise the plates\.\nFirst lines:\na,b,c/);

    // A model listed as taking text only is given what made the figure.
    const reading = await run('two', 'Again.');
    const planned = reading.of('results/plot.png').sentence;
    assert.deepEqual([planned.strategy, planned.from, planned.text], ['context', ['plot.py'], 'Planned bars of mean area by ratio.']);
    assert.match(planned.why, /models\.dev lists reading-model as taking text only/);
    made = await calls();
    assert.match(made.at(-1).text, /What made it:\nMade while this command ran: python3 plot\.py\nFrom plot\.py:\n[\s\S]*plt\.savefig\('results\/plot\.png'\)[\s\S]*The Agent said before it: Now I plot the mean area by ratio\./);
    assert.match(made.at(-1).prompt, /not shown the figure itself/);

    // A model listed as taking images that refuses one is given what made the figure instead.
    const liar = await run('three', 'Once more.');
    const fallback = liar.of('results/plot.png').sentence;
    assert.deepEqual([fallback.strategy, fallback.text], ['context', 'Planned bars of mean area by ratio.']);
    assert.match(fallback.why, /did not take the image: This model does not support images/);
    assert.deepEqual(liar.turn.descriptionSpend, { calls: 3, usd: 0.0024, estimated: 2, unknown: 1 }, 'the refused call is counted, its cost not known');

    // Switched off, files keep their facts and no model is asked.
    const settings = await call('conversation.settings.read');
    assert.equal(settings.describe.enabled, true);
    assert.equal((await call('conversation.settings.update', { expectedVersion: settings.version, describe: { enabled: false } })).describe.enabled, false);
    const before = (await calls()).length, off = await run('four', 'Quietly.');
    assert.equal((await calls()).length, before);
    assert.deepEqual(off.turn.descriptions.map(d => [d.state, d.sentence, /switched off/.test(d.reason)]), [['facts', null, true], ['facts', null, true]]);
    assert.equal(off.turn.descriptionSpend, undefined);

    // A description still being written when the service stopped is not known.
    const journal = path.join(p.root, '.rho/rho/conversations', seeing.id + '.json');
    await service.close(); service = null;
    const saved = JSON.parse(await fs.readFile(journal, 'utf8'));
    saved.turns[0].descriptions[0].state = 'describing'; await fs.writeFile(journal, JSON.stringify(saved));
    service = await new RhoService(options).start();
    const reopened = await new BrowserClient({ url: service.url }).call('conversation.read', { projectId: p.id, conversationId: seeing.id });
    assert.equal(reopened.turns[0].descriptions[0].state, 'unknown');
    assert.match(reopened.turns[0].descriptions[0].reason, /stopped before the description arrived/);
  } finally { await service?.close(); listing.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('what made a figure: the lines around where the script names it, and the Agent\'s words before it', async () => {
  const steps = [
    { kind: 'text', at: '2026-10-30T10:00:00Z', text: 'I will plot it.' },
    { kind: 'tool', toolKind: 'execute', at: '2026-10-30T10:00:09Z', startedAt: '2026-10-30T10:00:05Z', detail: "python3 - <<'EOF'\nimport x\nx.plot()\nx.save('out/fig.png')\nEOF" },
  ];
  const made = await figureContext('out/fig.png', '2026-10-30T10:00:07Z', steps, async () => null, () => []);
  assert.deepEqual(made.from, ['the command']);
  assert.match(made.context, /From the command:\n[\s\S]*x\.save\('out\/fig\.png'\)/);
  assert.match(made.context, /The Agent said before it: I will plot it\./);
  assert.equal(await figureContext('out/fig.png', '2026-10-30T09:00:00Z', steps, async () => null, () => []), null, 'nothing recorded made it');
});
