// Renderer-only synthetic peer. It exercises the public opaque iframe channel;
// it is not native Agent, Host or scientific execution acceptance.
const copy = structuredClone, blank = () => ({ text: '', assets: [], context: [] });
const instance = { instance: 'agent', plugin: 'org.rho.agent', revision: 'sha256:' + 'a'.repeat(64), artifact: 'sha256:' + 'b'.repeat(64) };
const tool = { name: 'run_selected_r', target: { type: 'provider', binding: { project: 'project', provider: { ...instance, instance: 'r', plugin: 'org.rho.r' }, capability: { id: 'r.execute', version: 2 }, target: 'session-one' } } };
let view = { view: 'agent-view', window: 'window', project: 'project', instance, state_version: 1,
  configuration: { tools: [tool] }, state: { schema: 1, selected: 'task-0', archived: false, drafts: {}, pending: [], tools: [], catalogs: {} } };
const details = new Map(), records = [], calls = [], events = new Map();
function detail(task, title) {
  return { summary: { observation_version: 1, history_generation: 1, task: { task_id: task, provider: 'kimi', title, archived: false, model: 'fixture-model', mode: null, native_session_id: null },
    attachment: { generation: 1, controller: { window_id: 'window', incarnation: 'view:agent-view' }, state: 'idle', control_frozen: false,
      capabilities: { models: [{ id: 'fixture-model', name: 'Fixture model' }], history: 'Retained native events' }, decisions: [] }, history_gap: false, unconfirmed: 0 },
    draft: { version: 1, content: blank() }, assets: [], receipts: [] };
}
details.set('task-0', detail('task-0', 'Inspect the selected R workspace'));
details.set('task-1', detail('task-1', 'Compare the saved analysis'));
events.set('task-0', [
  { cursor: 1, kind: 'text', role: 'user', text: 'Explain the result for 细胞类型 Ω and keep the original run.' },
  { cursor: 2, kind: 'text', role: 'assistant', text: 'The selected calculation returned 42. Its original record remains available.\n\nYou can continue this conversation or start a separate task.' },
  { cursor: 3, kind: 'reasoning', role: 'assistant', text: 'RENDERER_PRIVATE_REASONING' },
]);
let close = { phase: 'open' }, saveDelay = 0, loseFinish = false;
const staged = new Map();
async function requestId(request) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('agent-view:' + request));
  return 'sha256:' + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
async function handle(body) {
  if (body.type === 'register_close_handler') return {};
  if (body.type === 'observe_lifecycle') return { view: view.view, close };
  if (body.type === 'prepare_close' || body.type === 'refuse_close') { calls.push(copy(body)); return {}; }
  if (body.type === 'set_state') {
    if (body.expected_version !== view.state_version) throw Error('Stale view state');
    view = { ...view, state: copy(body.state), state_version: view.state_version + 1 }; return { status: 'succeeded', output: copy(view) };
  }
  if (body.type === 'get_operation') return copy(records.find(r => r.operation.operation_id === body.operation_id));
  if (body.type === 'query') {
    const id = body.capability.id, args = body.arguments.arguments;
    let data;
    if (id === 'operation.list_recent') data = { operations: records.filter(r => r.operation.client_request_id === body.arguments.client_request_id).map(r => ({ operation_id: r.operation.operation_id })) };
    else if (id === 'agent.tasks') data = { tasks: [...details.values()].filter(d => d.summary.task.archived === args.archived).map(d => ({ reference: { kind: 'native', task_id: d.summary.task.task_id }, title: d.summary.task.title, provider: d.summary.task.provider, state: d.summary.attachment.state })), next: null };
    else if (id === 'agent.native.task') data = details.get(args.task_id);
    else if (id === 'agent.native.receipt') data = [...details.values()].flatMap(d => d.receipts).find(r => r.request_id === args.request_id);
    else if (id === 'agent.native.events') data = { task_id: args.task_id, events: events.get(args.task_id) ?? [], history_generation: 1, has_more: false, history_gap: false, next_cursor: 3, durable_cursor: 3, oldest_cursor: 1 };
    else throw Error('Unexpected query ' + id);
    return { status: 'ready', completeness: 'complete', data: copy(data) };
  }
  if (body.type === 'control') {
    const { upload, offset, data } = body.arguments.arguments;
    if (!view.state.uploads.some(p => JSON.stringify(p.upload) === JSON.stringify(upload))) throw Error('Attachment identity was not retained');
    calls.push({ ...copy(body), arguments: { upload: copy(upload), offset, encoded_bytes: data?.length ?? 0 } });
    if (body.capability.id === 'agent.native.assets.stage') {
      const part = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      let entry = staged.get(upload.request_id);
      if (!entry) { entry = { bytes: new Uint8Array(upload.bytes), received: 0 }; staged.set(upload.request_id, entry); }
      if (part.length > 65536 || offset > entry.received) throw Error('Invalid chunk range');
      entry.bytes.set(part, offset); entry.received = Math.max(entry.received, offset + part.length);
      return { upload: copy(upload), received: entry.received, complete: entry.received === upload.bytes };
    }
    if (body.capability.id !== 'agent.native.assets.finish') throw Error('Unexpected attachment Control');
    const entry = staged.get(upload.request_id); if (entry?.received !== upload.bytes) throw Error('Incomplete file');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', entry.bytes)), n => n.toString(16).padStart(2, '0')).join('');
    if (digest !== upload.sha256) throw Error('Changed file bytes');
    const detail = details.get(upload.control.task_id), receipt = { request_id: upload.request_id, task_id: upload.control.task_id, command: 'add_asset', status: 'succeeded' };
    detail.assets.push({ asset_id: upload.request_id, name: upload.name, mime_type: upload.mime_type, bytes: upload.bytes, sha256: upload.sha256 });
    detail.receipts.push(receipt); detail.summary.observation_version++; staged.delete(upload.request_id);
    if (loseFinish) { loseFinish = false; throw Error('Lost attachment reply'); }
    return copy({ receipt, detail });
  }
  if (body.type === 'invoke') {
    calls.push(copy(body));
    if (!view.state.pending.some(p => p.intent.request === body.request_id)) throw Error('Original intent was not retained');
    const scoped = await requestId(body.request_id), original = records.find(r => r.operation.client_request_id === scoped);
    if (original) return copy(original);
    const command = body.arguments.arguments.command, sentAssets = command?.kind === 'send' ? copy(details.get(command.control.task_id).draft.content.assets) : [], task = command?.control?.task_id ?? 'task-' + details.size;
    let d = details.get(task), output;
    if (body.capability.id === 'agent.native.discover') {
      output = { provider: body.arguments.arguments.provider, selected_model: 'fixture-model', selected_effort: null, models: [{ id: 'fixture-model', name: 'Fixture model' }], error: null };
    } else {
      if (command.kind === 'create') { d = detail(task, 'New task'); d.summary.task.provider = command.provider; details.set(task, d); }
      else if (command.kind === 'save_draft') {
        if (command.version !== d.draft.version) throw Error('Stale native draft');
        d.draft = { version: d.draft.version + 1, content: copy(command.content) };
      } else if (command.kind === 'send') {
        if (command.draft_version !== d.draft.version) throw Error('Stale sent draft');
        events.set(task, [...(events.get(task) ?? []), { cursor: 4, kind: 'text', role: 'user', request_id: body.request_id, text: d.draft.content.text }]);
        d.draft = { version: d.draft.version + 1, content: blank() }; d.summary.attachment.state = 'running';
      } else if (command.kind === 'rename') d.summary.task.title = command.title;
      else if (command.kind === 'archive') d.summary.task.archived = command.archived;
      else if (command.kind === 'stop') d.summary.attachment.state = 'stopping';
      else throw Error('Unexpected fixture command ' + command.kind);
      const receipt = { request_id: body.request_id, command: command.kind, task_id: task, input_assets: sentAssets, status: command.kind === 'send' ? 'submitted' : 'succeeded', submitted_draft_version: command.kind === 'send' ? command.draft_version : null };
      d.summary.observation_version++; d.receipts.push(receipt); output = { receipt, detail: copy(d) };
    }
    const running = command?.kind === 'send';
    const record = { operation: { operation_id: 'op-' + records.length, caller: { kind: 'plugin', id: view.view }, client_request_id: scoped, capability: body.capability, normalized_arguments: copy(body.arguments), preconditions: [] },
      status: running ? 'running' : 'succeeded', outcome: running ? null : 'succeeded', output: running ? null : output, error: null };
    records.push(record);
    if (command?.kind === 'save_draft' && saveDelay) await new Promise(done => setTimeout(done, saveDelay));
    return copy(record);
  }
  throw Error('Unexpected fixture request ' + body.type);
}
const frame = document.querySelector('iframe');
addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.data.type !== 'rho:view:ready' || event.data.nonce !== 'fixture-nonce') return;
  const channel = new MessageChannel(), connection = crypto.randomUUID(); let sequence = 0;
  channel.port1.onmessage = async ({ data: message }) => {
    let reply;
    try { reply = { ok: true, result: await handle(message.body) }; } catch (error) { reply = { ok: false, error: error.message }; }
    channel.port1.postMessage({ protocol_version: 1, connection, view: view.view, sequence: ++sequence, request: message.request, ...reply });
  };
  frame.contentWindow.postMessage({ type: 'rho:view:connect', nonce: 'fixture-nonce', protocol_version: 1, connection, view: copy(view), features: ['view_close_v1'] }, '*', [channel.port2]);
});
window.fixture = {
  snapshot: () => copy({ view, calls, details: [...details], records }),
  delaySave: milliseconds => { saveDelay = milliseconds; },
  loseAttachmentReply: () => { loseFinish = true; },
  close: () => { close = { phase: 'requested', operation: 'close-original' }; },
  reload: () => { frame.src = '/index.html#rho-view-nonce=fixture-nonce'; },
};
frame.src = '/index.html#rho-view-nonce=fixture-nonce';
