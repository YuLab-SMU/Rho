import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import './style.css';
import { connectPluginView } from '../public/plugin-ui/index.js';
import type { AgentProvider, AgentNativeToolSelection } from '../sdk/index.js';
import { NativeAgentModel, agentBusy } from './native-model.js';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const client = await connectPluginView();
let disposed = false, closing = false, composing = false, compositionEnded = -Infinity, renderedTask: string | null = null;
let polling = false, model: NativeAgentModel;
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const flights = new Set<Promise<unknown>>(), message = get<HTMLTextAreaElement>('message');
const providers: Record<AgentProvider, string> = { codex: 'Codex', kimi: 'Kimi Code', deepseek: 'DeepSeek Harness' };
function report(error: unknown) { if (!disposed) { get('error').textContent = error instanceof Error ? error.message : String(error); get('error').hidden = false; } }
function track<T>(work: Promise<T>) { flights.add(work); void work.then(() => flights.delete(work), () => flights.delete(work)); return work; }
function action(work: () => Promise<unknown>) {
  if (disposed || closing || composing) return;
  get('error').hidden = true;
  void track(Promise.resolve().then(work)).then(() => refresh()).catch(report).finally(render);
}
function selected() { return model.state.selected; }
function clearDraftTimers() { for (const timer of draftTimers.values()) clearTimeout(timer); draftTimers.clear(); }
function saveDraftSoon(task: string) {
  clearTimeout(draftTimers.get(task));
  draftTimers.set(task, setTimeout(() => {
    draftTimers.delete(task);
    if (disposed || closing || composing) return;
    if (model.busy) { saveDraftSoon(task); return; }
    if (!model.state.pending.some(p => p.task === task && p.kind === 'save_draft'))
      action(async () => { await model.save(); await model.flush(task); });
  }, 400));
}
function render() {
  if (!model || disposed) return;
  const id = selected(), detail = id ? model.details.get(id) : null, controlled = !!id && model.canControl(id), editable = controlled && !detail?.summary.task.archived;
  const running = !!detail && agentBusy(detail.summary.attachment.state), local = id ? model.state.drafts[id] : null;
  const tasks = model.page?.tasks.filter(task => task.reference.kind === 'native') ?? [];
  const selector = get<HTMLSelectElement>('task-selector'), list = get('task-list');
  const key = JSON.stringify(tasks.map(task => [task.reference, task.title, task.state]));
  if (selector.dataset.content !== key) {
    selector.dataset.content = key; selector.replaceChildren(new Option('Choose a task', '')); list.replaceChildren();
    for (const task of tasks) {
      if (task.reference.kind !== 'native') continue;
      const taskId = task.reference.task_id; selector.add(new Option(task.title, taskId));
      const button = document.createElement('button'); button.className = 'task'; button.dataset.task = taskId;
      const name = document.createElement('strong'), meta = document.createElement('small'); name.textContent = task.title;
      meta.textContent = `${task.provider ? providers[task.provider] : 'Rho'} · ${task.state.replaceAll('_', ' ')}`;
      button.append(name, meta); button.onclick = () => action(() => model.select(taskId)); list.append(button);
    }
  }
  selector.value = id ?? ''; for (const button of list.querySelectorAll<HTMLElement>('[data-task]')) button.setAttribute('aria-current', String(button.dataset.task === id));
  selector.disabled = model.busy || closing;
  get<HTMLButtonElement>('new-task').disabled = model.busy || closing || model.state.pending.some(p => p.kind === 'create' || p.kind === 'discover');
  get<HTMLButtonElement>('task-actions').disabled = !detail;
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
  const send = get<HTMLButtonElement>('send'); send.hidden = running; send.disabled = !editable || model.busy || !!local?.conflict || !message.value.trim() || closing;
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
  const eventKey = `${id}:${JSON.stringify(events)}`;
  if (transcript.dataset.content !== eventKey) {
    const following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 45;
    transcript.dataset.content = eventKey; transcript.replaceChildren();
    for (const event of events) {
      if (!event.text || ['reasoning', 'analysis', 'usage'].includes(event.kind) || ['reasoning', 'analysis'].includes(event.role ?? '')) continue;
      const block = document.createElement('div'); block.className = `event ${event.role === 'user' ? 'user' : event.role === 'assistant' ? 'assistant' : 'activity'}`;
      const role = document.createElement('span'); role.className = 'role'; role.textContent = event.role === 'user' ? 'You' : event.role === 'assistant' ? 'Agent' : 'Activity';
      block.append(role, document.createTextNode(event.text)); transcript.append(block);
    }
    if (!transcript.childNodes.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = detail ? 'Write a message to start this conversation.' : 'Choose or create a task.'; transcript.append(empty); }
    if (following) transcript.scrollTop = transcript.scrollHeight;
  }
  const permissions = get('permissions'), decisions = detail?.summary.attachment.decisions ?? [];
  permissions.hidden = !decisions.length; permissions.replaceChildren();
  for (const decision of decisions) {
    const title = document.createElement('p'); title.textContent = decision.title; permissions.append(title);
    for (const option of decision.options) { const button = document.createElement('button'); button.textContent = option.label; button.disabled = !editable || model.busy;
      button.onclick = () => action(() => model.decide(id!, decision.id, option.id)); permissions.append(button); }
  }
  get('session-details').textContent = detail ? `Native session: ${detail.summary.task.native_session_id ?? 'Created on first Send'}\n${detail.summary.unconfirmed} unconfirmed request(s)\n${detail.summary.attachment.capabilities.history ?? 'Observation cache'}` : '';
  get('archived').textContent = model.state.archived ? 'Active tasks' : 'Archived tasks';
  get('archive-task').textContent = detail?.summary.task.archived ? 'Unarchive' : 'Archive';
}
async function refresh() {
  if (polling || disposed || closing) return;
  polling = true;
  try {
    await model.refresh();
    // Accepted parent Operations are observations only. A missing admission
    // stays behind an explicit status/continuation action.
    for (const pending of [...model.state.pending]) if (pending.intent.operation && pending.status !== 'uncertain') await model.inspect(pending.intent.request);
  } finally { polling = false; render(); }
}
function changedText() {
  if (composing || disposed || closing || !selected()) return;
  try { model.edit(selected()!, { ...model.draft(selected()!), text: message.value }); } catch (error) { report(error); return; }
  saveDraftSoon(selected()!);
  render();
}
model = new NativeAgentModel(client, render);
message.addEventListener('compositionstart', () => { composing = true; compositionEnded = -Infinity; clearDraftTimers(); });
message.addEventListener('compositionend', () => { composing = false; compositionEnded = performance.now(); changedText(); });
message.addEventListener('input', changedText);
message.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || composing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault(); if (performance.now() - compositionEnded < 100) return;
    const id = selected(); if (id && !get<HTMLButtonElement>('send').disabled && !get('send').hidden) action(() => model.send(id));
  }
});
get('send').onclick = () => { const id = selected(); if (id) action(() => model.send(id)); };
get('save-draft').onclick = () => { const id = selected(); if (id) action(async () => { await model.save(); await model.flush(id); }); };
get('stop').onclick = () => { const id = selected(); if (id) action(() => model.stop(id)); };
get('resume').onclick = () => { const id = selected(); if (id) action(() => model.resume(id)); };
get('take-over').onclick = () => { const id = selected(); if (id) action(() => model.takeOver(id, agentBusy(model.details.get(id)?.summary.attachment.state ?? '') || !!model.details.get(id)?.summary.attachment.control_frozen)); };
get('inspect-original').onclick = () => { const pending = model.state.pending.find(p => p.task === selected() || p.task === null); if (pending) action(() => model.inspect(pending.intent.request)); };
get('continue-original').onclick = () => { const pending = model.state.pending.find(p => p.task === selected() || p.task === null); if (pending) action(() => model.continueOriginal(pending.intent.request)); };
get('keep-draft').onclick = () => { if (selected()) action(() => model.resolveDraft(selected()!, true)); };
get('use-draft').onclick = () => { if (selected()) action(() => model.resolveDraft(selected()!, false)); };
get('archived').onclick = () => action(async () => { model.state.archived = !model.state.archived; await model.save(); });
get('show-details').onclick = () => { get('session-details').hidden = !get('session-details').hidden; get('actions-menu').hidePopover(); };
get('archive-task').onclick = () => { get('actions-menu').hidePopover(); if (selected()) action(() => model.archive(selected()!, !model.details.get(selected()!)?.summary.task.archived)); };
get<HTMLSelectElement>('task-selector').onchange = event => { const id = (event.target as HTMLSelectElement).value; if (id) action(() => model.select(id)); };
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
get('rename-task').onclick = () => { get('actions-menu').hidePopover(); get<HTMLInputElement>('title').value = model.details.get(selected()!)?.summary.task.title ?? ''; get<HTMLDialogElement>('rename-dialog').showModal(); };
get('cancel-rename').onclick = () => get<HTMLDialogElement>('rename-dialog').close();
get('rename-form').onsubmit = event => { event.preventDefault(); const title = get<HTMLInputElement>('title').value, id = selected(); get<HTMLDialogElement>('rename-dialog').close(); if (id) action(() => model.rename(id, title)); };
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
    if (Object.values(model.state.drafts).some(draft => draft.dirty)) throw Error('A task draft is not saved yet. Keep this view open and finish saving it before closing.');
  },
  resume() { closing = false; render(); },
});
await refresh().catch(report); render();
const poll = setInterval(() => { void refresh().catch(report); }, 1000);
addEventListener('pagehide', () => { disposed = true; clearDraftTimers(); clearInterval(poll); model.dispose(); client.dispose(); }, { once: true });
