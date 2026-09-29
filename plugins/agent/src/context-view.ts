import type { AgentContextSelection } from '../sdk/index.js';
import type { ContextItem, ContextPreview, JsonValue } from '../public/plugin-protocol/index.js';
import { ContextPicker, type ContextSource } from './context-model.js';
import { same, type Client } from './operations.js';
import type { NativeAgentModel } from './native-model.js';

export function mountContext(client: Client, model: NativeAgentModel, save: (task: string) => void) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>('context-dialog'), picker = new ContextPicker(client);
  const sourceSelect = get<HTMLSelectElement>('context-source'), inclusionSelect = get<HTMLSelectElement>('context-inclusion');
  let task: string | null = null, editable = false, blocked = false, disposed = false, busy = false, epoch = 0;
  let target: string | null = null, inspecting = false, source: ContextSource | null = null, item: ContextItem | null = null;
  let preview: ContextPreview | null = null, inclusion: JsonValue = null, next: JsonValue | null = null;
  let items: ContextItem[] = [], text = '', cursors = new Set<string>();
  function controls() {
    sourceSelect.disabled = busy || inspecting;
    inclusionSelect.disabled = busy || inspecting || !source;
    get<HTMLButtonElement>('context-search-button').disabled = busy || inspecting || !source;
    get<HTMLButtonElement>('context-more-sources').disabled = busy;
    get<HTMLButtonElement>('context-more-items').disabled = busy;
    get<HTMLButtonElement>('context-add').disabled = busy || inspecting || !preview || preview.truncated || !!preview.resources.length || !editable || blocked || target !== task;
    for (const button of get('context-items').querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy;
  }
  function run(work: (current: () => boolean) => Promise<void>) {
    const ticket = ++epoch; busy = true; get('context-error').hidden = true; controls();
    void work(() => !disposed && ticket === epoch && dialog.open).catch(error => {
      if (ticket === epoch && !disposed) { get('context-error').textContent = error instanceof Error ? error.message : String(error); get('context-error').hidden = false; }
    }).finally(() => { if (ticket === epoch && !disposed) { busy = false; controls(); } });
  }
  function clearPreview() { preview = null; get('context-preview').textContent = ''; get('context-preview-note').textContent = ''; controls(); }
  function showPreview(value: ContextPreview) {
    preview = value; get('context-preview').textContent = value.text || 'No text in this inclusion.';
    get('context-preview-note').textContent = value.truncated ? 'Partial preview · choose a smaller inclusion before adding.' : value.resources.length ? 'This source includes files that this input cannot accept yet.' :
      `${new TextEncoder().encode(value.text).length.toLocaleString()} bytes · ${inspecting ? 'Current preview of the saved reference' : 'Complete text'} · ${value.item.description}`;
  }
  function setSource(value: ContextSource) {
    source = value; item = null; items = []; next = null; cursors.clear(); clearPreview();
    inclusionSelect.replaceChildren(...value.inclusions.map((choice, index) => new Option(choice.title, String(index))));
    inclusion = value.inclusions[0]?.value ?? null;
    get('context-inclusion-note').textContent = value.inclusions.length ? '' : 'This source has no supported text inclusion choices.';
    get('context-items').replaceChildren(); get('context-more-items').hidden = true;
  }
  function renderSources() {
    sourceSelect.replaceChildren(...picker.sources.map((value, index) => new Option(`${value.title} · ${value.provider.instance}`, String(index))));
    get('context-more-sources').hidden = !picker.nextInstances;
    get('context-source-note').textContent = [...picker.notices, ...(!picker.sources.length ? ['No active context sources are available.'] : [])].join('\n');
  }
  async function readPreview(current: () => boolean) {
    if (!source || !item || !source.inclusions.length) return;
    clearPreview(); const value = await picker.preview(source, item.reference, inclusion);
    if (current()) showPreview(value);
  }
  async function search(current: () => boolean, more = false) {
    if (!source) return;
    if (!more) { items = []; next = null; cursors.clear(); text = get<HTMLInputElement>('context-search').value; item = null; clearPreview(); }
    const page = await picker.search(source, text, more ? next : null);
    if (!current()) return;
    if (page.next !== null) { const cursor = JSON.stringify(page.next); if (cursors.has(cursor)) throw Error('This source repeated an earlier page.'); cursors.add(cursor); }
    next = page.next;
    items = [...items, ...page.items.filter(value => !items.some(old => same(old.reference, value.reference)))];
    get('context-search-note').textContent = [...page.notices, ...(!items.length ? ['No matching items.'] : [])].join('\n');
    get('context-items').replaceChildren();
    for (const value of items) {
      const button = document.createElement('button'), title = document.createElement('strong'), description = document.createElement('small');
      title.textContent = value.title; description.textContent = value.description; button.append(title, description);
      button.onclick = () => { item = value; for (const sibling of get('context-items').children) sibling.setAttribute('aria-pressed', String(sibling === button)); run(readPreview); };
      get('context-items').append(button);
    }
    get('context-more-items').hidden = next === null;
  }
  function open(saved?: AgentContextSelection) {
    target = task; inspecting = !!saved; source = null; item = null; clearPreview();
    get('context-browse').hidden = inspecting; get('context-add').hidden = inspecting;
    get('context-dialog-title').textContent = 'Context'; get('context-captures').hidden = true;
    get('context-inclusion-controls').hidden = false; get('context-preview-area').hidden = false;
    get('context-footer-note').textContent = 'Selected sources are checked again when you send.';
    get('context-preview-title').textContent = saved?.label ?? 'Preview';
    get('context-inclusion-note').textContent = ''; get('context-search-note').textContent = '';
    sourceSelect.replaceChildren(); inclusionSelect.replaceChildren(); get('context-items').replaceChildren();
    dialog.showModal();
    run(async current => {
      if (saved) {
        const retained = await picker.retained(saved); if (!current()) return;
        setSource(retained.source); inclusion = retained.inclusion;
        inclusionSelect.value = String(retained.source.inclusions.findIndex(choice => same(choice.value, inclusion))); showPreview(retained.preview);
      } else {
        get<HTMLInputElement>('context-search').value = ''; await picker.discover(); if (!current()) return;
        renderSources(); if (picker.sources[0]) { setSource(picker.sources[0]); await search(current); }
      }
    });
  }
  get('choose-context').onclick = () => { if (task && editable && !blocked && !busy) open(); };
  sourceSelect.onchange = () => { const selected = picker.sources[Number(sourceSelect.value)]; if (selected) { setSource(selected); run(current => search(current)); } };
  inclusionSelect.onchange = () => { inclusion = source?.inclusions[Number(inclusionSelect.value)]?.value ?? null; run(readPreview); };
  get('context-search-button').onclick = () => run(current => search(current));
  get('context-search-form').onsubmit = event => { event.preventDefault(); if (!busy) run(current => search(current)); };
  get('context-more-items').onclick = () => run(current => search(current, true));
  get('context-more-sources').onclick = () => run(async current => {
    const selected = sourceSelect.value; await picker.discover(true); if (!current()) return; renderSources(); sourceSelect.value = selected;
    if (!source && picker.sources[0]) { setSource(picker.sources[0]); await search(current); }
  });
  get('context-add').onclick = () => {
    try {
      if (!task || target !== task || !editable || blocked || busy || !source || !preview) return;
      const selection = picker.selection(source, preview, inclusion), draft = model.draft(task);
      if (!draft.context.some(old => same(old.reference, selection.reference) && old.inclusion === selection.inclusion)) {
        if (draft.context.length >= 20) throw Error('A draft can include up to 20 context references.');
        model.edit(task, { ...draft, context: [...draft.context, selection] }); save(task);
      }
      dialog.close();
    } catch (error) { get('context-error').textContent = error instanceof Error ? error.message : String(error); get('context-error').hidden = false; }
  };
  get('context-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { epoch++; busy = false; clearPreview(); });
  return {
    inspectOriginal(originalTask: string, request: string) {
      inspecting = true; target = originalTask; clearPreview();
      get('context-dialog-title').textContent = 'Sent context';
      for (const id of ['context-browse', 'context-add', 'context-inclusion-controls', 'context-preview-area']) get(id).hidden = true;
      const area = get('context-captures'); area.hidden = false; area.replaceChildren();
      get('context-footer-note').textContent = 'The input saved with this original message.';
      dialog.showModal();
      run(async current => {
        const captures = await picker.original(originalTask, request); if (!current()) return;
        if (!captures.length) { const empty = document.createElement('p'); empty.textContent = 'No contributed context was included in this message.'; area.append(empty); }
        for (const value of captures) {
          const section = document.createElement('section'), heading = document.createElement('h3'), description = document.createElement('p'), text = document.createElement('pre');
          heading.textContent = value.title; description.textContent = value.description; text.textContent = value.text;
          const details = document.createElement('details'), summary = document.createElement('summary'), reference = document.createElement('pre');
          summary.textContent = 'Source details'; reference.textContent = JSON.stringify({ reference: value.selection.reference, inclusion: value.selection.inclusion, data: value.data }, null, 2);
          details.append(summary, reference); section.append(heading, description, text, details); area.append(section);
        }
      });
    },
    render(currentTask: string | null, canEdit: boolean, unavailable: boolean) {
      task = currentTask; editable = canEdit; blocked = unavailable;
      get<HTMLButtonElement>('choose-context').disabled = !task || !editable || blocked;
      const area = get('selected-context'), selections = task ? model.draft(task).context : [];
      const key = JSON.stringify([task, selections, editable, blocked]);
      if (area.dataset.content !== key) {
        area.dataset.content = key; area.replaceChildren();
        for (const selection of selections) {
          const row = document.createElement('div'); row.className = 'attachment';
          const show = document.createElement('button'); show.className = 'context-chip'; show.textContent = selection.label; show.onclick = () => open(selection); show.disabled = unavailable;
          const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${selection.label} from draft`); remove.disabled = !editable || blocked;
          const originalTask = task!;
          remove.onclick = () => { if (task !== originalTask || !editable || blocked) return; const draft = model.draft(originalTask); model.edit(originalTask, { ...draft, context: draft.context.filter(value => !same(value, selection)) }); save(originalTask); };
          row.append(show, remove); area.append(row);
        }
      }
      controls();
    },
    dispose() { disposed = true; epoch++; },
  };
}
