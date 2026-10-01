import type { AgentContextSelection, ProjectAgentTaskPage, ProjectAgentTaskRef, ProjectAgentTaskSummary } from '../sdk/index.js';
import type { NativeAgentModel } from './native-model.js';
import type { RhoModel } from './rho-model.js';
import { ContextPicker, contextInputIssue } from './context-model.js';
import { HandoffModel, handoffKey } from './handoff-model.js';
import { same, type Client } from './operations.js';

export function mountHandoff(client: Client, native: NativeAgentModel, rho: RhoModel,
  track: <T>(work: Promise<T>) => Promise<T>, changed: () => void) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = get('handoff'), input = get<HTMLTextAreaElement>('handoff-text'), select = get<HTMLSelectElement>('handoff-target');
  const picker = new ContextPicker(client);
  let current: ProjectAgentTaskRef | null = null, disposed = false, closing = false, composing = false;
  let error = '', timer: ReturnType<typeof setTimeout> | undefined, pageRead = 0, previewRead = 0;
  let tasks: ProjectAgentTaskSummary[] = [], pages: (string | null)[] = [null], next: string | null = null, loading = false, tasksLoaded = false;
  const taskOwner = (ref: ProjectAgentTaskRef) => ref.kind === 'rho' ? { owner: rho, id: ref.conversation_id } : { owner: native, id: ref.task_id };
  async function synchronize(ref: ProjectAgentTaskRef) {
    const { owner, id } = taskOwner(ref); await owner.observe(id); await owner.flush(id);
    if (owner.state.drafts[id]?.dirty || owner.state.pending.some(p => p.task === id && ['draft', 'save_draft', 'create'].includes(p.kind)))
      throw Error('Confirm the task draft before reviewing the handoff. Local input is retained.');
  }
  const model = new HandoffModel(client, native, synchronize, async ref => { const { owner, id } = taskOwner(ref); await owner.observe(id); }, changed);
  function run(work: () => Promise<unknown>) {
    if (disposed || closing || composing) return;
    error = ''; void track(Promise.resolve().then(work)).catch(value => {
      if (!disposed) error = value instanceof Error ? value.message : String(value);
    }).finally(() => { if (!disposed) { render(current, closing); changed(); } });
  }
  async function readTasks(cursors = [null] as (string | null)[]) {
    const ticket = ++pageRead; loading = true; render(current, closing);
    try {
      const page = await native.read<ProjectAgentTaskPage>('agent.tasks', { archived: false, before: cursors.at(-1), limit: 20 });
      if (disposed || ticket !== pageRead) return;
      if (page.tasks.length > 20 || page.tasks.some(task => task.archived) || page.next && cursors.includes(page.next)) throw Error('The target task page changed. Reload the task list.');
      tasks = page.tasks; next = page.next; pages = cursors; tasksLoaded = true;
    } finally { if (ticket === pageRead) { loading = false; render(current, closing); } }
  }
  function clearPreview() { previewRead++; get('handoff-preview-area').hidden = true; get('handoff-preview').textContent = ''; }
  async function preview(selection: AgentContextSelection) {
    const ticket = ++previewRead; get('handoff-preview-area').hidden = false;
    get('handoff-preview').textContent = 'Reading the original source…';
    try {
      const { preview } = await picker.retained(selection);
      if (disposed || ticket !== previewRead) return;
      get('handoff-preview-title').textContent = preview.item.title;
      get('handoff-preview').textContent = preview.text;
      get('handoff-preview-note').textContent = contextInputIssue(preview) ?? (preview.resources.length ? 'The selected images will be checked again when the target task sends.' : preview.item.description);
    } catch (value) {
      if (!disposed && ticket === previewRead) { get('handoff-preview').textContent = value instanceof Error ? value.message : String(value); get('handoff-preview-note').textContent = 'The original reference is retained. Remove it or refresh it in the source task.'; }
    }
  }
  function render(ref: ProjectAgentTaskRef | null, unavailable = false) {
    if (disposed) return;
    if (!same(current, ref)) { current = ref; clearPreview(); error = ''; composing = false; }
    closing = unavailable;
    const entry = ref ? model.editor(ref) : undefined, target = ref ? model.targets.get(handoffKey(ref)) : undefined;
    panel.hidden = !entry?.open;
    get<HTMLButtonElement>('prepare-handoff').disabled = !ref || closing;
    if (!entry?.open || !ref) return;
    const locked = model.locked(entry) || closing, busy = model.busy(ref);
    get('handoff-source-title').textContent = entry.observation?.title ?? 'Reading source task…';
    input.readOnly = locked; if (!composing && input.value !== entry.body) input.value = entry.body;
    const choices = tasks.filter(task => !same(task.reference, ref));
    const signature = JSON.stringify([choices.map(task => [task.reference, task.title, task.provider]), entry.targetRef, target?.title, entry.targetTitle]);
    if (select.dataset.content !== signature) {
      select.dataset.content = signature; select.replaceChildren(new Option('Choose a task in this project', ''));
      for (const task of choices) select.add(new Option(`${task.title} · ${task.provider === 'kimi' ? 'Kimi Code' : task.provider === 'codex' ? 'Codex' : task.provider === 'deepseek' ? 'DeepSeek Harness' : 'Rho'}`, handoffKey(task.reference)));
      if (entry.targetRef && !choices.some(task => same(task.reference, entry.targetRef))) select.add(new Option(target?.title ?? entry.targetTitle ?? 'Previously selected task', handoffKey(entry.targetRef)));
    }
    select.value = entry.targetRef ? handoffKey(entry.targetRef) : ''; select.disabled = locked || loading || composing;
    get('handoff-task-note').textContent = loading ? 'Reading project tasks…' : entry.pending || entry.receipt ? '' : !tasksLoaded ? 'Refresh source and target to read the task list.' : !choices.length && !next ? 'Create another task in this project to receive the handoff.' : '';
    get<HTMLButtonElement>('handoff-more').hidden = !next; get<HTMLButtonElement>('handoff-more').disabled = loading || locked || composing;
    get<HTMLButtonElement>('handoff-newer').hidden = pages.length < 2; get<HTMLButtonElement>('handoff-newer').disabled = loading || locked || composing;
    const sources = get('handoff-sources'), key = JSON.stringify([entry.context, locked, composing]);
    if (sources.dataset.content !== key) {
      sources.dataset.content = key; sources.replaceChildren();
      for (const selection of entry.context) {
        const row = document.createElement('div'), show = document.createElement('button'), remove = document.createElement('button'); row.className = 'attachment';
        show.className = 'context-chip'; show.textContent = selection.label; show.onclick = () => run(() => preview(selection));
        remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${selection.label} from handoff`); remove.disabled = locked || composing;
        remove.onclick = () => run(() => model.remove(ref, selection)); row.append(show, remove); sources.append(row);
      }
    }
    get('handoff-notices').textContent = [...(entry.observation?.notices ?? []), ...(entry.observation?.truncated ? ['This handoff starts from a bounded source observation.'] : [])].join('\n');
    get('handoff-invalid').hidden = !model.invalidContext(entry);
    get('handoff-existing').hidden = !!entry.pending || !!entry.receipt;
    get('handoff-existing-text').textContent = busy ? 'Reading the current draft…' : target ? target.draft.text || 'The target draft is empty.' : entry.targetRef ? 'Refresh the target draft before adding the handoff.' : 'Choose a target task to preview its current draft.';
    get('handoff-existing-note').textContent = target ? [target.draft.context.length ? `Existing references: ${target.draft.context.map(item => item.label).join(' · ')}` : '', target.draft.assets.length ? `${target.draft.assets.length} existing attachment(s) will be kept.` : '', target.writable ? 'Your handoff will be appended below this text.' : target.reason ?? 'This target is read-only.'].filter(Boolean).join('\n') : '';
    const problem = error || entry.error; get('handoff-error').hidden = !problem; get('handoff-error').textContent = problem;
    get('handoff-recovery').hidden = !entry.pending; get('handoff-confirmed').hidden = !entry.receipt;
    get('handoff-receipt').textContent = entry.receipt ? `Request: ${entry.receipt.request_id}\nSaved draft version: ${entry.receipt.target_draft_version}` : '';
    const add = get<HTMLButtonElement>('handoff-add'); add.hidden = !!entry.pending || !!entry.receipt;
    add.disabled = locked || composing || !entry.body.trim() || !entry.observation || !target?.writable || model.invalidContext(entry);
    get<HTMLButtonElement>('handoff-refresh').hidden = !!entry.pending || !!entry.receipt; get<HTMLButtonElement>('handoff-refresh').disabled = locked || composing;
    for (const id of ['handoff-check', 'handoff-retry']) { const button = get<HTMLButtonElement>(id); button.hidden = !entry.pending; button.disabled = busy || closing || composing; }
    get<HTMLButtonElement>('handoff-open-target').hidden = !entry.receipt; get<HTMLButtonElement>('handoff-open-target').disabled = busy || closing;
    get<HTMLButtonElement>('handoff-close').disabled = composing || busy || closing;
    get('handoff-close').textContent = entry.receipt ? 'Done' : 'Back to task';
  }
  get('prepare-handoff').onclick = () => {
    get('actions-menu').hidePopover(); if (!current) return;
    const ref = structuredClone(current); run(async () => { await model.prepare(ref); await readTasks(); });
  };
  select.onchange = () => { const target = tasks.find(task => handoffKey(task.reference) === select.value); if (current && target) { const ref = current; run(() => model.selectTarget(ref, target.reference)); } };
  input.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); changed(); });
  function edit() {
    if (!current || composing) return;
    try { model.edit(current, input.value); error = ''; clearTimeout(timer); timer = setTimeout(() => run(() => native.save()), 300); }
    catch (value) { error = value instanceof Error ? value.message : String(value); }
    render(current, closing);
  }
  input.addEventListener('input', edit);
  input.addEventListener('compositionend', () => { composing = false; edit(); });
  get('handoff-refresh').onclick = () => { if (!current) return; const ref = current; run(async () => { await model.reloadSource(ref); const target = model.editor(ref)?.targetRef; if (target) await model.selectTarget(ref, target); await readTasks(); }); };
  get('handoff-add').onclick = () => { if (current) { const ref = current; run(() => model.append(ref)); } };
  get('handoff-check').onclick = () => { if (current) { const ref = current; run(() => model.check(ref)); } };
  get('handoff-retry').onclick = () => { if (current) { const ref = current; run(() => model.retry(ref)); } };
  get('handoff-close').onclick = () => { if (current) { const ref = current; clearPreview(); run(() => model.close(ref)); } };
  get('handoff-open-target').onclick = () => { if (!current) return; const ref = current, receipt = model.editor(ref)?.receipt; if (receipt) run(async () => { await model.close(ref); const { owner, id } = taskOwner(receipt.target); await owner.select(id); }); };
  get('handoff-more').onclick = () => { if (next) run(() => readTasks([...pages, next])); };
  get('handoff-newer').onclick = () => run(() => readTasks(pages.slice(0, -1)));
  get('handoff-preview-close').onclick = clearPreview;
  return { render, get isComposing() { return composing; }, prepareClose() { clearTimeout(timer); if (composing) throw Error('Finish the handoff text composition before closing.'); },
    dispose() { disposed = true; clearTimeout(timer); pageRead++; previewRead++; model.dispose(); } };
}
