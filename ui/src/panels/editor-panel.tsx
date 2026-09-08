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
import { useStudio } from "../context";
import { Modal } from "../primitives";
import { message } from "../host-client";
import type { DocumentModel } from "../documents";

export function EditorHub() {
  const s = useStudio("documents", "runtime", "console", "preferences");
  return (
    <section className="panel editor-hub">
      <div className="editor-toolbar">
        <button className="primary" onClick={() => s.documents.create()}>
          ＋ New R File
        </button>
        <button onClick={() => s.showPanel?.("files")}>Open File</button>
      </div>
      <div className="empty">
        <h2>Start with a script</h2>
        <p>⌘ S Save · ⌘ Enter Run Selection / Line</p>
        <p>⌘ ⇧ Enter Save and Run File</p>
        {!!s.documents.items.size && (
          <div className="document-list">
            {[...s.documents.items.values()].map((d) => (
              <button key={d.id} onClick={() => s.documents.focus(d)}>
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
  document: DocumentModel;
  onSave: () => void;
  onRunFile: () => void;
}) {
  const s = useStudio("documents", "runtime", "console", "preferences"),
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
      EditorState.tabSize.of(s.preferences.indentWidth),
      indentUnit.of(" ".repeat(s.preferences.indentWidth)),
      EditorView.theme({
        "&.cm-editor": { fontSize: `${s.preferences.editorFontSize}px` },
      }),
      ...(isR(document.path)
        ? rSupport(() => s.objects?.objects.map((o) => o.name) ?? [])
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
            void s.documents.runSelection(document).catch((e) => {
              document.error = message(e);
              s.emit();
            });
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
          s.documents.active = document.id;
          s.emit();
        },
        scroll: (_event, v) => {
          document.draft.scrollTop = v.scrollDOM.scrollTop;
          document.draft.scrollLeft = v.scrollDOM.scrollLeft;
          s.persist();
        },
      }),
    ];
    document.state = document.state.update({
      effects: StateEffect.reconfigure.of(extensions),
    }).state;
    const editor = new EditorView({
      parent: parent.current!,
      state: document.state,
      dispatchTransactions(transactions, v) {
        for (const transaction of transactions) document.update(transaction);
        v.update(transactions);
        if (transactions.some((t) => t.docChanged || t.selection))
          s.documents.changed();
      },
    });
    view.current = editor;
    const command = (event: Event) => {
      const { id, action } = (
        event as CustomEvent<{ id: string; action: string }>
      ).detail;
      if (id !== document.id) return;
      if (action === "save") actions.current.onSave();
      else if (action === "runFile") actions.current.onRunFile();
      else if (action === "undo") undo(editor);
      else void s.documents.runSelection(document);
    };
    window.addEventListener("rho-document-command", command);
    const frame = requestAnimationFrame(() => {
      editor.scrollDOM.scrollTop = document.draft.scrollTop;
      editor.scrollDOM.scrollLeft = document.draft.scrollLeft;
    });
    return () => {
      window.removeEventListener("rho-document-command", command);
      cancelAnimationFrame(frame);
      document.draft.scrollTop = editor.scrollDOM.scrollTop;
      document.draft.scrollLeft = editor.scrollDOM.scrollLeft;
      editor.destroy();
      view.current = null;
    };
  }, [s, document.id]);
  useEffect(() => {
    view.current?.dispatch({
      effects: configuration.current.reconfigure(configure()),
    });
  }, [s.preferences.editorFontSize, s.preferences.indentWidth, document.path]);
  useEffect(() => {
    if (view.current && view.current.state !== document.state)
      view.current.setState(document.state);
  });
  return <div className="code-editor" ref={parent} />;
}
export function DocumentPanel({ documentId }: { documentId: string }) {
  const s = useStudio("documents", "runtime", "console", "preferences"),
    document = s.documents.items.get(documentId);
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
        <button onClick={() => s.showPanel?.("editor")}>Show Editor</button>
      </div>
    );
  const d = document;
  function attempt(work: () => Promise<unknown>) {
    d.error = "";
    void work().catch((e) => {
      d.error = message(e);
      s.emit();
    });
  }
  function save() {
    if (!s.documents.canSave(d)) return;
    if (!d.path) {
      setPath(d.name);
      setSaveAs({ captured: d.raw, run: false });
    } else attempt(() => s.documents.save(d));
  }
  function runFile() {
    if (!s.documents.canRunFile(d)) return;
    const captured = d.raw;
    if (!d.path) {
      setPath(d.name);
      setSaveAs({ captured, run: true });
    } else attempt(() => s.documents.runFile(d, captured));
  }
  const selection = d.state.selection.main,
    line = d.state.doc.lineAt(selection.head);
  return (
    <section className="panel document-panel" data-document-id={d.id}>
      <div className="editor-toolbar">
        <button
          className="primary"
          aria-label={
            s.queueing
              ? selection.empty
                ? "Queue Line"
                : "Queue Selection"
              : selection.empty
                ? "Run Line"
                : "Run Selection"
          }
          title={selection.empty ? "Run Line ⌘ Enter" : "Run Selection ⌘ Enter"}
          disabled={!s.documents.canRunSelection(d)}
          onClick={() => attempt(() => s.documents.runSelection(d))}
        >
          <Icon name="play" size={14} />{" "}
          <span className="run-label">
            {s.queueing
              ? selection.empty
                ? "Queue Line"
                : "Queue Selection"
              : selection.empty
                ? "Run Line"
                : "Run Selection"}
          </span>
        </button>
        <kbd className="editor-shortcut">⌘ Enter</kbd>
        <button disabled={!s.documents.canRunFile(d)} onClick={runFile}>
          {d.runningFile && d.saving
            ? "Saving before run…"
            : s.queueing
              ? "Queue File"
              : "Run File"}
        </button>
        <button
          className="editor-save"
          disabled={!s.documents.canSave(d)}
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
              <Menu.Item disabled={!s.documents.canSave(d)} onSelect={save}>
                Save ⌘ S
              </Menu.Item>
              <Menu.Item
                disabled={!s.documents.canSave(d)}
                onSelect={() => {
                  setPath(d.path ?? d.name);
                  setOverwrite(false);
                  setSaveAs({ captured: d.raw, run: false });
                }}
              >
                Save As…
              </Menu.Item>
              <Menu.Item
                disabled={!s.documents.canRun(d)}
                onSelect={() => attempt(() => s.documents.format(d))}
              >
                Format
              </Menu.Item>
              <Menu.Item
                disabled={!d.path || d.saving}
                onSelect={() => attempt(() => s.documents.compareDisk(d))}
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
            <button onClick={() => attempt(() => s.documents.compareDisk(d))}>
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
          　{s.preferences.indentWidth} spaces
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
                  await s.documents.runFile(
                    d,
                    snapshot.captured,
                    path,
                    overwrite,
                  );
                else
                  await s.documents.save(d, snapshot.captured, path, overwrite);
                setSaveAs(null);
                if (!s.closedViews.has(d.id)) s.documents.focus(d);
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
              s.documents.discard(d);
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
            d.diskComparison = null;
            s.emit();
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
          <button onClick={() => s.documents.acceptDiskBase(d, true)}>
            Load Disk Content
          </button>
          <button onClick={() => s.documents.acceptDiskBase(d, false)}>
            Keep Draft with This Disk Base
          </button>
        </Modal>
      )}
      {d.comparison && (
        <Modal
          title="Document Changed during Formatting"
          description="Your edits are retained. Compare the original request with the formatted result."
          onClose={() => {
            d.comparison = null;
            s.emit();
          }}
        >
          <div className="comparison">
            <pre>{d.comparison.before}</pre>
            <pre>{d.comparison.formatted}</pre>
          </div>
          <button
            onClick={() => {
              d.replace(d.comparison!.formatted);
              d.comparison = null;
              s.documents.changed();
            }}
          >
            Apply Formatted Text (Undo Available)
          </button>
        </Modal>
      )}
    </section>
  );
}
