import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { editor as MonacoEditor } from "monaco-editor";

import { sourceExecutionAt, sourceGapNavigationAt, type SourceExecution } from "./source-execution";

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
  readonly onViewStateChange: (viewState: SourceEditorViewState) => void;
  readonly onRun: (execution: SourceExecution) => boolean | Promise<boolean>;
  readonly onRunPendingChange?: (pending: boolean) => void;
  readonly onRunRejected: (message: string) => void;
}

export interface SourceEditorHandle {
  runSelectionOrCurrentLine(): Promise<boolean>;
}

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(function SourceEditor({
  ariaLabel,
  value,
  viewState,
  onChange,
  onBlur,
  onViewStateChange,
  onRun,
  onRunPendingChange,
  onRunRejected,
}, forwardedRef) {
  const mountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const callbacksRef = useRef({
    onChange,
    onBlur,
    onViewStateChange,
    onRun,
    onRunPendingChange,
    onRunRejected,
  });
  const valueRef = useRef(value);
  const viewStateRef = useRef(viewState);
  const syncingRef = useRef(false);
  const runPendingRef = useRef<Promise<boolean> | null>(null);
  const [ready, setReady] = useState(false);
  callbacksRef.current = {
    onChange,
    onBlur,
    onViewStateChange,
    onRun,
    onRunPendingChange,
    onRunRejected,
  };
  valueRef.current = value;
  viewStateRef.current = viewState;

  const runSelectionOrCurrentLine = (): Promise<boolean> => {
    if (runPendingRef.current != null) return runPendingRef.current;
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const textarea = textareaRef.current;
    const sourceValue = model?.getValue() ?? textarea?.value ?? "";
    const selectionStart = model != null && selection != null
      ? model.getOffsetAt(selection.getStartPosition())
      : textarea?.selectionStart ?? 0;
    const selectionEnd = model != null && selection != null
      ? model.getOffsetAt(selection.getEndPosition())
      : textarea?.selectionEnd ?? 0;
    const execution = model != null && selection != null
      ? sourceExecutionAt(
          sourceValue,
          selectionStart,
          selectionEnd,
        )
      : textarea == null
        ? null
        : sourceExecutionAt(sourceValue, selectionStart, selectionEnd);
    const editorOwnedFocus = editor?.hasTextFocus() === true || document.activeElement === textarea;
    const moveCursor = (nextCursor: number): boolean => {
      if (editor != null && model != null) {
        const position = model.getPositionAt(nextCursor);
        editor.setPosition(position);
        editor.revealPositionInCenterIfOutsideViewport(position);
        callbacksRef.current.onViewStateChange({
          cursor_start: nextCursor,
          cursor_end: nextCursor,
          scroll_top: editor.getScrollTop(),
        });
        if (editorOwnedFocus && (editor.hasTextFocus() || document.activeElement === document.body)) {
          editor.focus();
        }
        return true;
      }
      if (textarea != null) {
        textarea.setSelectionRange(nextCursor, nextCursor);
        callbacksRef.current.onViewStateChange({
          cursor_start: nextCursor,
          cursor_end: nextCursor,
          scroll_top: textarea.scrollTop,
        });
        if (editorOwnedFocus && (document.activeElement === textarea || document.activeElement === document.body)) {
          textarea.focus();
        }
      }
      return true;
    };
    if (execution == null) {
      const navigation = sourceGapNavigationAt(sourceValue, selectionStart, selectionEnd);
      if (navigation != null) return Promise.resolve(moveCursor(navigation));
      callbacksRef.current.onRunRejected("Selection or current R expression is empty or incomplete.");
      return Promise.resolve(false);
    }
    callbacksRef.current.onRunPendingChange?.(true);
    const operation = Promise.resolve(callbacksRef.current.onRun(execution)).then((accepted) => {
      if (!accepted || execution.kind !== "expression" || execution.next_cursor == null) return accepted;

      const currentSelection = editor?.getSelection();
      const unchanged = model != null && currentSelection != null
        ? model.getValue() === sourceValue &&
          model.getOffsetAt(currentSelection.getStartPosition()) === selectionStart &&
          model.getOffsetAt(currentSelection.getEndPosition()) === selectionEnd
        : textarea != null && textarea.value === sourceValue &&
          textarea.selectionStart === selectionStart && textarea.selectionEnd === selectionEnd;
      if (!unchanged) return true;

      return moveCursor(execution.next_cursor);
    }).catch((cause: unknown) => {
      callbacksRef.current.onRunRejected(
        cause instanceof Error && cause.message.trim() ? cause.message : "Source execution could not be prepared.",
      );
      return false;
    }).finally(() => {
      if (runPendingRef.current === operation) runPendingRef.current = null;
      callbacksRef.current.onRunPendingChange?.(false);
    });
    runPendingRef.current = operation;
    return operation;
  };
  const runRef = useRef(runSelectionOrCurrentLine);
  runRef.current = runSelectionOrCurrentLine;
  useImperativeHandle(forwardedRef, () => ({
    runSelectionOrCurrentLine: () => runRef.current(),
  }), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount == null || typeof ResizeObserver === "undefined") return;
    let active = true;
    let editor: MonacoEditor.IStandaloneCodeEditor | null = null;
    let model: MonacoEditor.ITextModel | null = null;
    const disposables: { dispose(): void }[] = [];

    void import("./monacoRuntime").then(({ monaco }) => {
      if (!active) return;
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      const createdModel = monaco.editor.createModel(valueRef.current, "r");
      const createdEditor = monaco.editor.create(mount, {
        model: createdModel,
        accessibilitySupport: "auto",
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
        smoothScrolling: !reducedMotion,
        tabSize: 2,
        theme: "vs",
      });
      const initialViewState = viewStateRef.current;
      const start = createdModel.getPositionAt(Math.min(initialViewState.cursor_start, createdModel.getValueLength()));
      const end = createdModel.getPositionAt(Math.min(initialViewState.cursor_end, createdModel.getValueLength()));
      createdEditor.setSelection(new monaco.Selection(
        start.lineNumber,
        start.column,
        end.lineNumber,
        end.column,
      ));
      createdEditor.setScrollTop(initialViewState.scroll_top);
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
      disposables.push(createdEditor.addAction({
        id: "rho.runSelectionOrCurrentLine",
        label: "Run selection or current R expression in Console",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: () => { runRef.current(); },
      }));
      createdEditor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
        () => { runRef.current(); },
      );
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
  }, [ready, value]);

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
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              runRef.current();
            }
          }}
          ref={(element) => {
            textareaRef.current = element;
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
});
