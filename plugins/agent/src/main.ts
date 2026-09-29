import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import './style.css';
import { connectPluginView } from '../public/plugin-ui/index.js';
import type { AgentProvider, AgentNativeToolSelection, ProjectAgentTaskRef } from '../sdk/index.js';
import { NativeAgentModel, agentBusy } from './native-model.js';
import { mountSettings } from './settings-view.js';
import { RhoModel, rhoBusy } from './rho-model.js';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const client = await connectPluginView();
let disposed = false, closing = false, composing = false, compositionEnded = -Infinity, renderedTask: string | null = null;
let polling = false, model: NativeAgentModel, rho: RhoModel;
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const flights = new Set<Promise<unknown>>(), message = get<HTMLTextAreaElement>('message');
const positions = new Map<string, { event: string; offset: number }>();
const providers: Record<AgentProvider, string> = { codex: 'Codex', kimi: 'Kimi Code', deepseek: 'DeepSeek Harness' };
function report(error: unknown) { if (!disposed) { get('error').textContent = error instanceof Error ? error.message : String(error); get('error').hidden = false; } }
function track<T>(work: Promise<T>) { flights.add(work); void work.then(() => flights.delete(work), () => flights.delete(work)); return work; }
function action(work: () => Promise<unknown>) {
  if (disposed || closing || composing) return;
  get('error').hidden = true;
  void track(Promise.resolve().then(work)).then(() => refresh()).catch(report).finally(render);
}
function selected() { return model.state.selected; }
function rhoSelected() { return rho?.state.selected; }
const taskKey = (reference: ProjectAgentTaskRef) => reference.kind === 'rho' ? `rho:${reference.conversation_id}` : `native:${reference.task_id}`;
function selectTask(value: string) { return value.startsWith('rho:') ? rho.select(value.slice(4)) : model.select(value.slice(7)); }
let resumingUpload: string | null = null;
const fileInput = get<HTMLInputElement>('attachment-file');
function clearDraftTimers() { for (const timer of draftTimers.values()) clearTimeout(timer); draftTimers.clear(); }
function saveDraftSoon(task: string, kind: 'native' | 'rho' = 'native') {
  const key = `${kind}:${task}`;
  clearTimeout(draftTimers.get(key));
  draftTimers.set(key, setTimeout(() => {
    draftTimers.delete(key);
    if (disposed || closing || composing) return;
    if (model.busy || rho.busy) { saveDraftSoon(task, kind); return; }
    const target = kind === 'rho' ? rho : model, pendingKind = kind === 'rho' ? 'draft' : 'save_draft';
    if (!target.state.pending.some(p => p.task === task && p.kind === pendingKind))
      action(async () => { await model.save(); await target.flush(task); });
  }, 400));
}
function render() {
  if (!model || disposed) return;
  const id = selected(), detail = id ? model.details.get(id) : null, controlled = !!id && model.canControl(id), editable = controlled && !detail?.summary.task.archived;
  const running = !!detail && agentBusy(detail.summary.attachment.state), local = id ? model.state.drafts[id] : null;
  const rid = rhoSelected(), conversation = rid ? rho.conversations.get(rid) : null;
  const activeKey = rid ? `rho:${rid}` : id ? `native:${id}` : '';
  const tasks = model.page?.tasks ?? [];
  const selector = get<HTMLSelectElement>('task-selector'), list = get('task-list');
  const key = JSON.stringify([tasks.map(task => [task.reference, task.title, task.state]), activeKey, detail?.summary.task.title, conversation?.title]);
  if (selector.dataset.content !== key) {
    selector.dataset.content = key; selector.replaceChildren(new Option('Choose a task', '')); list.replaceChildren();
    for (const task of tasks) {
      const taskId = taskKey(task.reference); selector.add(new Option(task.title, taskId));
      const button = document.createElement('button'); button.className = 'task'; button.dataset.task = taskId;
      const name = document.createElement('strong'), meta = document.createElement('small'); name.textContent = task.title;
      meta.textContent = `${task.provider ? providers[task.provider] : 'Rho'} · ${task.state.replaceAll('_', ' ')}`;
      button.append(name, meta); button.onclick = () => action(() => selectTask(taskId)); list.append(button);
    }
    if (activeKey && !tasks.some(task => taskKey(task.reference) === activeKey))
      selector.add(new Option(conversation?.title ?? detail?.summary.task.title ?? 'Unconfirmed task', activeKey));
  }
  selector.value = activeKey; for (const button of list.querySelectorAll<HTMLElement>('[data-task]')) button.setAttribute('aria-current', String(button.dataset.task === activeKey));
  selector.disabled = model.busy || rho.busy || closing;
  get('task-pages').hidden = !model.page?.next && !model.newerTasksAvailable;
  get<HTMLButtonElement>('newer-tasks').disabled = model.taskLoading || !model.newerTasksAvailable || closing;
  get<HTMLButtonElement>('older-tasks').disabled = model.taskLoading || !model.page?.next || closing;
  get<HTMLButtonElement>('new-task').disabled = model.busy || rho.busy || closing || model.state.pending.some(p => p.kind === 'create' || p.kind === 'discover') || rho.state.pending.some(p => p.kind === 'create');
  get<HTMLButtonElement>('task-actions').disabled = closing;
  get('archived').textContent = model.state.archived ? 'Active tasks' : 'Archived tasks';
  if (rid) { renderRho(rid); return; }
  get('configure-rho').hidden = true;
  get<HTMLButtonElement>('tools').disabled = closing || !((client.view.configuration as {tools?: unknown[]}).tools?.length);
  for (const id of ['rename-task', 'archive-task', 'show-details']) get<HTMLButtonElement>(id).disabled = !detail;
  get('task-state').textContent = !detail ? 'Choose or create a task' : detail.summary.task.archived ? 'Archived task' : !controlled ? 'Read-only · Another view' :
    `${providers[detail.summary.task.provider]} · ${detail.summary.attachment.state.replaceAll('_', ' ')}${detail.summary.history_gap ? ' · Earlier messages unavailable' : ''}`;
  const takeover = get<HTMLButtonElement>('take-over'); takeover.hidden = !detail || controlled; takeover.disabled = model.busy;
  takeover.textContent = running || detail?.summary.attachment.control_frozen ? 'Stop Agent and take over' : 'Take over';
  get('resume').hidden = !editable || !detail?.summary.task.native_session_id || !['disconnected', 'uncertain'].includes(detail.summary.attachment.state);
  get<HTMLButtonElement>('resume').disabled = model.busy;
  message.readOnly = !editable || closing; message.disabled = !detail;
  if (!composing && (renderedTask !== id || document.activeElement !== message || !local?.dirty)) {
    const text = id ? model.draft(id).text : ''; if (message.value !== text) message.value = text; renderedTask = id;
  }
  get('draft-status').textContent = !editable ? '' : local?.conflict ? 'Draft conflict' : local?.dirty ? 'Draft not saved yet' : 'Draft saved';
  const saveDraft = get<HTMLButtonElement>('save-draft'); saveDraft.hidden = !editable || !local?.dirty || !!local.conflict;
  saveDraft.disabled = model.busy || closing || model.state.pending.some(p => p.task === id && p.kind === 'save_draft');
  renderAttachments(id, editable);
  const send = get<HTMLButtonElement>('send'); send.hidden = running; send.disabled = !editable || model.busy || !!local?.conflict || !(message.value.trim() || (id && model.draft(id).assets.length)) || closing;
  get('stop').hidden = !running; get<HTMLButtonElement>('stop').disabled = !editable || model.busy || closing;
  get('draft-conflict').hidden = !local?.conflict;
  const pending = model.state.pending.find(p => p.task === id || p.task === null);
  get('recovery').hidden = !pending || pending.kind === 'send' && pending.status === 'running';
  get('recovery-status').textContent = pending?.status ? `Original request · ${pending.status}` : 'An original request needs inspection.';
  get<HTMLButtonElement>('inspect-original').disabled = model.busy;
  get('continue-original').hidden = !pending || pending.intent.operation !== null;
  get<HTMLButtonElement>('continue-original').disabled = model.busy;
  const modelSelect = get<HTMLSelectElement>('model'), catalog = detail ? model.state.catalogs[detail.summary.task.provider] : null;
  const models = detail?.summary.attachment.capabilities.models ?? catalog?.models ?? [];
  const choices = models.length ? models : detail ? [{ id: detail.summary.task.model, name: detail.summary.task.model }] : [];
  if (modelSelect.dataset.content !== JSON.stringify(choices)) {
    modelSelect.dataset.content = JSON.stringify(choices); modelSelect.replaceChildren(...choices.map(item => new Option(item.name, item.id)));
  }
  modelSelect.value = detail?.summary.task.model ?? ''; modelSelect.disabled = !editable || model.busy || running;
  const transcript = get('transcript'), events = id ? model.events.get(id) ?? [] : [];
  const history = id ? model.history.states.get(id) : null;
  const earlier = !!detail && model.history.canReadEarlier(detail);
  get('history-controls').hidden = !earlier && !history?.browsing && !history?.gap && !history?.partial;
  get('earlier-messages').hidden = !earlier;
  get<HTMLButtonElement>('earlier-messages').disabled = !!history?.loading || closing;
  get('latest-messages').hidden = !history?.browsing;
  get<HTMLButtonElement>('latest-messages').disabled = !!history?.loading || closing;
  get('history-note').textContent = history?.gap ? 'Earlier messages unavailable' : history?.partial ? 'Partial history' : '';
  const eventKey = `${id}:${JSON.stringify([events, detail?.assets, detail?.receipts.map(r => [r.request_id, r.input_assets])])}`;
  if (transcript.dataset.content !== eventKey) {
    const following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 45;
    const top = transcript.getBoundingClientRect().top, oldTask = transcript.dataset.task;
    const visible = [...transcript.querySelectorAll<HTMLElement>('[data-event]')].find(event => event.getBoundingClientRect().bottom > top);
    if (oldTask && visible) positions.set(oldTask, { event: visible.dataset.event!, offset: visible.getBoundingClientRect().top - top });
    const position = id ? positions.get(id) : null;
    transcript.dataset.task = id ?? '';
    transcript.dataset.content = eventKey; transcript.replaceChildren();
    for (const event of events) {
      if (!event.text || ['reasoning', 'analysis', 'usage'].includes(event.kind) || ['reasoning', 'analysis'].includes(event.role ?? '')) continue;
      const block = document.createElement('div'); block.className = `event ${event.role === 'user' ? 'user' : event.role === 'assistant' ? 'assistant' : 'activity'}`;
      block.dataset.event = event.event_id;
      const role = document.createElement('span'); role.className = 'role'; role.textContent = event.role === 'user' ? 'You' : event.role === 'assistant' ? 'Agent' : 'Activity';
      if (event.source === 'native_history') role.textContent += ' · Native history';
      block.append(role, document.createTextNode(event.text));
      const receipt = event.role === 'user' ? detail?.receipts.find(item => item.request_id === event.request_id) : null;
      if (receipt?.input_assets.length) {
        const files = document.createElement('small'); files.className = 'sent-attachments';
        files.textContent = receipt.input_assets.map(asset => detail?.assets.find(item => item.asset_id === asset)?.name ?? 'Attachment unavailable').join(' · '); block.append(files);
      }
      transcript.append(block);
    }
    if (!transcript.childNodes.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = detail ? 'Write a message to start this conversation.' : 'Choose or create a task.'; transcript.append(empty); }
    if (!history?.browsing && (following || oldTask !== id)) transcript.scrollTop = transcript.scrollHeight;
    else if (position) {
      const anchor = [...transcript.querySelectorAll<HTMLElement>('[data-event]')].find(event => event.dataset.event === position.event);
      if (anchor) transcript.scrollTop += anchor.getBoundingClientRect().top - top - position.offset;
    }
  }
  const permissions = get('permissions'), decisions = detail?.summary.attachment.decisions ?? [];
  permissions.hidden = !decisions.length; permissions.replaceChildren();
  for (const decision of decisions) {
    const title = document.createElement('p'); title.textContent = decision.title; permissions.append(title);
    for (const option of decision.options) { const button = document.createElement('button'); button.textContent = option.label; button.disabled = !editable || model.busy;
      button.onclick = () => action(() => model.decide(id!, decision.id, option.id)); permissions.append(button); }
  }
  get('session-details').textContent = detail ? `Native session: ${detail.summary.task.native_session_id ?? 'Created on first Send'}\n${detail.summary.unconfirmed} unconfirmed request(s)\n${history?.source ?? detail.summary.attachment.capabilities.history ?? 'Observation cache'}` : '';
  get('archived').textContent = model.state.archived ? 'Active tasks' : 'Archived tasks';
  get('archive-task').textContent = detail?.summary.task.archived ? 'Unarchive' : 'Archive';
}
function renderRho(id: string) {
  const conversation = rho.conversations.get(id), local = rho.state.drafts[id], controlled = rho.canControl(id), editable = controlled && !conversation?.archived;
  const active = conversation?.active_run_id ? rho.runs.get(conversation.active_run_id) : null;
  const running = !!active && rhoBusy(active.state), orphan = !!conversation?.active_run_id && active?.state === 'interrupted';
  for (const key of ['rename-task', 'archive-task', 'show-details']) get<HTMLButtonElement>(key).disabled = !conversation;
  get('task-state').textContent = !conversation ? 'Reading Rho task…' : conversation.archived ? 'Archived task' : !controlled ? 'Read-only · Another view' : orphan ? 'Rho · Interrupted request' : running ? `Rho · ${active!.state.replaceAll('_', ' ')}` : 'Rho · Ready';
  const takeover = get<HTMLButtonElement>('take-over'); takeover.hidden = !conversation || controlled && !orphan; takeover.disabled = rho.busy;
  takeover.textContent = running ? 'Stop Rho and take over' : 'Take over';
  get('resume').hidden = true;
  const configured = !!rho.settings?.enabled && !!rho.settings.connection;
  get('configure-rho').hidden = configured || !editable;
  message.readOnly = !editable || closing; message.disabled = !conversation;
  if (!composing && (renderedTask !== `rho:${id}` || document.activeElement !== message || !local?.dirty)) { message.value = rho.draft(id).text; renderedTask = `rho:${id}`; }
  get('draft-status').textContent = !editable ? '' : local?.conflict ? 'Draft conflict' : local?.dirty ? 'Draft not saved yet' : 'Draft saved';
  const save = get<HTMLButtonElement>('save-draft'); save.hidden = !editable || !local?.dirty || !!local.conflict; save.disabled = rho.busy || closing || rho.state.pending.some(p => p.task === id && p.kind === 'draft');
  get('attachments').replaceChildren(); get('attachments').dataset.content = ''; get('uploads').replaceChildren(); get('uploads').dataset.content = '';
  get<HTMLButtonElement>('attach').disabled = true; get<HTMLButtonElement>('tools').disabled = true;
  const send = get<HTMLButtonElement>('send'); send.hidden = running; send.disabled = !editable || !configured || rho.busy || closing || !!local?.conflict || !!conversation?.active_run_id || !message.value.trim() || rho.state.pending.some(p => p.task === id && p.kind === 'run');
  get('stop').hidden = !running; get<HTMLButtonElement>('stop').disabled = !controlled || rho.busy || closing;
  get('draft-conflict').hidden = !local?.conflict;
  const pending = rho.state.pending.find(p => p.task === id);
  get('recovery').hidden = !pending || pending.kind === 'run' && pending.status === 'running';
  get('recovery-status').textContent = pending?.status ? `Original request · ${pending.status}` : 'An original request needs inspection.';
  get<HTMLButtonElement>('inspect-original').disabled = rho.busy; get('continue-original').hidden = !pending || pending.intent.operation !== null; get<HTMLButtonElement>('continue-original').disabled = rho.busy;
  const select = get<HTMLSelectElement>('model'); select.dataset.content = `rho:${rho.settings?.version}`; select.replaceChildren(new Option(rho.settings?.connection?.model ?? 'Configure Rho', 'rho')); select.disabled = true;
  const history = rho.history.get(id), earlier = !!history?.page.next;
  get('history-controls').hidden = !earlier && !history?.before; get('earlier-messages').hidden = !earlier; get<HTMLButtonElement>('earlier-messages').disabled = rho.busy || closing;
  get('latest-messages').hidden = !history?.before; get<HTMLButtonElement>('latest-messages').disabled = rho.busy || closing; get('history-note').textContent = history?.before ? 'Earlier turns' : '';
  const transcript = get('transcript'), rows = [...(history?.page.runs ?? [])].reverse();
  const signature = JSON.stringify([id, rows, rows.map(row => [rho.runs.get(row.run_id), rho.transcripts.get(row.run_id)])]);
  if (transcript.dataset.content !== signature) {
    const following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 45, oldTask = transcript.dataset.task;
    const top = transcript.getBoundingClientRect().top, visible = [...transcript.querySelectorAll<HTMLElement>('[data-event]')].find(node => node.getBoundingClientRect().bottom > top);
    const position = visible ? {id:visible.dataset.event,offset:visible.getBoundingClientRect().top-top} : null;
    transcript.dataset.task = `rho:${id}`; transcript.dataset.content = signature; transcript.replaceChildren();
    function block(role: string, text: string, event: string) { const node = document.createElement('div'), label = document.createElement('span'); node.className = `event ${role === 'You' ? 'user' : 'assistant'}`; node.dataset.event = event; label.className = 'role'; label.textContent = role; node.append(label, document.createTextNode(text)); transcript.append(node); }
    for (const row of rows) {
      const run = rho.runs.get(row.run_id), history = rho.transcripts.get(row.run_id);
      block('You', run?.request.text ?? row.text_excerpt, `${row.run_id}:user`);
      if (history?.text) block('Rho', history.text, `${row.run_id}:answer`);
      block('Activity', [row.state.replaceAll('_', ' '), run?.reason, history?.gap ? 'Earlier messages unavailable' : '', history?.partial || run && history && history.cursor < run.event_cursor ? 'Partial history' : ''].filter(Boolean).join(' · '), `${row.run_id}:state`);
    }
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = configured ? 'Write a message to start this conversation.' : 'Choose and enable a model in Settings to start using Rho.'; transcript.append(empty); }
    if (!history?.before && (following || oldTask !== `rho:${id}`)) transcript.scrollTop = transcript.scrollHeight;
    else if (position) { const anchor = [...transcript.querySelectorAll<HTMLElement>('[data-event]')].find(node => node.dataset.event === position.id); if (anchor) transcript.scrollTop += anchor.getBoundingClientRect().top - top - position.offset; }
  }
  get('permissions').hidden = true; get('permissions').replaceChildren();
  get('session-details').textContent = conversation ? `Rho task: ${id}\n${rho.state.pending.filter(p => p.task === id).length} unconfirmed request(s)\n${active ? `Original run: ${active.run_id}` : 'No active run'}` : '';
  get('archive-task').textContent = conversation?.archived ? 'Unarchive' : 'Archive';
}
function renderAttachments(task: string | null, editable: boolean) {
  get<HTMLButtonElement>('attach').disabled = !editable || model.busy || closing;
  const area = get('attachments'), selectedAssets = task ? model.draft(task).assets : [];
  const assets = task ? model.details.get(task)?.assets ?? [] : [];
  const key = JSON.stringify([selectedAssets, assets, editable, model.busy, closing]);
  if (area.dataset.content !== key) {
    area.dataset.content = key; area.replaceChildren();
    for (const id of selectedAssets) {
      const asset = assets.find(item => item.asset_id === id), row = document.createElement('div'); row.className = 'attachment';
      const label = document.createElement('span'); label.textContent = asset ? `${asset.name} · ${Math.ceil(asset.bytes / 1024)} KiB` : 'Attachment unavailable';
      const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${asset?.name ?? 'attachment'} from draft`);
      remove.disabled = !editable || model.busy || closing;
      remove.onclick = () => { model.edit(task!, { ...model.draft(task!), assets: model.draft(task!).assets.filter(item => item !== id) }); saveDraftSoon(task!); };
      row.append(label, remove); area.append(row);
    }
  }
  const transfers = get('uploads'), pending = model.uploads.filter(p => p.upload.control.task_id === task);
  const transferKey = JSON.stringify([pending, model.busy, editable, closing]);
  if (transfers.dataset.content === transferKey) return;
  transfers.dataset.content = transferKey; transfers.replaceChildren();
  for (const item of pending) {
    const row = document.createElement('div'); row.className = 'upload';
    const label = document.createElement('span'); label.textContent = `${item.upload.name} · ${item.phase === 'imported' ? 'Ready to add' : model.busy ? 'Uploading…' : 'Transfer needs review'}`;
    const status = document.createElement('button'); status.textContent = 'Check status'; status.disabled = model.busy || closing;
    status.onclick = () => action(() => model.inspectUpload(item.upload.request_id));
    const resume = document.createElement('button'); resume.textContent = item.phase === 'imported' ? 'Add to draft' : 'Reselect original file'; resume.disabled = model.busy || !editable || closing;
    resume.onclick = () => {
      if (item.phase === 'imported') action(async () => { await model.addUploaded(item.upload.request_id); await model.flush(item.upload.control.task_id); });
      else { resumingUpload = item.upload.request_id; fileInput.multiple = false; fileInput.click(); }
    };
    row.append(label, status, resume); transfers.append(row);
  }
}
function attachFiles(files: File[]) {
  if (rhoSelected() && files.length) { report(Error('File attachments are not available for this Rho task yet. Your draft is retained.')); return; }
  const task = selected(); if (!task || !files.length) return;
  const original = resumingUpload; resumingUpload = null;
  action(async () => {
    if (files.length > 16) throw Error('Select at most 16 files at a time.');
    for (const file of files) {
      if (original) await model.resumeUpload(original, file, file.name); else await model.attachFile(task, file, file.name);
      await model.flush(task);
    }
  });
}
async function refresh() {
  if (polling || disposed || closing) return;
  polling = true;
  try {
    await model.refresh();
    // Accepted parent Operations are observations only. A missing admission
    // stays behind an explicit status/continuation action.
    for (const pending of [...model.state.pending]) if (pending.intent.operation && pending.status !== 'uncertain') await model.inspect(pending.intent.request);
    await rho.refresh();
    await settings.refresh();
  } finally { polling = false; render(); }
}
function changedText() {
  const task = rhoSelected() ?? selected(), target = rhoSelected() ? rho : model;
  if (composing || disposed || closing || !task) return;
  try { target.edit(task, { ...target.draft(task), text: message.value }); } catch (error) { report(error); return; }
  saveDraftSoon(task, rhoSelected() ? 'rho' : 'native');
  render();
}
model = new NativeAgentModel(client, render);
rho = new RhoModel(client, model, render);
const settings = mountSettings(client, model, track);
message.addEventListener('compositionstart', () => { composing = true; compositionEnded = -Infinity; clearDraftTimers(); });
message.addEventListener('compositionend', () => { composing = false; compositionEnded = performance.now(); changedText(); });
message.addEventListener('input', changedText);
message.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || composing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault(); if (performance.now() - compositionEnded < 100) return;
    const id = rhoSelected() ?? selected(); if (id && !get<HTMLButtonElement>('send').disabled && !get('send').hidden) action(() => rhoSelected() ? rho.send(id) : model.send(id));
  }
});
get('attach').onclick = () => { resumingUpload = null; fileInput.multiple = true; fileInput.click(); };
fileInput.onchange = () => { attachFiles(Array.from(fileInput.files ?? [])); fileInput.value = ''; };
get('agent').addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
get('agent').addEventListener('drop', event => { event.preventDefault(); if (event.dataTransfer?.files.length) { resumingUpload = null; attachFiles(Array.from(event.dataTransfer.files)); } });
message.addEventListener('paste', event => { if (event.clipboardData?.files.length) { event.preventDefault(); resumingUpload = null; attachFiles(Array.from(event.clipboardData.files)); } });
get('send').onclick = () => { const id = rhoSelected() ?? selected(), target = rhoSelected() ? rho : model; if (id) action(() => target.send(id)); };
get('save-draft').onclick = () => { const id = rhoSelected() ?? selected(), target = rhoSelected() ? rho : model; if (id) action(async () => { await model.save(); await target.flush(id); }); };
get('stop').onclick = () => { const id = rhoSelected() ?? selected(), target = rhoSelected() ? rho : model; if (id) action(() => target.stop(id)); };
get('resume').onclick = () => { const id = selected(); if (id) action(() => model.resume(id)); };
get('take-over').onclick = () => { const rid = rhoSelected(), id = selected(); if (rid) action(() => rho.takeOver(rid)); else if (id) action(() => model.takeOver(id, agentBusy(model.details.get(id)?.summary.attachment.state ?? '') || !!model.details.get(id)?.summary.attachment.control_frozen)); };
get('inspect-original').onclick = () => { const rid = rhoSelected(); if (rid) { const p = rho.state.pending.find(p => p.task === rid); if (p) action(() => rho.inspect(p.intent.request)); } else { const p = model.state.pending.find(p => p.task === selected() || p.task === null); if (p) action(() => model.inspect(p.intent.request)); } };
get('continue-original').onclick = () => { const rid = rhoSelected(); if (rid) { const p = rho.state.pending.find(p => p.task === rid); if (p) action(() => rho.retry(p.intent.request)); } else { const p = model.state.pending.find(p => p.task === selected() || p.task === null); if (p) action(() => model.continueOriginal(p.intent.request)); } };
get('keep-draft').onclick = () => { const id = rhoSelected() ?? selected(), target = rhoSelected() ? rho : model; if (id) action(() => target.resolveDraft(id, true)); };
get('use-draft').onclick = () => { const id = rhoSelected() ?? selected(), target = rhoSelected() ? rho : model; if (id) action(() => target.resolveDraft(id, false)); };
get('archived').onclick = () => action(() => model.setArchived(!model.state.archived));
get('older-tasks').onclick = () => action(() => model.olderTasks());
get('newer-tasks').onclick = () => action(() => model.newerTasks());
get('earlier-messages').onclick = () => { const rid = rhoSelected(), detail = model.details.get(selected()!); if (rid) action(() => rho.earlier(rid)); else if (detail) action(() => model.history.earlier(detail)); };
get('latest-messages').onclick = () => { const rid = rhoSelected(), detail = model.details.get(selected()!); if (rid) action(() => rho.latest(rid)); else if (detail) action(() => model.history.latest(detail)); };
get('show-details').onclick = () => { get('session-details').hidden = !get('session-details').hidden; get('actions-menu').hidePopover(); };
get('archive-task').onclick = () => { get('actions-menu').hidePopover(); const rid = rhoSelected(); if (rid) action(() => rho.archive(rid, !rho.conversations.get(rid)?.archived)); else if (selected()) action(() => model.archive(selected()!, !model.details.get(selected()!)?.summary.task.archived)); };
get<HTMLSelectElement>('task-selector').onchange = event => { const id = (event.target as HTMLSelectElement).value; if (id) action(() => selectTask(id)); };
get('new-rho-task').onclick = () => { get('new-menu').hidePopover(); action(() => rho.create()); };
get('configure-rho').onclick = () => get('open-settings').click();
get<HTMLSelectElement>('model').onchange = event => {
  const id = selected(), detail = id ? model.details.get(id) : null;
  if (detail) action(() => model.configure(id!, (event.target as HTMLSelectElement).value, null, detail.summary.task.mode));
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-provider]')) button.onclick = () => {
  get('new-menu').hidePopover(); action(() => model.newTask(button.dataset.provider as AgentProvider));
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[popovertarget]')) {
  const menu = get(button.getAttribute('popovertarget')!);
  menu.addEventListener('toggle', () => {
    if (!menu.matches(':popover-open')) return;
    const anchor = button.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, anchor.bottom + bounds.height + 8 <= innerHeight ? anchor.bottom + 4 : anchor.top - bounds.height - 4)}px`;
  });
}
get('rename-task').onclick = () => { get('actions-menu').hidePopover(); get<HTMLInputElement>('title').value = rhoSelected() ? rho.conversations.get(rhoSelected()!)?.title ?? '' : model.details.get(selected()!)?.summary.task.title ?? ''; get<HTMLDialogElement>('rename-dialog').showModal(); };
get('cancel-rename').onclick = () => get<HTMLDialogElement>('rename-dialog').close();
get('save-title').onclick = () => { if (!get<HTMLFormElement>('rename-form').reportValidity()) return; const title = get<HTMLInputElement>('title').value, id = rhoSelected() ?? selected(), target = rhoSelected() ? rho : model; get<HTMLDialogElement>('rename-dialog').close(); if (id) action(() => target.rename(id, title)); };
get('rename-form').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); get<HTMLButtonElement>('save-title').click(); } };
const tools = (client.view.configuration as { tools?: AgentNativeToolSelection[] }).tools ?? [];
get<HTMLButtonElement>('tools').disabled = !tools.length;
for (const tool of tools) {
  const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = model.state.tools.some(item => JSON.stringify(item) === JSON.stringify(tool));
  label.append(checkbox, document.createTextNode(tool.name)); get('tools-menu').append(label);
  checkbox.onchange = () => action(async () => { model.state.tools = model.state.tools.filter(item => JSON.stringify(item) !== JSON.stringify(tool)); if (checkbox.checked) model.state.tools.push(structuredClone(tool)); await model.save(); });
}
await client.installCloseHandler({
  async flush() {
    closing = true; clearDraftTimers(); if (composing) throw Error('Finish the current text composition before closing.');
    await Promise.all([...flights]); await model.save();
    settings.prepareClose();
    if ([...Object.values(model.state.drafts), ...Object.values(rho.state.drafts)].some(draft => draft.dirty)) throw Error('A task draft is not saved yet. Keep this view open and finish saving it before closing.');
  },
  resume() { closing = false; render(); },
});
await refresh().catch(report); render();
const poll = setInterval(() => { void refresh().catch(report); }, 1000);
addEventListener('pagehide', () => { disposed = true; clearDraftTimers(); clearInterval(poll); settings.dispose(); rho.dispose(); model.dispose(); client.dispose(); }, { once: true });
