import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { setBlockType, toggleMark } from "prosemirror-commands";
import type { Command } from "prosemirror-state";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { redo, undo } from "prosemirror-history";
import { EditorView } from "prosemirror-view";

import type { VibePage } from "../../../transport";
import {
  blockIdForSelection,
  compactAtomNodeViews,
  createStarterSections,
  findBlockPosition,
  firstTextPosition,
  manuscriptEditorPlugins,
  markIsActive,
  pageHasBlocks,
  sectionsFromEditor,
  selectedTextKind,
  vibePageToDocument,
  vibeSchema,
} from "./manuscript-prosemirror";
import { ManuscriptPageSession } from "./manuscript-page-session";
import type {
  ManuscriptBlockIntent,
  ManuscriptCommit,
  ManuscriptSaveState,
  VibeManuscriptLaneHandle,
} from "./manuscript-types";

interface ManuscriptEditorProps {
  readonly page: VibePage;
  readonly busy: boolean;
  readonly profileRevision: number;
  readonly commitPage: ManuscriptCommit;
  readonly reportError: (error: unknown) => void;
  readonly activeBlockId?: string | null | undefined;
  readonly onActiveBlockChange?: ((intent: ManuscriptBlockIntent) => void) | undefined;
  readonly saveState: ManuscriptSaveState;
  readonly onSaveStateChange: (state: ManuscriptSaveState) => void;
  readonly editorLabel: string;
  readonly describedBy: string;
  readonly onExitEditor: () => void;
}

interface FormatState {
  readonly strong: boolean;
  readonly emphasis: boolean;
  readonly code: boolean;
  readonly textKind: "body" | "heading";
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

const TOOLBAR_CONTROL_IDS = [
  "strong",
  "emphasis",
  "code",
  "heading",
  "body",
  "undo",
  "redo",
  "save",
] as const;

type ToolbarControlId = typeof TOOLBAR_CONTROL_IDS[number];

function formatState(state: EditorState): FormatState {
  return {
    strong: markIsActive(state, "strong"),
    emphasis: markIsActive(state, "emphasis"),
    code: markIsActive(state, "code"),
    textKind: selectedTextKind(state),
    canUndo: undo(state),
    canRedo: redo(state),
  };
}

function blockExists(page: VibePage, blockId: string | null | undefined): blockId is string {
  return blockId != null && page.sections.some(
    (section) => section.blocks.some((block) => block.block_id === blockId),
  );
}

function focusedBlockForSections(
  sections: ReturnType<typeof sectionsFromEditor>,
  candidate: string | null,
): string | null {
  return candidate != null && sections.some(
    (section) => section.blocks.some((block) => block.block_id === candidate),
  ) ? candidate : null;
}

function toolbarControls(toolbar: HTMLElement): HTMLElement[] {
  return [...toolbar.querySelectorAll<HTMLElement>("button:not(:disabled)")];
}

function toolbarControlId(element: HTMLElement): ToolbarControlId | null {
  const value = element.dataset.toolbarControl;
  return TOOLBAR_CONTROL_IDS.find((candidate) => candidate === value) ?? null;
}

export const ManuscriptEditor = forwardRef<VibeManuscriptLaneHandle, ManuscriptEditorProps>(
  function ManuscriptEditor({
    page,
    busy,
    profileRevision,
    commitPage,
    reportError,
    activeBlockId,
    onActiveBlockChange,
    saveState,
    onSaveStateChange,
    editorLabel,
    describedBy,
    onExitEditor,
  }, ref) {
    const mount = useRef<HTMLDivElement>(null);
    const toolbar = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const busyRef = useRef(busy);
    busyRef.current = busy;
    const mounted = useRef(false);
    const selectedBlock = useRef<string | null>(
      blockExists(page, activeBlockId)
        ? activeBlockId
        : blockExists(page, page.focused_block_id) ? page.focused_block_id : null,
    );
    const lastEmittedBlock = useRef<string | null>(null);
    const handlers = useRef({ reportError, onActiveBlockChange, onSaveStateChange, onExitEditor });
    handlers.current = { reportError, onActiveBlockChange, onSaveStateChange, onExitEditor };
    const [visibleBlock, setVisibleBlock] = useState<string | null>(
      blockExists(page, activeBlockId) ? activeBlockId : null,
    );
    const [hasBlocks, setHasBlocks] = useState(() => pageHasBlocks(page));
    const [format, setFormat] = useState<FormatState>(() => formatState(EditorState.create({
      doc: vibePageToDocument(page),
      plugins: [...manuscriptEditorPlugins()],
    })));
    const [toolbarTabStop, setToolbarTabStop] = useState<ToolbarControlId>("strong");
    const toolbarAvailability: Record<ToolbarControlId, boolean> = {
      strong: !busy,
      emphasis: !busy,
      code: !busy,
      heading: !busy,
      body: !busy,
      undo: !busy && format.canUndo,
      redo: !busy && format.canRedo,
      save: !busy && saveState.kind === "dirty",
    };
    const resolvedToolbarTabStop = toolbarAvailability[toolbarTabStop]
      ? toolbarTabStop
      : TOOLBAR_CONTROL_IDS.find((control) => toolbarAvailability[control]) ?? null;

    useEffect(() => {
      if (resolvedToolbarTabStop != null && resolvedToolbarTabStop !== toolbarTabStop) {
        setToolbarTabStop(resolvedToolbarTabStop);
      }
    }, [resolvedToolbarTabStop, toolbarTabStop]);

    const restoreDocument = (durable: VibePage) => {
      const editor = view.current;
      const nextState = EditorState.create({
        doc: vibePageToDocument(durable),
        plugins: [...manuscriptEditorPlugins()],
      });
      if (editor != null) editor.updateState(nextState);
      setHasBlocks(pageHasBlocks(durable));
      setFormat(formatState(nextState));
      selectedBlock.current = blockExists(durable, activeBlockId)
        ? activeBlockId
        : blockExists(durable, durable.focused_block_id) ? durable.focused_block_id : null;
      setVisibleBlock(blockExists(durable, activeBlockId) ? activeBlockId : null);
    };
    const restoreDocumentRef = useRef(restoreDocument);
    restoreDocumentRef.current = restoreDocument;

    const session = useRef<ManuscriptPageSession | null>(null);
    if (session.current == null) {
      session.current = new ManuscriptPageSession({
        page,
        profileRevision,
        commitPage,
        restoreDurable: (durable) => restoreDocumentRef.current(durable),
        reportError: (error) => handlers.current.reportError(error),
        setSaveState: (state) => {
          if (mounted.current) handlers.current.onSaveStateChange(state);
        },
      });
    }
    session.current.setHandlers({
      commitPage,
      restoreDurable: (durable) => restoreDocumentRef.current(durable),
      reportError: (error) => handlers.current.reportError(error),
      setSaveState: (state) => {
        if (mounted.current) handlers.current.onSaveStateChange(state);
      },
    });

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        session.current?.dispose();
      };
    }, []);

    useEffect(() => {
      session.current?.updateDurable(page, profileRevision);
    }, [page, profileRevision]);

    useEffect(() => {
      const element = mount.current;
      if (element == null) return;

      const publishSelection = (state: EditorState) => {
        const blockId = blockIdForSelection(state);
        selectedBlock.current = blockId;
        setVisibleBlock(blockId);
        if (lastEmittedBlock.current === blockId) return;
        lastEmittedBlock.current = blockId;
        handlers.current.onActiveBlockChange?.({ pageId: page.page_id, blockId });
      };

      const editor = new EditorView(element, {
        state: EditorState.create({
          doc: vibePageToDocument(page),
          plugins: [...manuscriptEditorPlugins()],
        }),
        nodeViews: compactAtomNodeViews(),
        editable: () => !busyRef.current,
        attributes: {
          role: "textbox",
          "aria-label": editorLabel,
          "aria-describedby": describedBy,
          "aria-multiline": "true",
          "aria-readonly": String(busyRef.current),
          dir: "auto",
        },
        dispatchTransaction(transaction) {
          if (busyRef.current && transaction.docChanged) return;
          const next = editor.state.apply(transaction);
          editor.updateState(next);
          setFormat(formatState(next));
          if (transaction.selectionSet) publishSelection(next);
          if (transaction.docChanged) {
            const sections = sectionsFromEditor(editor);
            setHasBlocks(sections.some((section) => section.blocks.length > 0));
            session.current?.enqueue(
              sections,
              focusedBlockForSections(sections, selectedBlock.current),
            );
          }
        },
        handleDOMEvents: {
          pointerdown(editorView, event) {
            const target = event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-block-id]")
              : null;
            const blockId = target?.dataset.blockId;
            if (blockId == null) return false;
            const located = findBlockPosition(editorView.state.doc, blockId);
            if (located == null || !located.node.isAtom || !NodeSelection.isSelectable(located.node)) {
              return false;
            }
            event.preventDefault();
            editorView.dispatch(editorView.state.tr.setSelection(
              NodeSelection.create(editorView.state.doc, located.position),
            ));
            editorView.focus();
            return true;
          },
        },
        handleKeyDown(_editorView, event) {
          if (event.key !== "Escape" || event.isComposing) return false;
          handlers.current.onExitEditor();
          return true;
        },
      });
      view.current = editor;
      setFormat(formatState(editor.state));

      return () => {
        editor.destroy();
        if (view.current === editor) view.current = null;
      };
    }, [page.project_id, page.page_id, editorLabel, describedBy]);

    useLayoutEffect(() => {
      const editor = view.current;
      if (editor == null) return;
      editor.setProps({
        editable: () => !busyRef.current,
        attributes: {
          role: "textbox",
          "aria-label": editorLabel,
          "aria-describedby": describedBy,
          "aria-multiline": "true",
          "aria-readonly": String(busy),
          dir: "auto",
        },
      });
    }, [busy, describedBy, editorLabel]);

    useEffect(() => {
      if (activeBlockId === undefined) return;
      const exact = blockExists(page, activeBlockId) ? activeBlockId : null;
      selectedBlock.current = exact;
      setVisibleBlock(exact);
    }, [activeBlockId, page]);

    useEffect(() => {
      const editor = view.current;
      if (editor == null) return;
      for (const block of editor.dom.querySelectorAll<HTMLElement>("[data-block-id]")) {
        if (block.dataset.blockId === visibleBlock) block.dataset.vibeActive = "true";
        else delete block.dataset.vibeActive;
      }
    }, [visibleBlock, page.page_revision]);

    useImperativeHandle(ref, () => ({
      flushPendingEdits: () => session.current?.flush() ?? Promise.resolve(),
      focusEditor: () => view.current?.focus(),
    }), []);

    const runCommand = (command: Command) => {
      const editor = view.current;
      if (editor != null && !busyRef.current) command(editor.state, editor.dispatch, editor);
    };

    const startWriting = () => {
      const editor = view.current;
      if (editor == null || hasBlocks || busyRef.current) return;
      const sections = createStarterSections();
      const next = vibePageToDocument({ ...page, sections });
      editor.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, next.content));
      const position = firstTextPosition(editor.state.doc);
      if (position != null) {
        editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));
      }
      editor.focus();
    };

    const onToolbarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const controls = toolbarControls(event.currentTarget);
      const current = controls.indexOf(event.target as HTMLElement);
      if (current < 0 || controls.length === 0) return;
      event.preventDefault();
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length;
      const target = controls[next]!;
      const targetId = toolbarControlId(target);
      if (targetId != null) setToolbarTabStop(targetId);
      target.focus();
    };

    const onToolbarFocus = (event: React.FocusEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLElement && event.target.matches("button:not(:disabled)")) {
        const targetId = toolbarControlId(event.target);
        if (targetId != null) setToolbarTabStop(targetId);
      }
    };

    const preserveSelection = (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault();

    return (
      <>
        <div
          ref={toolbar}
          className="rho-vibe-manuscript-toolbar"
          role="toolbar"
          aria-label="Working manuscript formatting"
          onKeyDown={onToolbarKeyDown}
          onFocusCapture={onToolbarFocus}
        >
          <button
            type="button"
            data-toolbar-control="strong"
            tabIndex={resolvedToolbarTabStop === "strong" ? 0 : -1}
            aria-label="Bold"
            aria-keyshortcuts="Control+B Meta+B"
            aria-pressed={format.strong}
            disabled={!toolbarAvailability.strong}
            onMouseDown={preserveSelection}
            onClick={() => runCommand(toggleMark(vibeSchema.marks.strong))}
          ><strong aria-hidden="true">B</strong></button>
          <button
            type="button"
            data-toolbar-control="emphasis"
            tabIndex={resolvedToolbarTabStop === "emphasis" ? 0 : -1}
            aria-label="Italic"
            aria-keyshortcuts="Control+I Meta+I"
            aria-pressed={format.emphasis}
            disabled={!toolbarAvailability.emphasis}
            onMouseDown={preserveSelection}
            onClick={() => runCommand(toggleMark(vibeSchema.marks.emphasis))}
          ><em aria-hidden="true">I</em></button>
          <button
            type="button"
            data-toolbar-control="code"
            tabIndex={resolvedToolbarTabStop === "code" ? 0 : -1}
            aria-label="Inline code"
            aria-pressed={format.code}
            disabled={!toolbarAvailability.code}
            onMouseDown={preserveSelection}
            onClick={() => runCommand(toggleMark(vibeSchema.marks.code))}
          ><code aria-hidden="true">&lt;/&gt;</code></button>
          <button
            type="button"
            data-toolbar-control="heading"
            tabIndex={resolvedToolbarTabStop === "heading" ? 0 : -1}
            aria-label="Heading"
            aria-pressed={format.textKind === "heading"}
            disabled={!toolbarAvailability.heading}
            onMouseDown={preserveSelection}
            onClick={() => runCommand(setBlockType(vibeSchema.nodes.heading, { level: 2 }))}
          >Heading</button>
          <button
            type="button"
            data-toolbar-control="body"
            tabIndex={resolvedToolbarTabStop === "body" ? 0 : -1}
            aria-label="Body text"
            aria-pressed={format.textKind === "body"}
            disabled={!toolbarAvailability.body}
            onMouseDown={preserveSelection}
            onClick={() => runCommand(setBlockType(vibeSchema.nodes.paragraph))}
          >Body</button>
          <span className="rho-vibe-manuscript-toolbar-separator" aria-hidden="true" />
          <button
            type="button"
            data-toolbar-control="undo"
            tabIndex={resolvedToolbarTabStop === "undo" ? 0 : -1}
            aria-label="Undo manuscript edit"
            disabled={!toolbarAvailability.undo}
            onMouseDown={preserveSelection}
            onClick={() => runCommand(undo)}
          >Undo</button>
          <button
            type="button"
            data-toolbar-control="redo"
            tabIndex={resolvedToolbarTabStop === "redo" ? 0 : -1}
            aria-label="Redo manuscript edit"
            disabled={!toolbarAvailability.redo}
            onMouseDown={preserveSelection}
            onClick={() => runCommand(redo)}
          >Redo</button>
          <button
            type="button"
            data-toolbar-control="save"
            tabIndex={resolvedToolbarTabStop === "save" ? 0 : -1}
            className="rho-vibe-manuscript-save"
            disabled={!toolbarAvailability.save}
            onClick={() => void session.current?.flush()}
          >Save now</button>
        </div>
        {!hasBlocks && (
          <div className="rho-vibe-manuscript-empty">
            <p>This working manuscript has no content yet.</p>
            <button type="button" disabled={busy} onClick={startWriting}>Start writing</button>
          </div>
        )}
        <div
          ref={mount}
          className="rho-vibe-manuscript-editor"
          data-empty={String(!hasBlocks)}
        />
      </>
    );
  },
);
