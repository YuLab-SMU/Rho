import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, foldGutter } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { connectPluginView } from '../public/plugin-ui/index.js';
import { EditorController } from './controller.js';
import { isR, rSupport } from './r-language.js';
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const client = await connectPluginView();
let editor: EditorView | null = null, stopped = false, preparing = false, composing = false, compositionEndedAt = -Infinity;
let timer: ReturnType<typeof setTimeout> | undefined, observing: ReturnType<typeof setTimeout> | undefined, pendingFlush: Promise<void> | null = null;
let controller: EditorController;
let closeInstalled = false;
const show = (id: string, text: string) => { const element = get(id); element.textContent = text; element.hidden = !text; };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function render() {
  if (!controller || stopped) return;
  const doc = controller.document, busy = controller.busy || preparing, readonly = !!doc?.snapshot.readonly;
  get('name').textContent = doc?.name ?? 'Editor'; get('name').title = doc?.path ?? 'Untitled.R';
  get('file-state').textContent = readonly ? 'Read-only' : controller.pending ? 'Save unconfirmed' : doc?.dirty ? 'Unsaved' : doc ? 'Saved' : '';
  for (const id of ['save', 'save-as']) get<HTMLButtonElement>(id).disabled = !doc || readonly || busy || composing || !!controller.pending || controller.drafts.unresolved;
  show('error', controller.error); show('draft-error', controller.synchronizationError);
  show('preview', doc?.snapshot.readonly ?? '');
  get('recovery').hidden = !controller.drafts.unresolved;
  get('refresh-file').hidden = !!doc || !!controller.drafts.snapshot.draft || controller.drafts.unresolved;
  const ownDraft = controller.drafts.snapshot.pending?.view === client.view.view;
  get<HTMLButtonElement>('retry-draft').disabled = !ownDraft || busy;
  get<HTMLButtonElement>('acknowledge-draft').disabled = busy || !['failed', 'cancelled'].includes(controller.drafts.original?.status ?? '');
  get<HTMLButtonElement>('inspect-draft').disabled = busy;
  get('file-recovery').hidden = !controller.pending;
  get('file-operation').textContent = controller.pending?.intent.operation ?? 'Original file request retained; admission is unconfirmed.';
  get<HTMLButtonElement>('retry-file').disabled = busy || controller.pending?.intent.view !== client.view.view;
  get<HTMLButtonElement>('inspect-file').disabled = busy;
  get<HTMLButtonElement>('acknowledge-file').disabled = busy;
  get('draft-state').textContent = controller.drafts.unresolved ? 'Draft save unconfirmed' : pendingFlush ? 'Synchronizing draft…' : controller.synchronizationError ? 'Draft synchronization failed' : controller.drafts.snapshot.draft ? 'Draft synchronized' : 'Draft in this view';
  if (doc) {
    const head = doc.state.selection.main.head, line = doc.state.doc.lineAt(head);
    get('position').textContent = `Ln ${line.number}, Col ${head - line.from + 1} · ${doc.snapshot.byteSize.toLocaleString()} bytes`;
  }
}
function report(error: unknown) { if (!stopped) { controller.error = message(error); render(); } }
async function flush() {
  clearTimeout(timer); timer = undefined;
  if (!controller.document || stopped) return;
  const task = controller.flush(); pendingFlush = task; render();
  try { await task; } finally { if (pendingFlush === task) pendingFlush = null; render(); }
}
function schedule() { clearTimeout(timer); if (!stopped && !preparing) timer = setTimeout(() => void flush().catch(() => undefined), 350); }
function action(work: () => Promise<unknown>) { if (preparing || stopped || composing) return; void work().catch(report).finally(render); }
function saveAs() {
  if (!controller.document || preparing || composing) return;
  get<HTMLInputElement>('path').value = controller.document.path ?? 'Untitled.R'; get<HTMLInputElement>('replace').checked = false;
  show('path-error', ''); get<HTMLDialogElement>('save-dialog').showModal(); get<HTMLInputElement>('path').focus();
}
function save() { if (controller.document?.path) action(() => controller.save()); else saveAs(); }
function mount() {
  if (editor || !controller.document) return;
  const doc = controller.document; get('opening').hidden = true;
  doc.update(doc.state.update({ effects: StateEffect.reconfigure.of([
    history(), lineNumbers(), highlightActiveLine(), highlightSpecialChars(), drawSelection(), bracketMatching(), indentOnInput(), foldGutter(), closeBrackets(), highlightSelectionMatches(),
    EditorState.readOnly.of(!!doc.snapshot.readonly), EditorView.editable.of(!doc.snapshot.readonly),
    EditorView.contentAttributes.of({ 'aria-label': 'Code Editor', spellcheck: 'false' }), ...(isR(doc.path) ? rSupport() : []),
    keymap.of([{ key: 'Mod-s', run: view => { if (composing || view.compositionStarted || performance.now() - compositionEndedAt < 100) return false; save(); return true; } },
      ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.domEventHandlers({ scroll: (_event, view) => { if (!preparing) { doc.setScroll(view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft); schedule(); } } }),
  ]) }));
  editor = new EditorView({ parent: get('editor'), state: doc.state, dispatchTransactions: (transactions, view) => {
    if (preparing) return;
    try { for (const transaction of transactions) doc.update(transaction); view.update(transactions); schedule(); render(); }
    catch (error) { view.setState(doc.state); report(error); }
  } });
  editor.contentDOM.addEventListener('compositionstart', () => { composing = true; compositionEndedAt = -Infinity; render(); }, true);
  editor.contentDOM.addEventListener('compositionend', () => { composing = false; compositionEndedAt = performance.now(); render(); }, true);
  requestAnimationFrame(() => { if (editor) { editor.scrollDOM.scrollTop = doc.snapshot.scrollTop; editor.scrollDOM.scrollLeft = doc.snapshot.scrollLeft; } });
}
try {
  controller = new EditorController(client, client.view.configuration as any, render);
  wireActions();
  await controller.open();
  await ensureClose();
  mount(); render();
  poll();
} catch (error) { if (controller!) { controller.error = message(error); render(); } else show('error', message(error)); get('opening').textContent = 'The document could not be opened. Its saved state is retained.'; }
async function ensureClose() {
  if (closeInstalled) return;
  const close = await client.installCloseHandler({ flush: async () => {
    preparing = true; clearTimeout(timer); clearTimeout(observing);
    if (editor && controller.document) controller.document.setScroll(editor.scrollDOM.scrollTop, editor.scrollDOM.scrollLeft);
    await controller.pause();
  }, resume: () => { preparing = false; controller.resume(); poll(); } });
  close.subscribe(() => { const state = close.getSnapshot(); if (state.error) show('error', state.error); });
  closeInstalled = true;
}
function wireActions() {
  get('save').onclick = save; get('save-as').onclick = saveAs;
  get('cancel-save').onclick = () => get<HTMLDialogElement>('save-dialog').close();
  const confirm = () => {
    if (preparing || composing || controller.busy) return;
    const path = get<HTMLInputElement>('path').value, overwrite = get<HTMLInputElement>('replace').checked;
    get<HTMLButtonElement>('confirm-save').disabled = true;
    void controller.save(path, overwrite).then(() => get<HTMLDialogElement>('save-dialog').close()).catch(error => show('path-error', message(error)))
      .finally(() => { get<HTMLButtonElement>('confirm-save').disabled = false; render(); });
  };
  get('confirm-save').onclick = confirm;
  let pathComposing = false, pathEndedAt = -Infinity;
  get('path').addEventListener('compositionstart', () => { pathComposing = true; pathEndedAt = -Infinity; });
  get('path').addEventListener('compositionend', () => { pathComposing = false; pathEndedAt = performance.now(); });
  get('path').onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !pathComposing) {
      event.preventDefault(); if (performance.now() - pathEndedAt >= 100) confirm();
    }
    if (!event.isComposing && event.keyCode !== 229 && event.key !== 'Enter') pathEndedAt = -Infinity;
  };
  get('inspect-file').onclick = () => action(() => controller.inspectSave()); get('retry-file').onclick = () => action(() => controller.retrySave());
  get('acknowledge-file').onclick = () => action(() => controller.acknowledgeFileFailure());
  get('inspect-draft').onclick = () => action(async () => { await controller.inspectDraft(); await ensureClose(); mount(); });
  get('retry-draft').onclick = () => action(async () => { await controller.drafts.retryOriginal(); if (!controller.document) await controller.open(); await ensureClose(); mount(); await flush(); });
  get('acknowledge-draft').onclick = () => action(async () => { await controller.drafts.acknowledgeFailure(); await flush(); });
  get('refresh-file').onclick = () => action(async () => { await controller.refreshInitial(); await ensureClose(); mount(); });
}
function poll() {
  clearTimeout(observing);
  if (stopped || preparing) return;
  observing = setTimeout(() => {
    const inspect = controller.pending?.intent.operation && !controller.busy && !controller.drafts.unresolved ? controller.inspectSave().catch(() => undefined) : Promise.resolve();
    void inspect.finally(() => { render(); poll(); });
  }, 1500);
}
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); clearTimeout(observing); controller?.stop(); editor?.destroy(); client.dispose(); });
