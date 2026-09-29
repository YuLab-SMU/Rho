// Ordinary view model checks. No Cargo, native Agent launch or model connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-view-'));
try {
  for (const [from, to] of [['plugins/agent/src', 'src'], ['plugins/agent/sdk', 'sdk'], ['sdk/plugin-ui', 'public/plugin-ui'], ['sdk/plugin-protocol', 'public/plugin-protocol']])
    fs.cpSync(path.join(root, from), path.join(temporary, to), { recursive: true });
  for (const name of ['package.json', 'tsconfig.json', 'dependencies.lock', 'build-ui.mjs', 'index.html']) fs.copyFileSync(path.join(root, 'plugins/agent', name), path.join(temporary, name));
  execFileSync(process.execPath, [path.join(root, 'ui/node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'], { cwd: temporary, stdio: 'inherit' });
  const { NativeAgentModel } = await import(pathToFileURL(path.join(temporary, 'compiled/src/native-model.js')));
  const { operationRequestId } = await import(pathToFileURL(path.join(temporary, 'compiled/public/plugin-ui/index.js')));
  const clone = structuredClone, blank = () => ({ text: '', assets: [], context: [] });
  function fixture() {
    let saved = {}, stateVersion = 0, lost = '', saveLost = false, gate = null;
    const instance = { instance: 'agent', plugin: 'org.rho.agent', revision: 'sha256:' + 'a'.repeat(64), artifact: 'sha256:' + 'b'.repeat(64) };
    const calls = [], records = [], details = new Map(), staged = new Map();
    const client = {
      get view() { return { view: 'agent-view', window: 'window', project: 'project', instance, state: clone(saved), state_version: stateVersion }; },
      async setState(value) { saved = clone(value); stateVersion++; if (saveLost) { saveLost = false; throw Error('Lost state reply'); } return this.view; },
      async query(cap, args) {
        let data;
        if (cap.id === 'operation.list_recent') data = { operations: records.filter(r => r.operation.client_request_id === args.client_request_id).map(r => ({ operation_id: r.operation.operation_id })) };
        else {
          assert.deepEqual(args.binding, { provider: instance, project: 'project', capability: cap, target: null }); assert.equal(args.preconditions, null);
          const input = args.arguments;
          if (cap.id === 'agent.tasks') data = { tasks: [], running: 0, permissions: 0, attention_count: 0, attention: [], next: null };
          else if (cap.id === 'agent.native.task') data = details.get(input.task_id);
          else if (cap.id === 'agent.native.receipt') data = [...details.values()].flatMap(d => d.receipts).find(r => r.request_id === input.request_id);
          else if (cap.id === 'agent.native.events') data = { task_id: input.task_id, history_generation: 1, events: [], next_cursor: 0, has_more: false, history_gap: false, oldest_cursor: 0, durable_cursor: 0 };
          else throw Error('Unexpected query ' + cap.id);
        }
        return { status: 'ready', completeness: 'complete', data: clone(data) };
      },
      async control(cap, args) {
        const upload = args.arguments.upload;
        assert.ok(saved.uploads.some(p => JSON.stringify(p.upload) === JSON.stringify(upload)), 'Attachment identity is saved before bytes are transferred');
        assert.equal(args.binding.provider.instance, 'agent'); assert.equal(args.preconditions, null);
        calls.push(clone({ cap, args, control: true }));
        if (cap.id === 'agent.native.assets.stage') {
          const part = Buffer.from(args.arguments.data, 'base64'), before = staged.get(upload.request_id) ?? Buffer.alloc(0);
          assert.ok(part.length <= 65536);
          if (args.arguments.offset === before.length) staged.set(upload.request_id, Buffer.concat([before, part]));
          else assert.deepEqual(before.subarray(args.arguments.offset, args.arguments.offset + part.length), part);
          if (lost === 'stage') { lost = ''; throw Error('Lost chunk reply'); }
          return { upload: clone(upload), received: staged.get(upload.request_id).length, complete: staged.get(upload.request_id).length === upload.bytes };
        }
        assert.equal(cap.id, 'agent.native.assets.finish');
        const bytes = staged.get(upload.request_id); assert.equal(bytes.length, upload.bytes);
        const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
        assert.equal(actual, upload.sha256);
        const detail = details.get(upload.control.task_id);
        let receipt = detail.receipts.find(r => r.request_id === upload.request_id);
        if (!receipt) {
          receipt = { request_id: upload.request_id, task_id: upload.control.task_id, command: 'add_asset', status: 'succeeded' };
          detail.receipts.push(receipt); detail.summary.observation_version++;
          detail.assets.push({ asset_id: upload.request_id, name: upload.name, mime_type: upload.mime_type, bytes: upload.bytes, sha256: upload.sha256 });
        }
        staged.delete(upload.request_id);
        if (lost === 'finish') { lost = ''; throw Error('Lost attachment reply'); }
        return clone({ receipt, detail });
      },
      async invoke(cap, args, options) {
        const pending = saved.pending.find(p => p.intent.request === options.requestId);
        assert.ok(pending, 'Original intent must be retained before dispatch'); assert.deepEqual(pending.intent.arguments, args);
        calls.push(clone({ cap, args, options }));
        const command = args.arguments.command, request = args.arguments.request_id;
        assert.equal(request, options.requestId); assert.equal(args.preconditions, null);
        const scoped = await operationRequestId('agent-view', request);
        let record = records.find(r => r.operation.client_request_id === scoped);
        if (!record) {
          const task = command.kind === 'create' ? 'task-' + details.size : command.control.task_id;
          let detail = details.get(task);
          if (command.kind === 'create') {
            detail = { summary: { observation_version: 1, history_generation: 1, task: { task_id: task, provider: command.provider, title: 'New task', archived: false, model: command.model },
              attachment: { generation: 1, controller: { window_id: 'window', incarnation: 'view:agent-view' }, state: 'idle', control_frozen: false, capabilities: {}, decisions: [] } },
              draft: { version: 1, content: blank() }, assets: [], receipts: [] };
            details.set(task, detail);
          } else if (command.kind === 'save_draft') {
            assert.equal(command.version, detail.draft.version); detail.draft = { version: detail.draft.version + 1, content: clone(command.content) };
          }
          const receipt = { request_id: request, command: command.kind, task_id: task, status: command.kind === 'send' ? 'submitted' : 'succeeded', submitted_draft_version: command.kind === 'send' ? command.draft_version : null };
          detail.receipts.push(receipt); detail.summary.observation_version++;
          if (command.kind === 'send') { detail.summary.attachment.state = 'running'; detail.draft = { version: detail.draft.version + 1, content: blank() }; }
          record = { operation: { operation_id: 'operation-' + records.length, caller: { kind: 'plugin', id: 'agent-view' }, client_request_id: await operationRequestId('agent-view', request),
            capability: cap, normalized_arguments: clone(args), preconditions: [] }, status: command.kind === 'send' ? 'running' : 'succeeded', outcome: command.kind === 'send' ? null : 'succeeded',
            output: command.kind === 'send' ? null : clone({ receipt, detail }), error: null };
          records.push(record);
        }
        if (lost === command.kind) { lost = ''; throw Error('Lost operation reply'); }
        if (gate) { const wait = gate; gate = null; await wait; }
        return clone(record);
      },
      async operation(id) { return clone(records.find(r => r.operation.operation_id === id)); },
    };
    return { client, calls, records, details, open: () => new NativeAgentModel(client), lose: kind => lost = kind, loseSave: () => saveLost = true, wait: promise => gate = promise };
  }
  let count = 0;
  async function check(name, work) { try { await work(); count++; } catch (error) { throw Error(name, { cause: error }); } }
  await check('opening is observation only and creation retains its original request', async () => {
    const f = fixture(), m = f.open(); await m.refresh(); assert.equal(f.calls.length, 0);
    await m.create('kimi', 'fixture', null); assert.equal(m.state.selected, 'task-0'); assert.equal(m.state.pending.length, 0);
    await f.open().refresh(); assert.equal(f.calls.length, 1);
  });
  await check('lost creation reply is inspected after reopen without another creation', async () => {
    const f = fixture(), m = f.open(); f.lose('create'); await assert.rejects(m.create('kimi', 'fixture', null), /Lost operation/);
    const next = f.open(); await next.refresh(); assert.equal(f.calls.length, 1);
    await assert.rejects(next.create('kimi', 'fixture', null), /original request/);
    await next.inspect(next.state.pending[0].intent.request); assert.equal(next.state.selected, 'task-0'); assert.equal(f.calls.length, 1);
  });
  await check('unacknowledged intent save cannot start native work', async () => {
    const f = fixture(), m = f.open(); f.loseSave(); await assert.rejects(m.create('kimi', 'fixture', null), /Lost state/);
    assert.equal(f.calls.length, 0); const next = f.open(); await next.refresh(); assert.equal(f.calls.length, 0);
    const original = clone(next.state.pending[0].intent);
    await assert.rejects(next.inspect(original.request), /not yet observable/); assert.equal(next.state.pending.length, 1);
    await next.continueOriginal(original.request); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.requestId, original.request);
  });
  await check('draft acknowledgement preserves typing that happened during the save', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    m.edit('task-0', { ...blank(), text: 'Captured Ω' });
    let release; f.wait(new Promise(done => release = done)); const saving = m.flush('task-0');
    while (f.calls.length < 2) await new Promise(done => setImmediate(done));
    m.edit('task-0', { ...blank(), text: 'Newer 甲' }); release(); await saving;
    assert.equal(m.draft('task-0').text, 'Newer 甲'); assert.equal(m.state.drafts['task-0'].dirty, true);
    await m.flush('task-0'); assert.equal(f.details.get('task-0').draft.content.text, 'Newer 甲'); assert.equal(m.state.drafts['task-0'].dirty, false);
  });
  await check('a late save receipt cannot hide a newer native draft conflict', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    m.edit('task-0', { ...blank(), text: 'Original draft' });
    let release; f.wait(new Promise(done => release = done)); const saving = m.flush('task-0');
    while (f.records.length < 2) await new Promise(done => setImmediate(done));
    m.edit('task-0', { ...blank(), text: 'Later local typing' });
    const remote = f.details.get('task-0'); remote.draft = { version: 3, content: { ...blank(), text: 'Another controller saved this' } };
    remote.summary.observation_version++; await m.observe('task-0'); release(); await saving;
    assert.equal(m.draft('task-0').text, 'Later local typing');
    assert.equal(m.state.drafts['task-0'].conflict.text, 'Another controller saved this');
    await assert.rejects(m.flush('task-0'), /conflicting draft/);
    await m.resolveDraft('task-0', true); await m.flush('task-0');
    assert.equal(f.details.get('task-0').draft.content.text, 'Later local typing');
  });
  await check('an oversized Unicode draft is retained without dispatching native work', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    const text = '甲'.repeat(12000); m.edit('task-0', { ...blank(), text }); await m.save();
    await assert.rejects(m.send('task-0'), /32 KiB/); assert.equal(f.calls.length, 1);
    const reopened = f.open(); await reopened.refresh(); assert.equal(reopened.draft('task-0').text, text);
  });
  await check('native completion clears only its original draft, preserving the next one and captured tools', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    m.edit('task-0', { ...blank(), text: 'Run the selected calculation' }); await m.flush('task-0');
    m.state.tools = [{ name: 'run_r', target: { type: 'provider', binding: { project: 'project', provider: { plugin: 'org.rho.r', instance: 'r', revision: 'revision', artifact: 'artifact' }, capability: { id: 'r.execute', version: 1 }, target: 'session' } } }];
    await m.send('task-0'); const send = f.calls.at(-1), pending = m.state.pending[0];
    m.state.tools = []; m.edit('task-0', { ...blank(), text: 'Keep the next draft' }); await m.observe('task-0');
    assert.equal(m.draft('task-0').text, 'Keep the next draft'); assert.equal(m.state.drafts['task-0'].conflict, null);
    await m.flush('task-0'); assert.equal(f.details.get('task-0').draft.content.text, 'Keep the next draft');
    assert.equal(send.args.arguments.tools.length, 1); await assert.rejects(m.send('task-0'), /running or unconfirmed/);
    const before = f.calls.length; const next = f.open(); await next.refresh(); await next.inspect(pending.intent.request); assert.equal(f.calls.length, before);
  });
  await check('a different operation cannot settle the retained request', async () => {
    const f = fixture(), m = f.open(); f.lose('create'); await assert.rejects(m.create('kimi', 'fixture', null));
    f.records[0].operation.normalized_arguments.binding.provider.instance = 'other-agent';
    await assert.rejects(m.inspect(m.state.pending[0].intent.request), /does not match/); assert.equal(m.state.pending.length, 1);
  });
  await check('another controller remains read-only and observation does not take over', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    f.details.get('task-0').summary.attachment.controller.incarnation = 'other-view'; await m.observe('task-0');
    assert.equal(m.canControl('task-0'), false); assert.throws(() => m.edit('task-0', blank()), /read-only/);
    await assert.rejects(m.stop('task-0'), /Take control/); assert.equal(f.calls.length, 1);
  });
  await check('closing the view sends neither Stop nor another turn', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null); m.dispose();
    await assert.rejects(m.refresh(), /closed/); assert.equal(f.calls.length, 1);
  });
  await check('continuation uses the original invocation after an ambiguous response', async () => {
    const f = fixture(), m = f.open(); f.lose('create'); await assert.rejects(m.create('kimi', 'fixture', null));
    const next = f.open(); await next.continueOriginal(next.state.pending[0].intent.request);
    assert.equal(f.records.length, 1); assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(next.state.selected, 'task-0');
  });
  await check('retained intents cannot select a different Agent instance after reopening', async () => {
    const f = fixture(), m = f.open(); f.lose('create'); await assert.rejects(m.create('kimi', 'fixture', null));
    const state = f.client.view.state; state.pending[0].intent.arguments.binding.provider.instance = 'other-agent';
    await f.client.setState(state); assert.throws(() => f.open(), /another Agent view or instance/);
  });
  await check('eight MiB attachments use bounded Controls and preserve text until an explicit Send', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    m.edit('task-0', { ...blank(), text: 'Keep this text' });
    const blob = new Blob([new Uint8Array(8 * 1024 * 1024).fill(82)], { type: 'text/plain' });
    await m.attachFile('task-0', blob, '完整数据.txt');
    const controls = f.calls.filter(c => c.control); assert.equal(controls.length, 129);
    assert.ok(controls.filter(c => c.cap.id.endsWith('.stage')).every(c => c.args.arguments.data.length <= 87384));
    assert.equal(m.draft('task-0').text, 'Keep this text'); assert.equal(m.draft('task-0').assets.length, 1);
    assert.equal(f.details.get('task-0').draft.content.assets.length, 0); // Asset selection is a distinct native draft save.
    assert.equal(f.records.length, 1); await m.flush('task-0');
    assert.equal(f.details.get('task-0').draft.content.assets.length, 1);
    assert.ok(!JSON.stringify(f.client.view.state).includes('data:')); assert.equal(m.uploads.length, 0);
    assert.ok(!f.calls.some(c => c.args.arguments.command?.kind === 'send'));
  });
  await check('lost final attachment reply reopens with metadata and only inspects the original receipt', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    f.lose('finish'); await assert.rejects(m.attachFile('task-0', new Blob(['original bytes']), 'notes.txt'), /Lost attachment/);
    const before = f.calls.length, next = f.open(); await next.refresh(); assert.equal(f.calls.length, before);
    const original = next.uploads[0].upload.request_id; await next.inspectUpload(original);
    assert.equal(f.calls.length, before); assert.equal(next.draft('task-0').assets.length, 0);
    await next.addUploaded(original); assert.deepEqual(next.draft('task-0').assets, [original]);
    assert.equal(f.details.get('task-0').assets.length, 1);
  });
  await check('a lost chunk uses the same identity only after the original file is reselected', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    const blob = new Blob([new Uint8Array(130000).fill(79)]); f.lose('stage');
    await assert.rejects(m.attachFile('task-0', blob, 'original.bin'), /Lost chunk/);
    const next = f.open(); await next.refresh(); const upload = clone(next.uploads[0].upload), before = f.calls.length;
    await assert.rejects(next.resumeUpload(upload.request_id, new Blob(['changed']), 'original.bin'), /same filename/); assert.equal(f.calls.length, before);
    await next.resumeUpload(upload.request_id, blob, 'original.bin');
    assert.deepEqual(f.calls.filter(c => c.control).map(c => c.args.arguments.upload), Array(f.calls.filter(c => c.control).length).fill(upload));
    assert.equal(f.details.get('task-0').assets.length, 1); assert.deepEqual(next.draft('task-0').assets, [upload.request_id]);
  });
  await check('unconfirmed attachment intent and oversize files never transfer bytes', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    await assert.rejects(m.attachFile('task-0', new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]), 'large.bin'), /8 MiB/);
    f.loseSave(); await assert.rejects(m.attachFile('task-0', new Blob(['small']), 'small.txt'), /Lost state/);
    assert.equal(f.calls.length, 1); assert.equal(f.open().uploads.length, 1);
  });
  await check('a successful-looking attachment with different bytes cannot enter the draft', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    const original = f.client.control;
    f.client.control = async (cap, args) => {
      const result = await original.call(f.client, cap, args);
      if (cap.id.endsWith('.finish')) result.detail.assets[0].sha256 = '0'.repeat(64);
      return result;
    };
    await assert.rejects(m.attachFile('task-0', new Blob(['captured']), 'notes.txt'), /not confirmed/);
    assert.equal(m.draft('task-0').assets.length, 0); assert.equal(m.uploads.length, 1);
  });
  await check('retained attachment metadata cannot retarget another plugin instance', async () => {
    const f = fixture(), m = f.open(); await m.create('kimi', 'fixture', null);
    f.lose('stage'); await assert.rejects(m.attachFile('task-0', new Blob(['captured']), 'notes.txt'));
    const state = f.client.view.state; state.uploads[0].instance.instance = 'other-agent'; await f.client.setState(state);
    const before = f.calls.length; assert.throws(() => f.open(), /another Agent view or instance/); assert.equal(f.calls.length, before);
  });
  console.log(`Ordinary Agent view: ${count} checks passed; original requests, draft concurrency, next-turn input, read-only control and disposal. No native/UI acceptance claimed.`);
  if (process.argv.includes('--build-ui') || process.argv.includes('--browser')) execFileSync(process.execPath, [path.join(temporary, 'build-ui.mjs')], {
    cwd: temporary, stdio: 'inherit', env: { ...process.env, RHO_PLUGIN_NODE_MODULES: path.join(root, 'ui/node_modules') },
  });
  if (process.argv.includes('--browser')) {
    const { testAgentRenderer } = await import('./agent-view-renderer.mjs');
    await testAgentRenderer(root, path.join(temporary, 'dist/ui'));
  }
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
