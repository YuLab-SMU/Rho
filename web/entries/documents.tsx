import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Prec, RangeSetBuilder, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView as CodeView, ViewPlugin, keymap, type DecorationSet, type EditorView } from '@codemirror/view';
import { DocumentCardBody, DocumentEditorView, documentForms, editorEntry } from '@rho-workspace/plugin-documents/ui';
import { flowPath, languageNames, runPurpose, scriptFlow, scriptLanguage, scriptStepAt, selectionCode, statementAt, type ScriptStep } from '@rho-workspace/plugin-kernel/code';
import { ScriptFlowView } from '@rho-workspace/plugin-kernel/ui';
import type { FrameBodyProps, UiContribution, UiViewProps } from '../../src/ui-contract.js';
import { Icon } from '../icons.js';
import { languageExtensions } from '../languages.js';
import { WorkspaceViewsContext } from '../shell/workspace-views.js';
// A session without edit grants still reads the document.
const editable = (props: UiViewProps) => ['document.edit', 'document.undoOwn', 'document.revert', 'document.change.read'].every(m => props.snapshot.catalog.operations.some(o => o.method === m && o.state === 'available' && o.authorized));
// While a script's data flow is open beside it, the lines of the step at the cursor are marked, and
// so are the lines of the steps it comes from and of those that come of it.
type Mark = { from: number; to: number; kind: 'here' | 'from' | 'into' };
const setMarks = StateEffect.define<Mark[]>();
const flowMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(setMarks)) {
      const doc = tr.state.doc, lines = new Map<number, Mark['kind']>();
      for (const mark of effect.value) for (let n = mark.from; n <= Math.min(mark.to, doc.lines); n++) if (!lines.has(n) || mark.kind === 'here') lines.set(n, mark.kind);
      const built = new RangeSetBuilder<Decoration>();
      for (const [n, kind] of [...lines].sort((a, b) => a[0] - b[0])) built.add(doc.line(n).from, doc.line(n).from, Decoration.line({ class: 'cm-flow-' + kind }));
      marks = built.finish();
    }
    return marks;
  },
  provide: field => CodeView.decorations.from(field),
});
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
  // A script's data flow beside it, read from the text in the editor as the person types: the
  // switch is saved with the page. Choosing a step puts the cursor at its first line.
  const page = useContext(WorkspaceViewsContext);
  const saved = props.view.props.flow === true;
  const [flowOpen, setFlowOpen] = useState(saved);
  useEffect(() => setFlowOpen(saved), [saved]);
  const [text, setText] = useState(''), [line, setLine] = useState<number | null>(null);
  // The text and the cursor are followed only while the flow is open, and read when it opens.
  const watched = useRef({ text: (_: EditorState) => {}, line: (_: EditorState) => {} });
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  watched.current = {
    text: state => { if (!flowOpen) return; clearTimeout(typing.current); typing.current = setTimeout(() => setText(state.doc.toString()), 250); },
    line: state => { if (flowOpen) setLine(state.doc.lineAt(state.selection.main.head).number); },
  };
  useEffect(() => { if (flowOpen && editor) { setText(editor.state.doc.toString()); setLine(editor.state.doc.lineAt(editor.state.selection.main.head).number); } }, [flowOpen, editor]);
  useEffect(() => () => clearTimeout(typing.current), []);
  const flow = useMemo(() => flowOpen && language ? scriptFlow(text, language) : null, [flowOpen, language, text]);
  const marked = useRef(false);
  useEffect(() => {
    if (!editor) return;
    const step = flow && line !== null ? scriptStepAt(flow, line) : null, marks: Mark[] = [];
    if (flow && step) {
      const { up, down } = flowPath(flow, step.id);
      for (const s of flow.steps) {
        const kind = s.id === step.id ? 'here' : up.has(s.id) ? 'from' : down.has(s.id) ? 'into' : null;
        if (kind) marks.push({ from: s.from, to: s.to, kind });
      }
    }
    if (!marks.length && !marked.current) return;
    marked.current = marks.length > 0;
    editor.dispatch({ effects: setMarks.of(marks) });
  }, [editor, flow, line]);
  const toggleFlow = (open: boolean) => { setFlowOpen(open); page?.setProps?.(props.viewId, { flow: open }); };
  const goTo = (step: ScriptStep) => {
    if (!editor) return;
    const at = editor.state.doc.line(Math.min(step.from, editor.state.doc.lines)).from;
    editor.dispatch({ selection: { anchor: at }, effects: CodeView.scrollIntoView(at, { y: 'start', yMargin: 48 }) });
    editor.focus();
  };
  const extensionsFor = useMemo(() => language
    ? async (file: string) => [...await languageExtensions(file), flowMarks,
        // Added once the text is there, so it reads the text when it starts and then each change.
        ViewPlugin.define(view => {
          watched.current.text(view.state); watched.current.line(view.state);
          return { update: update => { if (update.docChanged) watched.current.text(update.state); if (update.docChanged || update.selectionSet) watched.current.line(update.state); } };
        }),
        ...runnable ? [Prec.highest(keymap.of([{ key: 'Mod-Enter', preventDefault: true, run: view => { runAt.current(view); return true; } }]))] : []]
    : languageExtensions, [language, runnable]);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const body = <DocumentEditorView view={props.view} extensionsFor={extensionsFor} onEditor={setEditor} projectId={props.projectId} client={props.client} active={props.active}
      documentVersion={doc?.version} documentRevision={doc?.revision} principalId={props.principalId} contextTarget={props.contextTarget} headerTarget={props.headerTarget} maxUnconfirmedBytes={bufferBytes(props)} editable={canType} saveable={saveable}
      reviewSelection={props.shell?.openReview ? anchor => props.shell!.openReview!(undefined, anchor) : undefined}
      askable={props.snapshot.catalog.operations.some(o => o.method === 'context.create' && o.state === 'available' && o.authorized)} />;
  return <>{language && props.active && props.headerTarget && createPortal(<label title="Show how this script's values are made, read from its code"><input type="checkbox" checked={flowOpen} onChange={event => toggleFlow(event.target.checked)} />Data flow</label>, props.headerTarget, 'flow-' + props.viewId)}
    {runnable && props.active && props.headerTarget && createPortal(<button className="run-line" disabled={!editor}
      title={`Run the selected lines, or the statement at the cursor, in the ${languageNames[language!]} session you share with the Agent (${mac ? '⌘' : 'Ctrl'}+Enter)`}
      onMouseDown={event => event.preventDefault()} onClick={() => { if (editor) { runAt.current(editor); editor.focus(); } }}><Icon name="run" size={12} />Run</button>, props.headerTarget, 'run-' + props.viewId)}
    {/* The editor keeps its place in the page whether the flow is open or not, so its undo stays. */}
    {language ? <div className="script-flow"><div className={'script-flow-split' + (flowOpen ? ' open' : '')}>
      <div className="script-flow-editor">{body}</div>
      {flowOpen && flow && <aside className="script-flow-side" aria-label="Data flow of this script">
        <p className="script-flow-lede">Each box is a statement, or a few, in the script's order, with what it makes; a line joins a value to each step that reads it. Read from the code; nothing runs.</p>
        <p className="script-flow-key" aria-hidden="true"><span className="here">At the cursor</span><span className="from">Comes from</span><span className="into">Leads to</span></p>
        <ScriptFlowView flow={flow} language={language} current={line} onStep={goTo} onPath={props.shell?.openPath} shell={props.shell} />
      </aside>}
    </div></div> : body}</>;
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
export const entry: UiContribution = { ...editorEntry, entryVersion: '0.1-draft', packageVersion: '0.4.7', propsSchema: { type: 'object', properties: { title: { type: 'string' }, flow: { type: 'boolean' } } }, commands: [], requiredOperations: ['document.read'], View: Editor, forms: documentForms, Body };
