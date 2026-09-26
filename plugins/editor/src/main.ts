import { EditorState, StateEffect, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, foldGutter, indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { connectPluginView } from '../public/plugin-ui/index.js';
import { EditorController } from './controller.js';
import { isR, rSupport } from './r-language.js';
import { terminal } from './operations.js';
import { same } from './operations.js';
import { readSessions, type SessionChoice } from './sessions.js';
import type { EditorPreferences } from './preferences.js';
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const client = await connectPluginView();
let editor: EditorView | null = null, stopped = false, preparing = false, composing = false, compositionEndedAt = -Infinity;
let timer: ReturnType<typeof setTimeout> | undefined, observing: ReturnType<typeof setTimeout> | undefined, pendingFlush: Promise<void> | null = null;
let controller: EditorController;
let closeInstalled = false;
const language = new Compartment();
const preferences = new Compartment();
let renderedPreferences = '';
let rLanguage = false, comparedVersion = '', saveThenRun = false;
let sessionChoices: SessionChoice[] = [], sessionNext: string | null = null, sessionsLoading = false, sessionGeneration = 0;
let sessionRenderKey = '';
const sessionCursors = new Set<string>();
const show = (id: string, text: string) => { const element = get(id); element.textContent = text; element.hidden = !text; };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function render() {
  if (!controller || stopped) return;
  const doc = controller.document, busy = controller.busy || preparing, readonly = !!doc?.snapshot.readonly;
  const synchronizing = !!pendingFlush || controller.busy && controller.drafts.unresolved;
  if (editor && doc && renderedPreferences !== JSON.stringify(controller.preferences)) {
    renderedPreferences = JSON.stringify(controller.preferences); doc.update(doc.state.update({ effects: preferences.reconfigure(preferenceExtensions()) }));
  }
  if (editor && doc && rLanguage !== isR(doc.path)) {
    rLanguage = isR(doc.path); doc.update(doc.state.update({ effects: language.reconfigure(rLanguage ? rSupport() : []) }));
  }
  if (editor && doc && editor.state !== doc.state) editor.setState(doc.state);
  get('name').textContent = doc?.name ?? 'Editor'; get('name').title = doc?.path ?? 'Untitled.R';
  get('file-state').textContent = readonly ? 'Read-only' : controller.pending ? 'Save unconfirmed' : doc?.dirty ? 'Unsaved' : doc ? 'Saved' : '';
  for (const id of ['save', 'save-as']) get<HTMLButtonElement>(id).disabled = !doc || readonly || busy || composing || !!controller.pending || controller.drafts.unresolved || !!controller.disk || controller.awaitingSavedRun;
  get<HTMLButtonElement>('compare-disk').disabled = !doc?.path || readonly || busy || !!controller.pending || controller.drafts.unresolved || controller.awaitingSavedRun;
  get<HTMLButtonElement>('editor-settings').disabled = !doc || busy || composing || controller.drafts.unresolved;
  get<HTMLButtonElement>('apply-preferences').disabled = busy || controller.drafts.unresolved;
  get('r-actions').hidden = !controller.runtime.source && !controller.sessionSelection;
  get('choose-session').hidden = !controller.sessionSelection;
  get<HTMLButtonElement>('choose-session').disabled = busy || composing;
  const selectedSession = sessionChoices.find(item => same(item.provider, controller.runtime.source));
  get('choose-session').textContent = selectedSession ? `Run in ${selectedSession.label}` : controller.runtime.source ? 'Choose Session' : 'Select R Session';
  get('choose-session').title = controller.runtime.source?.instance ?? 'No R session is selected';
  const code = controller.code, canStart = !code || code.status === 'succeeded' && (code.kind !== 'format' || code.applied);
  for (const id of ['run-selection', 'run-document', 'save-run', 'format']) get<HTMLButtonElement>(id).disabled = !controller.runtime.source || !doc || !isR(doc.path) || readonly || busy || composing ||
    !!controller.pending || !!controller.disk || controller.drafts.unresolved || !canStart;
  get('code-recovery').hidden = !code;
  get('code-status').textContent = !code ? '' : controller.awaitingSavedRun ? controller.fileRun?.phase === 'ready' ? code.intent.view === client.view.view ?
    'File save confirmed. The captured R run has not been submitted.' : 'Saved before closing. No R run was submitted. Dismiss this result to run the current document.' :
    'File save unconfirmed. No R run has been submitted.' : code.applied ? 'Formatting complete. Save writes the current edits.' : code.formatted ? 'A formatting result is retained. Your current edits are unchanged.' :
    `${code.kind === 'format' ? 'Formatting' : 'R run'} · ${code.status ?? 'admission unconfirmed'}${code.kind !== 'format' && code.status === 'succeeded' ? ' · Output is available in Console.' : ''}`;
  get('code-operation').textContent = code?.intent.operation ?? 'Original code request retained.';
  show('code-error', code?.error ?? '');
  get<HTMLButtonElement>('inspect-code').disabled = busy || controller.awaitingSavedRun;
  get<HTMLButtonElement>('retry-code').disabled = busy || controller.awaitingSavedRun || code?.intent.view !== client.view.view || !!code?.status && terminal(code.status);
  get('continue-saved-run').hidden = !controller.awaitingSavedRun || code?.intent.view !== client.view.view;
  get<HTMLButtonElement>('continue-saved-run').disabled = busy || controller.drafts.unresolved || !controller.canContinueSavedRun;
  get<HTMLButtonElement>('dismiss-code').disabled = busy || (controller.awaitingSavedRun ? !!controller.pending : !['succeeded', 'failed', 'cancelled'].includes(code?.status ?? ''));
  get('compare-format').hidden = !code?.formatted || code.applied;
  get<HTMLButtonElement>('compare-format').disabled = busy || !!controller.disk;
  get<HTMLButtonElement>('apply-format').disabled = busy || controller.drafts.unresolved || !!controller.disk;
  get<HTMLButtonElement>('refresh-format').disabled = busy;
  get<HTMLButtonElement>('discard-format').disabled = busy || controller.drafts.unresolved;
  if (get<HTMLDialogElement>('format-dialog').open && (!code?.formatted || code.applied)) get<HTMLDialogElement>('format-dialog').close();
  const diskDialog = get<HTMLDialogElement>('disk-dialog');
  get<HTMLButtonElement>('cancel-disk').disabled = busy;
  for (const id of ['refresh-disk', 'keep-edits', 'use-disk']) get<HTMLButtonElement>(id).disabled = busy || controller.drafts.unresolved;
  if (controller.disk && doc) {
    get('disk-local').textContent = doc.raw; get('disk-observed').textContent = controller.disk.raw; show('disk-error', controller.error);
    if (!diskDialog.open) diskDialog.showModal();
  } else if (diskDialog.open) diskDialog.close();
  show('error', controller.error); show('draft-error', controller.synchronizationError);
  show('preview', doc?.snapshot.readonly ?? '');
  get('recovery').hidden = !controller.drafts.unresolved || synchronizing;
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
  get('draft-state').textContent = synchronizing ? 'Synchronizing draft…' : controller.drafts.unresolved ? 'Draft save unconfirmed' : controller.synchronizationError ? 'Draft synchronization failed' : controller.drafts.snapshot.draft ? 'Draft synchronized' : 'Draft in this view';
  if (doc) {
    const head = doc.state.selection.main.head, line = doc.state.doc.lineAt(head);
    get('position').textContent = `Ln ${line.number}, Col ${head - line.from + 1} · ${doc.snapshot.byteSize.toLocaleString()} bytes · ${controller.preferences.indent_width} spaces`;
  }
  renderSessions();
}
function preferenceExtensions() {
  const value = controller.preferences;
  return [EditorState.tabSize.of(value.indent_width), indentUnit.of(' '.repeat(value.indent_width)), EditorView.theme({ '&.cm-editor': { fontSize: `${value.font_size}px` } })];
}
function renderSessions() {
  const dialog = get<HTMLDialogElement>('sessions-dialog');
  if (!dialog.open) return;
  const list = get('session-list'), key = JSON.stringify([sessionChoices, controller.runtime.source, sessionsLoading, controller.busy, preparing]);
  if (key !== sessionRenderKey) {
  sessionRenderKey = key; list.replaceChildren();
  for (const item of sessionChoices) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'session-choice';
    const selected = same(item.provider, controller.runtime.source);
    button.setAttribute('aria-pressed', String(selected)); button.disabled = sessionsLoading || controller.busy || preparing || item.state === 'unavailable';
    const name = document.createElement('strong'); name.textContent = item.label;
    const detail = document.createElement('span'); detail.textContent = `${item.state.replaceAll('_', ' ')}${selected ? ' · Selected' : ''}`;
    button.append(name, detail); button.title = `${item.provider.plugin}\n${item.provider.instance}\n${item.provider.revision}`;
    button.onclick = () => action(async () => {
      try { await controller.selectSession(item.provider); if (!preparing) dialog.close(); }
      catch (error) { show('sessions-error', message(error)); throw error; }
    }); list.append(button);
  }
  }
  get('sessions-status').textContent = sessionsLoading ? 'Observing sessions…' : !sessionChoices.length ? 'No compatible active R provider was found on this page.' :
    sessionChoices.length >= 200 ? 'Showing at most 200 sessions. Refresh to return to the first page.' : `${sessionChoices.length} session${sessionChoices.length === 1 ? '' : 's'} observed. Refresh to check current availability.`;
  get<HTMLButtonElement>('refresh-sessions').disabled = sessionsLoading || controller.busy || preparing;
  get('more-sessions').hidden = sessionNext === null; get<HTMLButtonElement>('more-sessions').disabled = sessionsLoading || controller.busy || preparing;
}
async function loadSessions(more = false) {
  if (!controller.sessionSelection || sessionsLoading || preparing || stopped) return;
  const generation = ++sessionGeneration; sessionsLoading = true; show('sessions-error', ''); renderSessions();
  try {
    if (!more) sessionCursors.clear();
    if (more && sessionNext === null) return;
    const page = await readSessions(client, more ? sessionNext : null);
    if (stopped || preparing || generation !== sessionGeneration) return;
    if (page.next !== null && sessionCursors.has(page.next)) throw new Error('The session catalog repeated a page. Refresh before continuing.');
    if (page.next !== null) sessionCursors.add(page.next);
    sessionChoices = (more ? [...sessionChoices, ...page.items.filter(item => !sessionChoices.some(previous => same(previous.provider, item.provider)))] : page.items).slice(0, 200);
    sessionNext = sessionChoices.length >= 200 ? null : page.next;
  } catch (error) { if (!stopped && !preparing && generation === sessionGeneration) show('sessions-error', message(error)); }
  finally { sessionsLoading = false; if (!stopped) render(); }
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
function saveAs(run = false) {
  if (!controller.document || preparing || composing) return;
  saveThenRun = run; get('save-heading').textContent = run ? 'Save and Run' : 'Save As'; get('confirm-save').textContent = run ? 'Save and Run File' : 'Save File';
  get<HTMLInputElement>('path').value = controller.document.path ?? 'Untitled.R'; get<HTMLInputElement>('replace').checked = false;
  show('path-error', ''); get<HTMLDialogElement>('save-dialog').showModal(); get<HTMLInputElement>('path').focus();
}
function save() { if (controller.document?.path) action(() => controller.save()); else saveAs(); }
function saveAndRun() { if (controller.document?.path) action(() => controller.saveAndRun()); else saveAs(true); }
function compareFormat() {
  action(async () => {
    try {
      // A restored cache is not scientific authority. Re-read the original
      // before showing its text alongside the resident document.
      await controller.inspectCode(false);
      const doc = controller.document, result = controller.code?.formatted;
      if (!doc || !result || preparing) return;
      comparedVersion = doc.snapshot.version;
      get('format-local').textContent = doc.state.doc.toString(); get('format-result').textContent = result.code;
      show('format-error', ''); const dialog = get<HTMLDialogElement>('format-dialog'); if (!dialog.open) dialog.showModal();
    } catch (error) { show('format-error', message(error)); throw error; }
  });
}
function mount() {
  if (editor || !controller.document) return;
  const doc = controller.document; get('opening').hidden = true;
  rLanguage = isR(doc.path);
  renderedPreferences = JSON.stringify(controller.preferences);
  const shortcut = (kind: 'document' | 'selection' | 'format') => (view: EditorView) => {
    if (!controller.runtime.source || !isR(doc.path) || composing || view.compositionStarted || performance.now() - compositionEndedAt < 100) return false;
    action(() => controller.startCode(kind)); return true;
  };
  doc.update(doc.state.update({ effects: StateEffect.reconfigure.of([
    history(), lineNumbers(), highlightActiveLine(), highlightSpecialChars(), drawSelection(), bracketMatching(), indentOnInput(), foldGutter(), closeBrackets(), highlightSelectionMatches(),
    EditorState.readOnly.of(!!doc.snapshot.readonly), EditorView.editable.of(!doc.snapshot.readonly),
    EditorView.contentAttributes.of({ 'aria-label': 'Code Editor', spellcheck: 'false' }), language.of(rLanguage ? rSupport() : []), preferences.of(preferenceExtensions()),
    keymap.of([{ key: 'Mod-s', run: view => { if (composing || view.compositionStarted || performance.now() - compositionEndedAt < 100) return false; save(); return true; } },
      { key: 'Mod-Enter', run: shortcut('selection') }, { key: 'Mod-Shift-Enter', run: view => {
        if (!controller.runtime.source || !isR(doc.path) || composing || view.compositionStarted || performance.now() - compositionEndedAt < 100) return false;
        saveAndRun(); return true;
      } }, { key: 'Alt-Shift-f', run: shortcut('format') },
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
  poll();
}
function wireActions() {
  get('editor-settings').onclick = () => {
    if (preparing || stopped || composing) return;
    get<HTMLSelectElement>('font-size').value = String(controller.preferences.font_size); get<HTMLSelectElement>('indent-width').value = String(controller.preferences.indent_width);
    show('preferences-error', ''); get<HTMLDialogElement>('preferences-dialog').showModal();
  };
  get('close-preferences').onclick = () => get<HTMLDialogElement>('preferences-dialog').close();
  get('apply-preferences').onclick = () => action(async () => {
    try {
      await controller.setPreferences({ font_size: Number(get<HTMLSelectElement>('font-size').value), indent_width: Number(get<HTMLSelectElement>('indent-width').value) } as EditorPreferences);
      if (!preparing) get<HTMLDialogElement>('preferences-dialog').close();
    } catch (error) { show('preferences-error', message(error)); throw error; }
  });
  get('save').onclick = save; get('save-as').onclick = () => saveAs(); get('save-run').onclick = saveAndRun;
  get('run-selection').onclick = () => action(() => controller.startCode('selection'));
  get('run-document').onclick = () => action(() => controller.startCode('document'));
  get('format').onclick = () => action(() => controller.startCode('format'));
  get('choose-session').onclick = () => { if (preparing || composing || stopped) return; get<HTMLDialogElement>('sessions-dialog').showModal(); renderSessions(); void loadSessions(); };
  get('close-sessions').onclick = () => get<HTMLDialogElement>('sessions-dialog').close();
  get('refresh-sessions').onclick = () => void loadSessions(); get('more-sessions').onclick = () => void loadSessions(true);
  get('inspect-code').onclick = () => action(() => controller.inspectCode());
  get('retry-code').onclick = () => action(() => controller.retryCode());
  get('continue-saved-run').onclick = () => action(() => controller.continueSavedRun());
  get('dismiss-code').onclick = () => action(() => controller.dismissCode());
  get('compare-format').onclick = compareFormat; get('refresh-format').onclick = compareFormat;
  get('close-format').onclick = () => get<HTMLDialogElement>('format-dialog').close();
  get('apply-format').onclick = () => { const version = comparedVersion; action(async () => {
    try { await controller.applyFormat(version); } catch (error) { show('format-error', message(error)); throw error; }
  }); };
  get('discard-format').onclick = () => action(() => controller.dismissCode());
  get('compare-disk').onclick = () => action(() => controller.compareDisk());
  get('refresh-disk').onclick = () => action(() => controller.compareDisk());
  get('keep-edits').onclick = () => action(() => controller.acceptDisk(false));
  get('use-disk').onclick = () => action(() => controller.acceptDisk(true));
  get('cancel-disk').onclick = () => action(() => controller.closeDisk());
  get('disk-dialog').addEventListener('cancel', event => { event.preventDefault(); if (!controller.busy) action(() => controller.closeDisk()); });
  get('cancel-save').onclick = () => get<HTMLDialogElement>('save-dialog').close();
  const confirm = () => {
    if (preparing || composing || controller.busy) return;
    const path = get<HTMLInputElement>('path').value, overwrite = get<HTMLInputElement>('replace').checked;
    get<HTMLButtonElement>('confirm-save').disabled = true;
    void (saveThenRun ? controller.saveAndRun(path, overwrite) : controller.save(path, overwrite)).then(() => get<HTMLDialogElement>('save-dialog').close()).catch(error => show('path-error', message(error)))
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
    const inspect = (async () => {
      if (controller.busy || controller.drafts.unresolved) return;
      if (controller.pending?.intent.operation) await controller.inspectSave().catch(() => undefined);
      if (!preparing && !controller.busy && !controller.drafts.unresolved) await controller.advanceSavedRun().catch(() => undefined);
      if (!preparing && !controller.busy && !controller.drafts.unresolved && controller.code?.intent.operation && !terminal(controller.code.status ?? 'accepted'))
        await controller.inspectCode().catch(() => undefined);
    })();
    void inspect.finally(() => { render(); poll(); });
  }, 1500);
}
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); clearTimeout(observing); controller?.stop(); editor?.destroy(); client.dispose(); });
