import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { RhoService, layeredGrantLimits } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';

// A real R session draws a real ggplot; the figure it is kept as is what the person selects in
// and what the Agent reads. Without R and the describer's packages this is skipped, not passed.
const rscript = process.env.RHO_RSCRIPT ?? 'Rscript';
const probe = spawnSync(rscript, ['-e', 'cat(all(vapply(c("ggplot2","svglite","xml2","jsonlite"), requireNamespace, TRUE, quietly = TRUE)))'], { encoding: 'utf8' });
const skip = probe.stdout?.trim() === 'TRUE' ? (process.platform === 'win32' && 'the stand-in Agent is a script') : 'R with ggplot2, svglite, xml2 and jsonlite is not available';
// A stand-in Claude Code CLI that keeps the message it was given and answers it.
const stub = log => `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), at = name => args[args.indexOf(name) + 1];
const session = args.includes('--resume') ? at('--resume') : at('--session-id');
let text = ''; process.stdin.on('data', d => text += d);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ text }) + '\\n');
  const out = record => process.stdout.write(JSON.stringify({ session_id: session, ...record }) + '\\n');
  out({ type: 'system', subtype: 'init', model: 'fake-model' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'read' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'read', num_turns: 1, duration_ms: 5, total_cost_usd: 0 });
});
`;

test('a plot drawn in the Notebook is a figure the person selects in, asks about, and the Agent reads and points back into', { skip, timeout: 240000 }, async t => {
  const root = await fs.mkdtemp(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'rho-figures-'));
  const log = path.join(root, 'claude.jsonl'), claude = path.join(root, 'claude-stub.mjs');
  await fs.mkdir(path.join(root, 'work'));
  await fs.writeFile(claude, stub(log), { mode: 0o755 });
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript, claude, agentBackend: 'claude-cli' }).start();
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });
  const person = new BrowserClient({ url: service.url });
  const call = (method, input = {}) => person.call(method, { projectId: p.id, ...input });

  const ran = await call('kernel.run', { language: 'r', changeId: 'volcano', waitMs: 180000, code: `library(ggplot2); set.seed(2)
res <- data.frame(log2FoldChange = rnorm(300, 0, 2), padj = 10^-runif(300, 0, 10), row.names = sprintf("gene%03d", 1:300))
ggplot(res, aes(log2FoldChange, -log10(padj))) + geom_point()` });
  assert.equal(ran.cell.state, 'done', JSON.stringify(ran.cell.outputs));
  const plot = ran.cell.outputs.find(o => o.kind === 'plot');
  assert.deepEqual([plot.figure.describer, plot.figure.marks, plot.figure.bound], ['ggplot', 300, 300], 'the cell\'s plot names what was described');
  const { cellId } = ran.cell;

  // The browser reads the whole record to draw it; the summary leaves the picture out.
  const view = await call('figure.read', { cellId, plot: 1, form: 'view' });
  assert.match(view.record.svg, /data-rho="/);
  const summary = await call('figure.read', { cellId, plot: 1 });
  assert.equal(summary.record, undefined);
  assert.equal(summary.summary.layers[0].marks, 300);
  assert.equal(summary.figure.cell.code.includes('geom_point'), true, 'the Agent reads the code that drew it');

  // The person brushes the strongest genes and asks about them.
  const strong = await call('figure.read', { cellId, plot: 1, where: [{ column: 'padj', op: 'lt', value: 1e-8 }], limit: 500 });
  assert.ok(strong.matched.total >= 15, 'enough marks to go past what a message carries');
  const kept = await call('figure.select', { cellId, plot: 1, marks: strong.matched.marks, changeId: 'ask-1' });
  assert.equal(kept.selection.by, 'browser:local');
  const sent = await call('conversation.start', { changeId: 'ask-these', text: 'What are these?', uiContext: { page: 'notebook', figure: { cellId, plot: 1, selectionId: kept.selection.selectionId } } });
  let turn;
  for (let i = 0; i < 400 && (!turn || turn.state === 'running'); i++) { await new Promise(r => setTimeout(r, 25)); turn = (await call('conversation.read', { conversationId: sent.conversation.conversationId })).turns[0]; }
  assert.equal(turn.text, 'What are these?', 'the person\'s words stay as they wrote them');
  const brief = turn.uiContext.figureSelection;
  assert.equal(brief.count, strong.matched.total);
  assert.equal(brief.rowsShown, 12, 'the message carries the first rows; the rest are read');
  assert.match(brief.rows[0].values ? Object.keys(brief.rows[0].values).join() : '', /padj/);
  const [given] = (await fs.readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.match(given.text, /^What are these\?/);
  assert.match(given.text, /figureSelection is what "these"/);
  assert.ok(given.text.includes(kept.selection.selectionId));

  // A selection the figure no longer keeps is said to be unavailable; the message still goes.
  const gone = await call('conversation.start', { changeId: 'ask-gone', text: 'And these?', uiContext: { page: 'notebook', figure: { cellId, plot: 1, selectionId: 'f-0000000000000000' } } });
  assert.match(gone.turn.uiContext.figureSelection.unavailable, /no such selection/);

  // The Agent's grant reads figures and points into them, within the method budget.
  const grant = path.join(root, 'agent.json');
  const connection = await service.agentConnection(p.id, 'figures', grant, undefined, undefined, 'layered-business');
  assert.ok(connection.methods.includes('figure.read') && connection.methods.includes('figure.select'));
  assert.ok(connection.methods.length <= layeredGrantLimits.maxMethods, `${connection.methods.length} methods`);
  const agent = new RhoClient(JSON.parse(await fs.readFile(grant, 'utf8')));
  const rows = await agent.call('figure.read', { projectId: p.id, cellId, plot: 1, selection: kept.selection.selectionId, limit: 500 });
  assert.equal(rows.rows.length, strong.matched.total);
  const top = rows.rows.sort((a, b) => a.values.padj - b.values.padj).slice(0, 3).map(r => r.mark);
  const pointed = await agent.call('figure.select', { projectId: p.id, cellId, plot: 1, marks: top, note: 'The three smallest padj', changeId: 'top-3' });
  assert.match(pointed.selection.by, /^agent:/);
  const listed = await call('figure.read', { cellId, plot: 1, form: 'selections' });
  assert.deepEqual(listed.selections.map(s => s.note), ['The three smallest padj', ''], 'the person sees the Agent\'s marks, newest first');
  await assert.rejects(agent.call('figure.select', { projectId: p.id, cellId, plot: 1, marks: top.slice(1), note: 'The three smallest padj', changeId: 'top-3' }), e => e.error?.kind === 'conflict');
  await assert.rejects(call('figure.read', { cellId: 'k-0000000000000000', plot: 1 }), e => e.error?.kind === 'not_found');
});
