import { useEffect, useRef, useState } from "react";
import type { editor as MonacoEditor } from "monaco-editor";

export interface SourceEditorViewState {
  readonly cursor_start: number;
  readonly cursor_end: number;
  readonly scroll_top: number;
}

interface SourceEditorProps {
  readonly ariaLabel: string;
  readonly value: string;
  readonly viewState: SourceEditorViewState;
  readonly onChange: (value: string) => void;
  readonly onBlur: (viewState: SourceEditorViewState) => void;
}

export function SourceEditor({ ariaLabel, value, viewState, onChange, onBlur }: SourceEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const callbacksRef = useRef({ onChange, onBlur });
  const syncingRef = useRef(false);
  const [ready, setReady] = useState(false);
  callbacksRef.current = { onChange, onBlur };

  useEffect(() => {
    const mount = mountRef.current;
    if (mount == null || typeof ResizeObserver === "undefined") return;
    let active = true;
    let editor: MonacoEditor.IStandaloneCodeEditor | null = null;
    let model: MonacoEditor.ITextModel | null = null;
    const disposables: { dispose(): void }[] = [];

    void import("./monacoRuntime").then(({ monaco }) => {
      if (!active) return;
      const createdModel = monaco.editor.createModel(value, "r");
      const createdEditor = monaco.editor.create(mount, {
        model: createdModel,
        ariaLabel,
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 19,
        minimap: { enabled: false },
        padding: { top: 10, bottom: 10 },
        renderWhitespace: "selection",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        theme: "vs",
      });
      const start = createdModel.getPositionAt(Math.min(viewState.cursor_start, createdModel.getValueLength()));
      const end = createdModel.getPositionAt(Math.min(viewState.cursor_end, createdModel.getValueLength()));
      createdEditor.setSelection(new monaco.Selection(
        start.lineNumber,
        start.column,
        end.lineNumber,
        end.column,
      ));
      createdEditor.setScrollTop(viewState.scroll_top);
      disposables.push(createdEditor.onDidChangeModelContent(() => {
        if (!syncingRef.current) callbacksRef.current.onChange(createdEditor.getValue());
      }));
      disposables.push(createdEditor.onDidBlurEditorText(() => {
        const selection = createdEditor.getSelection();
        callbacksRef.current.onBlur({
          cursor_start: selection == null ? 0 : createdModel.getOffsetAt(selection.getStartPosition()),
          cursor_end: selection == null ? 0 : createdModel.getOffsetAt(selection.getEndPosition()),
          scroll_top: createdEditor.getScrollTop(),
        });
      }));
      model = createdModel;
      editor = createdEditor;
      editorRef.current = createdEditor;
      setReady(true);
    }).catch(() => {
      // The accessible textarea remains the deterministic degraded editor.
    });

    return () => {
      active = false;
      for (const disposable of disposables) disposable.dispose();
      editor?.dispose();
      model?.dispose();
      editorRef.current = null;
    };
  }, [ariaLabel]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor == null || editor.getValue() === value) return;
    syncingRef.current = true;
    editor.setValue(value);
    syncingRef.current = false;
  }, [value]);

  return (
    <div className="rho-source-editor-shell" data-editor-ready={ready ? "true" : "false"}>
      <div className="rho-source-monaco" ref={mountRef} />
      {!ready && (
        <textarea
          className="rho-source-editor"
          aria-label={ariaLabel}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onBlur({
            cursor_start: event.currentTarget.selectionStart,
            cursor_end: event.currentTarget.selectionEnd,
            scroll_top: event.currentTarget.scrollTop,
          })}
          ref={(element) => {
            if (element == null || document.activeElement === element) return;
            if (Math.abs(element.scrollTop - viewState.scroll_top) > 1) {
              element.scrollTop = viewState.scroll_top;
            }
          }}
          spellCheck={false}
        />
      )}
    </div>
  );
}
