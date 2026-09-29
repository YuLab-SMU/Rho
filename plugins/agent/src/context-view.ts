import {contextArtifacts, originalImage, producingRun} from './context-artifacts.js';
import type { AgentContextSelection } from '../sdk/index.js';
import type { ContextItem, ContextPreview, JsonValue } from '../public/plugin-protocol/index.js';
import { ContextPicker, contextInputIssue, type ContextSource } from './context-model.js';
import { same, type Client } from './operations.js';
import type { NativeAgentModel } from './native-model.js';

type DraftOwner = Pick<NativeAgentModel, 'draft' | 'edit'>;
export function mountContext(client: Client, model: NativeAgentModel, save: (task: string, kind: 'native' | 'rho') => void) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>('context-dialog'), picker = new ContextPicker(client);
  const imageArea = document.createElement('div'); imageArea.className = 'context-images';
  get('context-preview-area').append(imageArea);
  let imageUrls: string[] = [];
  const sourceSelect = get<HTMLSelectElement>('context-source'), inclusionSelect = get<HTMLSelectElement>('context-inclusion');
  let task: string | null = null, editable = false, blocked = false, disposed = false, busy = false, epoch = 0;
  let target: string | null = null, inspecting = false, source: ContextSource | null = null, item: ContextItem | null = null;
  let preview: ContextPreview | null = null, inclusion: JsonValue = null, next: JsonValue | null = null;
  let items: ContextItem[] = [], text = '', cursors = new Set<string>();
  let draftOwner: DraftOwner = model, targetOwner: DraftOwner = model, limit = 20;
  const saveDraft = (id: string) => save(id, draftOwner === model ? 'native' : 'rho');
  function controls() {
    sourceSelect.disabled = busy || inspecting;
    inclusionSelect.disabled = busy || inspecting || !source;
    get<HTMLButtonElement>('context-search-button').disabled = busy || inspecting || !source;
    get<HTMLButtonElement>('context-more-sources').disabled = busy;
    get<HTMLButtonElement>('context-more-items').disabled = busy;
    get<HTMLButtonElement>('context-add').disabled = busy || inspecting || !preview || !!contextInputIssue(preview) || !editable || blocked || target !== task || targetOwner !== draftOwner;
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('#context-items button, [data-context-artifact]')) button.disabled = busy;
  }
  function run(work: (current: () => boolean) => Promise<void>) {
    const ticket = ++epoch; busy = true; get('context-error').hidden = true; controls();
    void work(() => !disposed && ticket === epoch && dialog.open).catch(error => {
      if (ticket === epoch && !disposed) { get('context-error').textContent = error instanceof Error ? error.message : String(error); get('context-error').hidden = false; }
    }).finally(() => { if (ticket === epoch && !disposed) { busy = false; controls(); } });
  }
  function clearPreview() { for (const url of imageUrls) URL.revokeObjectURL(url); imageUrls = []; imageArea.replaceChildren(); preview = null; get('context-preview').textContent = ''; get('context-preview-note').textContent = ''; controls(); }
  function showPreview(value: ContextPreview) {
    preview = value; get('context-preview').textContent = value.text || 'No text in this inclusion.';
    get('context-preview-note').textContent = contextInputIssue(value) ?? (value.resources.length ? `${value.resources.length} captured image(s) · included only when this source is selected for Send.` :
      `${new TextEncoder().encode(value.text).length.toLocaleString()} bytes · ${inspecting ? 'Current preview of the saved reference' : 'Complete text'} · ${value.item.description}`);
  }
  async function showImages(value: ContextPreview, current: () => boolean) {
    if (contextInputIssue(value)) return;
    let images: Blob[];
    try { images = await picker.imagePreviews(value); } catch (error) { if (current()) clearPreview(); throw error; }
    if (!current()) return;
    for (const [index, blob] of images.entries()) {
      const img = document.createElement('img'), url = URL.createObjectURL(blob); imageUrls.push(url);
      img.src = url; img.alt = `Selected captured image ${index + 1}`; imageArea.append(img);
    }
  }
  function setSource(value: ContextSource) {
    source = value; item = null; items = []; next = null; cursors.clear(); clearPreview();
    inclusionSelect.replaceChildren(...value.inclusions.map((choice, index) => new Option(choice.title, String(index))));
    inclusion = value.inclusions[0]?.value ?? null;
    get('context-inclusion-note').textContent = value.inclusions.length ? '' : 'This source has no supported inclusion choices.';
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
    if (current()) { showPreview(value); await showImages(value, current); }
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
    target = task; targetOwner = draftOwner; inspecting = !!saved; source = null; item = null; clearPreview();
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
        inclusionSelect.value = String(retained.source.inclusions.findIndex(choice => same(choice.value, inclusion))); showPreview(retained.preview); await showImages(retained.preview, current);
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
      if (!task || target !== task || targetOwner !== draftOwner || !editable || blocked || busy || !source || !preview) return;
      const selection = picker.selection(source, preview, inclusion), draft = draftOwner.draft(task);
      if (!draft.context.some(old => same(old.reference, selection.reference) && old.inclusion === selection.inclusion)) {
        if (draft.context.length >= limit) throw Error(`This draft can include up to ${limit} context references.`);
        draftOwner.edit(task, { ...draft, context: [...draft.context, selection] }); saveDraft(task);
      }
      dialog.close();
    } catch (error) { get('context-error').textContent = error instanceof Error ? error.message : String(error); get('context-error').hidden = false; }
  };
  get('context-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { epoch++; busy = false; clearPreview(); });
  return {
    inspectSelection(selection: AgentContextSelection) { open(selection); },
    inspectOriginal(originalTask: string, request: string, kind: 'native' | 'rho' = 'native') {
      inspecting = true; target = originalTask; clearPreview();
      get('context-dialog-title').textContent = 'Sent context';
      for (const id of ['context-browse', 'context-add', 'context-inclusion-controls', 'context-preview-area']) get(id).hidden = true;
      const area = get('context-captures'); area.hidden = false; area.replaceChildren();
      get('context-footer-note').textContent = 'The input saved with this original message.';
      dialog.showModal();
      run(async current => {
        const captured = kind === 'rho' ? await picker.originalRho(originalTask, request) : { sources: await picker.original(originalTask, request), history: null }; if (!current()) return;
        const captures = [...(captured.history?.prior_sources ?? []).map(source => ({selection:source.selection,title:source.title,description:`Earlier input · ${source.description}`,text:source.text,data:source.native_data})), ...captured.sources];
        if (captured.history) {
          const heading = document.createElement('h3'), note = document.createElement('p');
          heading.textContent = captured.history.kind === 'continuation' ? 'Continued task input' : 'Earlier conversation';
          note.textContent = `${captured.history.truncated ? 'Some earlier input was omitted. ' : ''}Saved with this message; it does not grant tool access.`;
          area.append(heading, note);
          if (captured.history.kind === 'continuation') {
            const details = document.createElement('details'), summary = document.createElement('summary'), original = document.createElement('pre');
            summary.textContent = 'Checked original tools'; original.textContent = JSON.stringify({run_id:captured.history.previous_run_id,recovery:captured.history.recovery,tools:captured.history.tools},null,2);
            details.append(summary,original); area.append(details);
            if (captured.history.tools_truncated || captured.history.prior_sources_truncated) {
              const omitted = document.createElement('p'); omitted.textContent = 'Some earlier tool results or source inputs were omitted to keep this message within its limits.'; area.append(omitted);
            }
          }
          for (const turn of captured.history.turns) {
            const section = document.createElement('section'), question = document.createElement('h4'), user = document.createElement('pre'), answer = document.createElement('h4'), text = document.createElement('pre'), status = document.createElement('p');
            question.textContent = 'You'; user.textContent = turn.user_text; answer.textContent = 'Agent'; text.textContent = turn.assistant_text || 'No retained answer text.';
            status.textContent = [turn.state, ...(turn.history_gap ? ['Some events are missing'] : []), ...(turn.text_truncated ? ['Text was shortened'] : []), ...(turn.references_truncated ? ['Some references were omitted'] : [])].join(' · ');
            const details = document.createElement('details'), summary = document.createElement('summary'), references = document.createElement('pre');
            summary.textContent = 'Original record'; references.textContent = JSON.stringify({ run_id: turn.run_id, references: turn.references }, null, 2);
            details.append(summary, references); section.append(question, user, answer, text, status, details); area.append(section);
          }
        }
        if (!captures.length) { const empty = document.createElement('p'); empty.textContent = 'No selected sources.'; area.append(empty); }
        for (const value of captures) {
          const section = document.createElement('section'), heading = document.createElement('h3'), description = document.createElement('p'), text = document.createElement('pre');
          heading.textContent = value.title; description.textContent = value.description; text.textContent = value.text;
          const details = document.createElement('details'), summary = document.createElement('summary'), reference = document.createElement('pre');
          summary.textContent = 'Source details'; reference.textContent = JSON.stringify({ reference: value.selection.reference, inclusion: value.selection.inclusion, data: value.data, images: 'images' in value ? value.images : undefined }, null, 2);
          details.append(summary, reference); section.append(heading, description, text, details); area.append(section);
          for(const [index,artifact] of contextArtifacts(value.selection,value.data).entries()) {
            const links=document.createElement('div'),view=document.createElement('button'),runButton=document.createElement('button'),evidence=document.createElement('div');
            links.className='context-artifact-links';evidence.className='context-artifact-evidence';
            let activeUrl:string|null=null;const release=()=>{if(activeUrl){URL.revokeObjectURL(activeUrl);imageUrls=imageUrls.filter(url=>url!==activeUrl);activeUrl=null;}};
            view.textContent=`View original image ${index+1}`;runButton.textContent=`View producing run ${index+1}`;
            view.dataset.contextArtifact='image';runButton.dataset.contextArtifact='run';
            view.onclick=()=>run(async current=>{const blob=await originalImage(client,artifact);if(!current())return;
              release();const img=document.createElement('img'),url=URL.createObjectURL(blob);activeUrl=url;imageUrls.push(url);img.src=url;img.alt=`Original ${artifact.label}`;evidence.replaceChildren(img);
            });
            runButton.onclick=()=>run(async current=>{const record=await producingRun(client,artifact);if(!current())return;
              release();const status=document.createElement('p'),body=document.createElement('pre');status.textContent=`Original run · ${record.status}${record.truncated?' · Display shortened':''}`;body.textContent=record.details;evidence.replaceChildren(status,body);
            });
            links.append(view,runButton);section.append(links,evidence);
          }
        }
      });
    },
    render(currentTask: string | null, canEdit: boolean, unavailable: boolean, owner: DraftOwner = model) {
      task = currentTask; editable = canEdit; blocked = unavailable; draftOwner = owner; limit = owner === model ? 20 : 16;
      get<HTMLButtonElement>('choose-context').disabled = !task || !editable || blocked;
      const area = get('selected-context'), selections = task ? draftOwner.draft(task).context : [];
      const key = JSON.stringify([task, owner === model, selections, editable, blocked]);
      if (area.dataset.content !== key) {
        area.dataset.content = key; area.replaceChildren();
        for (const selection of selections) {
          const row = document.createElement('div'); row.className = 'attachment';
          const show = document.createElement('button'); show.className = 'context-chip'; show.textContent = selection.label; show.onclick = () => open(selection); show.disabled = unavailable;
          const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${selection.label} from draft`); remove.disabled = !editable || blocked;
          const originalTask = task!, originalOwner = draftOwner;
          remove.onclick = () => { if (task !== originalTask || draftOwner !== originalOwner || !editable || blocked) return; const draft = draftOwner.draft(originalTask); draftOwner.edit(originalTask, { ...draft, context: draft.context.filter(value => !same(value, selection)) }); saveDraft(originalTask); };
          row.append(show, remove); area.append(row);
        }
      }
      controls();
    },
    dispose() { disposed = true; epoch++; clearPreview(); },
  };
}
