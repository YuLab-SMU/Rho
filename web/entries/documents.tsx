import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Prec } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { DocumentCardBody, DocumentEditorView, documentForms, editorEntry } from '@rho-workspace/plugin-documents/ui';
import { languageNames, scriptLanguage } from '../../src/explore-code.js';
import { runPurpose, selectionCode, statementAt } from '../../src/statements.js';
import type { FrameBodyProps, UiContribution, UiViewProps } from '../../src/ui-contract.js';
import { Icon } from '../icons.js';
import { languageExtensions } from '../languages.js';
// A session without edit grants still reads the document.
const editable = (props: UiViewProps) => ['document.edit', 'document.undoOwn', 'document.revert', 'document.change.read'].every(m => props.snapshot.catalog.operations.some(o => o.method === m && o.state === 'available' && o.authorized));
const bufferBytes = (props: UiViewProps) => Math.max(1, Math.min(1024 * 1024, (props.snapshot.limits.documents as { maxBufferBytes?: number } | undefined)?.maxBufferBytes ?? 1024 * 1024));
function Editor(props: UiViewProps) {
  const binding = props.view.bindings.document as { documentId?: string } | undefined;
  const doc = props.snapshot.documents.find(d => d.id === binding?.documentId);
  const canType = editable(props);
  const saveable = props.snapshot.catalog.operations.some(o => o.method === 'document.save' && o.state === 'available' && o.authorized);
  // An R or Python script runs a line at a time in the session the person shares with the Agent,
  // as from an editor beside a console: ⌘/Ctrl+Enter or Run sends the selection, or the statement
  // the cursor is in, and the cursor goes on to the next statement. The text runs as it is in the
  // editor, saved or not; running saves nothing.
  const path = doc?.path, language = scriptLanguage(path), runCode = props.shell?.runCode, runnable = !!language && !!runCode;
  const [editor, setEditor] = useState<EditorView | null>(null);
  const runAt = useRef((_: EditorView) => {});
  runAt.current = view => {
    if (!language || !runCode || !path) return;
    const state = view.state, main = state.selection.main;
    if (!main.empty) {
      // A selection that ends where a line starts (whole lines dragged over) ends on the line before.
      const last = state.doc.lineAt(main.to).from === main.to ? main.to - 1 : main.to;
      void runCode({ viewId: props.viewId, language, code: selectionCode(state.sliceDoc(main.from, main.to), language), purpose: runPurpose(path, state.doc.lineAt(main.from).number, state.doc.lineAt(last).number) });
      return;
    }
    const { statement, next } = statementAt(state.doc.toString(), state.doc.lineAt(main.head).number, language);
    if (statement) void runCode({ viewId: props.viewId, language, code: statement.code, purpose: runPurpose(path, statement.from, statement.to) });
    if (next) view.dispatch({ selection: { anchor: state.doc.line(next).from }, scrollIntoView: true });
  };
  const extensionsFor = useMemo(() => runnable
    ? async (file: string) => [...await languageExtensions(file), Prec.highest(keymap.of([{ key: 'Mod-Enter', preventDefault: true, run: view => { runAt.current(view); return true; } }]))]
    : languageExtensions, [runnable]);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return <>{runnable && props.active && props.headerTarget && createPortal(<button className="run-line" disabled={!editor}
      title={`Run the selected lines, or the statement at the cursor, in the ${languageNames[language!]} session you share with the Agent (${mac ? '⌘' : 'Ctrl'}+Enter)`}
      onMouseDown={event => event.preventDefault()} onClick={() => { if (editor) { runAt.current(editor); editor.focus(); } }}><Icon name="run" size={12} />Run</button>, props.headerTarget)}
    <DocumentEditorView view={props.view} extensionsFor={extensionsFor} onEditor={setEditor} projectId={props.projectId} client={props.client} active={props.active}
      documentVersion={doc?.version} documentRevision={doc?.revision} principalId={props.principalId} contextTarget={props.contextTarget} headerTarget={props.headerTarget} maxUnconfirmedBytes={bufferBytes(props)} editable={canType} saveable={saveable}
      reviewSelection={props.shell?.openReview ? anchor => props.shell!.openReview!(undefined, anchor) : undefined}
      askable={props.snapshot.catalog.operations.some(o => o.method === 'context.create' && o.state === 'available' && o.authorized)} /></>;
}
// The item's passage, change, outline or summary inside Rho's frame. Cards read
// the same buffer as the editor; a reference to another item is Rho's chip.
function Body({ form, params, view, present, reportHidden, Card }: FrameBodyProps) {
  const Reference = useMemo(() => ({ itemId }: { itemId: string }) => <Card itemId={itemId} form="inline" />, [Card]);
  if (!view) return null;
  const binding = view.view.bindings.document as { documentId?: string; version?: number; kind?: string } | undefined;
  if (binding?.kind !== 'live-document' && typeof binding?.version === 'number') return form === 'inline' ? <span>Version {binding.version}</span> : <p className="rho-generic-summary">This view is pinned to version {binding.version}. Open it to read that version.</p>;
  const doc = view.snapshot.documents.find(d => d.id === binding?.documentId);
  return <DocumentCardBody form={form} params={params} projectId={view.projectId} client={view.client} documentId={binding?.documentId} documentVersion={doc?.version} principalId={view.principalId}
    editable={editable(view)} maxUnconfirmedBytes={bufferBytes(view)} onParams={present} reportHidden={reportHidden} Reference={Reference} />;
}
export const entry: UiContribution = { ...editorEntry, entryVersion: '0.1-draft', packageVersion: '0.4.7', propsSchema: { type: 'object', properties: { title: { type: 'string' } } }, commands: [], requiredOperations: ['document.read'], View: Editor, forms: documentForms, Body };
