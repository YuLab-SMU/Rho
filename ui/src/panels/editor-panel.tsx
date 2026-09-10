import * as Menu from "@radix-ui/react-dropdown-menu";
import { Icon } from "../icons";
import { useEffect, useRef, useState } from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightSpecialChars,
  drawSelection,
} from "@codemirror/view";
import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  foldGutter,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { rSupport, isR } from "../r-language";
import { useDocuments, useObjectCompletions, useOperations, usePreferences, useSession, useNavigation } from "../context";
import { Modal } from "../primitives";
import { SessionTargetPicker } from "./session-target";
import type { DocumentSnapshot } from "../documents";

export function EditorHub() {
  const documents = useDocuments(), navigation = useNavigation();
  return (
    <section className="panel editor-hub">
      <div className="editor-toolbar">
        <button className="primary" onClick={() => documents.create()}>
          ＋ New R File
        </button>
        <button onClick={() => navigation.showPanel("files")}>Open File</button>
      </div>
      <div className="empty">
        <h2>Start with a script</h2>
        <p>⌘ S Save · ⌘ Enter Run Selection / Line</p>
        <p>⌘ ⇧ Enter Save and Run File</p>
        {!!documents.items.size && (
          <div className="document-list">
            {[...documents.items.values()].map((d) => (
              <button key={d.id} onClick={() => documents.focus(d)}>
                {d.name}
                {d.dirty && !d.draft.readonly ? " · Unsaved" : ""}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CodeEditor({
  document,
  onSave,
  onRunFile,
}: {
  document: DocumentSnapshot;
  onSave: () => void;
  onRunFile: () => void;
}) {
  const documents = useDocuments(document.id), objectNames = useObjectCompletions(), preferences = usePreferences(), navigation = useNavigation(),
    parent = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    actions = useRef({ onSave, onRunFile }),
    configuration = useRef(new Compartment());
  actions.current = { onSave, onRunFile };
  function configure() {
    return [
      EditorState.readOnly.of(!!document.draft.readonly),
      EditorView.contentAttributes.of({
        "aria-label": `Code Editor ${document.name}`,
      }),
      EditorState.tabSize.of(preferences.indentWidth),
      indentUnit.of(" ".repeat(preferences.indentWidth)),
      EditorView.theme({
        "&.cm-editor": { fontSize: `${preferences.editorFontSize}px` },
      }),
      ...(isR(document.path)
        ? rSupport(() => [...objectNames()])
        : []),
    ];
  }
  useEffect(() => {
    const nonce =
      globalThis.document.querySelector<HTMLMetaElement>(
        "meta[name=rho-csp-nonce]",
      )?.content ?? "";
    const extensions = [
      history(),
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      foldGutter(),
      configuration.current.of(configure()),
      EditorView.cspNonce.of(nonce),

      EditorState.readOnly.of(!!document.draft.readonly),
      EditorView.contentAttributes.of({
        "aria-label": `Code Editor ${document.name}`,
      }),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            actions.current.onSave();
            return true;
          },
        },
        {
          key: "Mod-Shift-Enter",
          run: () => {
            actions.current.onRunFile();
            return true;
          },
        },
        {
          key: "Mod-Enter",
          run: () => {
            void documents.attempt(document, () => documents.runSelection(document));
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.domEventHandlers({
        focus: () => {
          documents.activate(document);
        },
        scroll: (_event, v) => {
          documents.setScroll(document, v.scrollDOM.scrollTop, v.scrollDOM.scrollLeft);
        },
      }),
    ];
    const current = documents.getDocumentSnapshot(document.id)!;
    const configured = documents.applyTransactions(document, [current.state.update({
      effects: StateEffect.reconfigure.of(extensions),
    })]);
    const editor = new EditorView({
      parent: parent.current!,
      state: configured.state,
      dispatchTransactions(transactions, v) {
        documents.applyTransactions(document, transactions);
        v.update(transactions);
      },
    });
    view.current = editor;
    const unsubscribeCommand = navigation.onDocumentCommand(document.id, (action) => {
      if (action === "save") actions.current.onSave();
      else if (action === "runFile") actions.current.onRunFile();
      else if (action === "undo") undo(editor);
      else void documents.attempt(document, () => documents.runSelection(document));
    });
    const frame = requestAnimationFrame(() => {
      editor.scrollDOM.scrollTop = document.draft.scrollTop;
      editor.scrollDOM.scrollLeft = document.draft.scrollLeft;
    });
    return () => {
      unsubscribeCommand();
      cancelAnimationFrame(frame);
      if (documents.owns(document)) documents.setScroll(document, editor.scrollDOM.scrollTop, editor.scrollDOM.scrollLeft);
      editor.destroy();
      view.current = null;
    };
  }, [documents, navigation, document.id]);
  useEffect(() => {
    view.current?.dispatch({
      effects: configuration.current.reconfigure(configure()),
    });
  }, [preferences.editorFontSize, preferences.indentWidth, document.path]);
  useEffect(() => {
    const current = documents.getDocumentSnapshot(document.id);
    if (view.current && current && view.current.state !== current.state)
      view.current.setState(current.state);
  });
  return <div className="code-editor" ref={parent} />;
}
export function DocumentPanel({ documentId }: { documentId: string }) {
  const documents = useDocuments(documentId), operations = useOperations(), preferences = usePreferences(), navigation = useNavigation();
  useSession();
  const document = documents.getDocumentSnapshot(documentId);
  const [saveAs, setSaveAs] = useState<{
      captured: string;
      run: boolean;
    } | null>(null),
    [path, setPath] = useState(""),
    [overwrite, setOverwrite] = useState(false),
    [confirmDiscard, setConfirmDiscard] = useState(false);
  if (!document)
    return (
      <div className="empty">
        <p>This draft was discarded or could not be restored.</p>
        <button onClick={() => navigation.showPanel("editor")}>Show Editor</button>
      </div>
    );
  const d = document;
  function attempt(work: () => Promise<unknown>) {
    void documents.attempt(d, work);
  }
  function save() {
    if (!documents.canSave(d)) return;
    if (!d.path) {
      setPath(d.name);
      setSaveAs({ captured: d.raw, run: false });
    } else attempt(() => documents.save(d));
  }
  function runFile() {
    if (!documents.canRunFile(d)) return;
    const captured = d.raw;
    if (!d.path) {
      setPath(d.name);
      setSaveAs({ captured, run: true });
    } else attempt(() => documents.runFile(d, captured));
  }
  const selection = d.state.selection.main,
    line = d.state.doc.lineAt(selection.head);
  return (
    <section className="panel document-panel" data-document-id={d.id}>
      <div className="editor-toolbar">
        <SessionTargetPicker />
        <button
          className="primary"
          aria-label={
            operations.queueing
              ? selection.empty
                ? "Queue Line"
                : "Queue Selection"
              : selection.empty
                ? "Run Line"
                : "Run Selection"
          }
          title={selection.empty ? "Run Line ⌘ Enter" : "Run Selection ⌘ Enter"}
          disabled={!documents.canRunSelection(d)}
          onClick={() => attempt(() => documents.runSelection(d))}
        >
          <Icon name="play" size={14} />{" "}
          <span className="run-label">
            {operations.queueing
              ? selection.empty
                ? "Queue Line"
                : "Queue Selection"
              : selection.empty
                ? "Run Line"
                : "Run Selection"}
          </span>
        </button>
        <kbd className="editor-shortcut">⌘ Enter</kbd>
        <button disabled={!documents.canRunFile(d)} onClick={runFile}>
          {d.runningFile && d.saving
            ? "Saving before run…"
            : operations.queueing
              ? "Queue File"
              : "Run File"}
        </button>
        <button
          className="editor-save"
          disabled={!documents.canSave(d)}
          onClick={save}
        >
          Save
        </button>
        <div className="spacer" />
        <span className="save-status">
          {d.saving
            ? "Saving…"
            : d.draft.readonly
              ? "Read only"
              : d.dirty
                ? "Unsaved"
                : "✓ Saved"}
        </span>
        <Menu.Root>
          <Menu.Trigger className="icon-button" aria-label="Document Actions">
            •••
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu" align="end" sideOffset={4}>
              <Menu.Item disabled={!documents.canSave(d)} onSelect={save}>
                Save ⌘ S
              </Menu.Item>
              <Menu.Item
                disabled={!documents.canSave(d)}
                onSelect={() => {
                  setPath(d.path ?? d.name);
                  setOverwrite(false);
                  setSaveAs({ captured: d.raw, run: false });
                }}
              >
                Save As…
              </Menu.Item>
              <Menu.Item
                disabled={!documents.canRun(d)}
                onSelect={() => attempt(() => documents.format(d))}
              >
                Format
              </Menu.Item>
              <Menu.Item
                disabled={!d.path || d.saving}
                onSelect={() => attempt(() => documents.compareDisk(d))}
              >
                Compare Disk / Reload…
              </Menu.Item>
              <Menu.Item onSelect={() => setConfirmDiscard(true)}>
                Discard Draft…
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {d.error && (
        <div className="document-error" role="alert">
          {d.error}
          {d.path && (
            <button onClick={() => attempt(() => documents.compareDisk(d))}>
              Compare Disk
            </button>
          )}
        </div>
      )}
      {d.draft.readonly && (
        <div className="document-error">
          {d.draft.readonly}
          <br />
          {d.path} · {d.draft.byteSize.toLocaleString()} bytes
        </div>
      )}
      <CodeEditor document={d} onSave={save} onRunFile={runFile} />
      <div className="panel-footer">
        <span>
          Ln {line.number}, Col {selection.head - line.from + 1}
        </span>
        <span>
          {isR(d.path) ? "R" : "Plain Text"}　UTF-8{d.draft.bom ? " BOM" : ""}　
          {d.draft.eol === "\r\n" ? "CRLF" : d.draft.eol === "\r" ? "CR" : "LF"}
          　{preferences.indentWidth} spaces
        </span>
      </div>
      {saveAs && (
        <Modal
          title={saveAs.run ? "Save and Run File" : "Save As"}
          description="Use a project-relative path. Execution starts only after a verified save."
          onClose={() => setSaveAs(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const snapshot = saveAs;
              attempt(async () => {
                if (snapshot.run)
                  await documents.runFile(
                    d,
                    snapshot.captured,
                    path,
                    overwrite,
                  );
                else
                  await documents.save(d, snapshot.captured, path, overwrite);
                setSaveAs(null);
                // Saving changes the existing view title through the navigation port.
              });
            }}
          >
            <label>
              File Path
              <input
                autoFocus
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="analysis.R"
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              Replace content if the target already exists
            </label>
            {d.error && <p className="error">{d.error}</p>}
            <button className="primary" disabled={d.saving}>
              {saveAs.run ? "Save and Run" : "Save"}
            </button>
          </form>
        </Modal>
      )}
      {confirmDiscard && (
        <Modal
          title="Discard Draft"
          description={
            d.dirty
              ? "This document has unsaved edits. Close View keeps them; Discard Draft removes them."
              : "Remove this draft. The disk file is retained."
          }
          onClose={() => setConfirmDiscard(false)}
        >
          <button
            disabled={d.saving}
            onClick={() => {
              if (d.dirty && !d.draft.readonly) save();
              setConfirmDiscard(false);
            }}
          >
            Save First
          </button>
          <button
            className="danger"
            disabled={d.saving}
            onClick={() => {
              documents.discard(d);
              setConfirmDiscard(false);
            }}
          >
            Discard Draft
          </button>
        </Modal>
      )}
      {d.diskComparison && (
        <Modal
          title="Compare Draft and Disk"
          description="Compare the changes. Keeping your draft uses this disk version as the next save base."
          onClose={() => {
            documents.closeComparison(d, "disk");
          }}
        >
          <div className="comparison">
            <div>
              Local Draft<pre>{d.raw}</pre>
            </div>
            <div>
              Disk File<pre>{d.diskComparison.raw}</pre>
            </div>
          </div>
          <button onClick={() => documents.acceptDiskBase(d, true)}>
            Load Disk Content
          </button>
          <button onClick={() => documents.acceptDiskBase(d, false)}>
            Keep Draft with This Disk Base
          </button>
        </Modal>
      )}
      {d.comparison && (
        <Modal
          title="Document Changed during Formatting"
          description="Your edits are retained. Compare the original request with the formatted result."
          onClose={() => {
            documents.closeComparison(d, "format");
          }}
        >
          <div className="comparison">
            <pre>{d.comparison.before}</pre>
            <pre>{d.comparison.formatted}</pre>
          </div>
          <button
            onClick={() => {
              documents.acceptFormatted(d);
            }}
          >
            Apply Formatted Text (Undo Available)
          </button>
        </Modal>
      )}
    </section>
  );
}
