import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Schema } from "prosemirror-model";
import type { Mark, Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, NodeSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import type {
  ProjectUiProfileSnapshot,
  SurfaceInstance,
  VibeBlock,
  VibeBlockContent,
  VibeGridPlacement,
  VibePage,
  VibePageExport,
  VibeRichTextBlock,
  VibeRichTextInline,
  VibeRichTextMark,
  VibeSection,
} from "../transport";
import { SurfaceViewport } from "./SurfaceViewport";
import { surfaceDisplayLabel, surfaceUxProfile } from "./surface-ux";

const ATOM_KINDS = [
  "callout",
  "divider",
  "file_excerpt",
  "artifact_ref",
  "finding_ref",
  "task_ref",
  "surface_ref",
  "command_ref",
] as const;

const atomNodes = Object.fromEntries(ATOM_KINDS.map((kind) => [kind, {
  group: "vibe_block",
  atom: true,
  selectable: true,
  attrs: { block_id: {}, payload: {}, placement: { default: null } },
  toDOM: (node: ProseMirrorNode) => ["div", blockDomAttrs(node, `rho-vibe-atom rho-vibe-atom-${kind}`), atomLabel(kind, node.attrs.payload as string)],
  parseDOM: [{ tag: `[data-vibe-kind='${kind}']` }],
}])) as Record<string, object>;

export const vibeSchema = new Schema({
  nodes: {
    doc: { content: "section*" },
    section: {
      content: "vibe_block*",
      attrs: { section_id: {}, heading: { default: null }, layout_kind: { default: "flow" } },
      toDOM: (node) => [
        "section",
        {
          class: "rho-vibe-section",
          "data-section-id": node.attrs.section_id as string,
          "data-layout": node.attrs.layout_kind as string,
        },
        ...(node.attrs.heading == null
          ? []
          : [["h2", { contenteditable: "false" }, node.attrs.heading as string]]),
        ["div", { class: "rho-vibe-blocks" }, 0],
      ],
    },
    rich_text: {
      group: "vibe_block",
      content: "(paragraph | heading)+",
      attrs: { block_id: {}, placement: { default: null } },
      toDOM: (node) => ["div", blockDomAttrs(node, "rho-vibe-block rho-vibe-block-rich_text"), 0],
    },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    heading: {
      content: "inline*",
      group: "block",
      defining: true,
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${node.attrs.level as number}`, 0],
    },
    text: { group: "inline" },
    ...atomNodes,
  },
  marks: {
    strong: { toDOM: () => ["strong", 0] },
    emphasis: { toDOM: () => ["em", 0] },
    code: { toDOM: () => ["code", 0] },
    link: {
      attrs: { href: {} },
      inclusive: false,
      toDOM: (mark) => ["a", { href: mark.attrs.href as string, rel: "noreferrer" }, 0],
    },
  },
});

function editorPlugins() {
  return [
    history(),
    keymap({
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
      "Mod-b": toggleMark(vibeSchema.marks.strong!),
      "Mod-i": toggleMark(vibeSchema.marks.emphasis!),
      "Mod-`": toggleMark(vibeSchema.marks.code!),
    }),
    keymap(baseKeymap),
  ];
}

function atomLabel(kind: string, payload: string): string {
  const content = JSON.parse(payload) as VibeBlockContent;
  if ("label" in content && typeof content.label === "string") return content.label;
  if (kind === "surface_ref" && "instance_id" in content) return `Surface · ${content.instance_id}`;
  if (kind === "file_excerpt" && "resource" in content) return `File · ${content.resource.resource_id}`;
  if (kind === "callout" && "text" in content) return content.text;
  return kind.replaceAll("_", " ");
}

function blockDomAttrs(node: ProseMirrorNode, className: string): Record<string, string> {
  const placement = placementValue(node.attrs.placement);
  return {
    class: className,
    dir: "auto",
    "data-block-id": node.attrs.block_id as string,
    "data-vibe-kind": node.type.name,
    ...(placement == null ? {} : {
      style: `--rho-grid-column:${placement.column_start};--rho-grid-span:${placement.column_span};--rho-grid-row:${placement.row_start}`,
    }),
  };
}

function placementValue(value: unknown): VibeGridPlacement | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return JSON.parse(value) as VibeGridPlacement;
}

function markFromContract(mark: VibeRichTextMark): Mark {
  return mark.kind === "link"
    ? vibeSchema.marks.link.create({ href: mark.href })
    : vibeSchema.marks[mark.kind].create();
}

function inlineNodes(inlines: readonly VibeRichTextInline[]): ProseMirrorNode[] {
  return inlines
    .filter((inline) => inline.text.length > 0)
    .map((inline) => vibeSchema.text(inline.text, inline.marks.map(markFromContract)));
}

function richNode(block: VibeBlock, placement: VibeGridPlacement | null): ProseMirrorNode {
  if (block.content.kind !== "rich_text") throw new Error("Expected rich-text block.");
  const children = block.content.document.blocks.map((child) => {
    const content = inlineNodes(child.content);
    return child.kind === "heading"
      ? vibeSchema.nodes.heading.create({ level: child.level }, content)
      : vibeSchema.nodes.paragraph.create(null, content);
  });
  return vibeSchema.nodes.rich_text.create(
    { block_id: block.block_id, placement: placement == null ? null : JSON.stringify(placement) },
    children,
  );
}

function blockNode(block: VibeBlock, placement: VibeGridPlacement | null): ProseMirrorNode {
  if (block.content.kind === "rich_text") return richNode(block, placement);
  return vibeSchema.nodes[block.content.kind]!.create({
    block_id: block.block_id,
    payload: JSON.stringify(block.content),
    placement: placement == null ? null : JSON.stringify(placement),
  });
}

export function vibePageToDocument(page: VibePage): ProseMirrorNode {
  return vibeSchema.nodes.doc.create(null, page.sections.map((section) => {
    const placements = new Map(
      section.layout.kind === "grid"
        ? section.layout.placements.map((placement) => [placement.block_id, placement] as const)
        : [],
    );
    return vibeSchema.nodes.section.create(
      {
        section_id: section.section_id,
        heading: section.heading,
        layout_kind: section.layout.kind,
      },
      section.blocks.map((block) => blockNode(block, placements.get(block.block_id) ?? null)),
    );
  }));
}

function markToContract(mark: Mark): VibeRichTextMark {
  switch (mark.type.name) {
    case "strong": return { kind: "strong" };
    case "emphasis": return { kind: "emphasis" };
    case "code": return { kind: "code" };
    case "link": return { kind: "link", href: mark.attrs.href as string };
    default: throw new Error(`Unsupported rich-text mark ${mark.type.name}.`);
  }
}

function inlineContract(node: ProseMirrorNode): VibeRichTextInline[] {
  const result: VibeRichTextInline[] = [];
  node.forEach((child) => {
    if (!child.isText) return;
    const marks = child.marks.map(markToContract);
    const previous = result.at(-1);
    if (previous != null && JSON.stringify(previous.marks) === JSON.stringify(marks)) {
      result[result.length - 1] = { text: previous.text + (child.text ?? ""), marks };
    } else {
      result.push({ text: child.text ?? "", marks });
    }
  });
  return result;
}

function richContract(node: ProseMirrorNode): VibeRichTextBlock[] {
  const blocks: VibeRichTextBlock[] = [];
  node.forEach((child) => {
    blocks.push(child.type.name === "heading"
      ? { kind: "heading", level: child.attrs.level as 1 | 2 | 3, content: inlineContract(child) }
      : { kind: "paragraph", content: inlineContract(child) });
  });
  return blocks;
}

export function documentToVibeSections(document: ProseMirrorNode): VibeSection[] {
  const sections: VibeSection[] = [];
  document.forEach((sectionNode) => {
    const blocks: VibeBlock[] = [];
    const placements: VibeGridPlacement[] = [];
    sectionNode.forEach((node) => {
      const blockId = node.attrs.block_id as string;
      const placement = placementValue(node.attrs.placement);
      if (placement != null) placements.push(placement);
      const content: VibeBlockContent = node.type.name === "rich_text"
        ? { kind: "rich_text", document: { blocks: richContract(node) } }
        : JSON.parse(node.attrs.payload as string) as VibeBlockContent;
      blocks.push({ block_id: blockId, content });
    });
    const layoutKind = sectionNode.attrs.layout_kind as "flow" | "grid";
    sections.push({
      section_id: sectionNode.attrs.section_id as string,
      heading: sectionNode.attrs.heading as string | null,
      layout: layoutKind === "grid" ? { kind: "grid", placements } : { kind: "flow" },
      blocks,
    });
  });
  return sections;
}

function nextId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  return `${prefix}:${uuid}`;
}

function plainBlock(): VibeBlock {
  return {
    block_id: nextId("vibe-block"),
    content: {
      kind: "rich_text",
      document: { blocks: [{ kind: "paragraph", content: [] }] },
    },
  };
}

function surfaceBlock(instanceId: string): VibeBlock {
  return {
    block_id: nextId("vibe-block"),
    content: { kind: "surface_ref", instance_id: instanceId, live: true },
  };
}

function flowSection(blocks: readonly VibeBlock[] = []): VibeSection {
  return {
    section_id: nextId("vibe-section"),
    heading: null,
    layout: { kind: "flow" },
    blocks,
  };
}

function reflow(section: VibeSection, spans?: ReadonlyMap<string, number>): VibeSection {
  let row = 1;
  let column = 1;
  const placements = section.blocks.map((block) => {
    const requested = Math.max(1, Math.min(12, spans?.get(block.block_id) ?? 12));
    if (column + requested - 1 > 12) {
      row += 1;
      column = 1;
    }
    const placement = { block_id: block.block_id, row_start: row, column_start: column, column_span: requested };
    column += requested;
    if (column > 12) {
      row += 1;
      column = 1;
    }
    return placement;
  });
  return { ...section, layout: { kind: "grid", placements } };
}

interface VibePageEditorProps {
  readonly page: VibePage;
  readonly profileRevision: number;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly renderSurface: (instance: SurfaceInstance) => ReactNode;
  readonly invokeCommand: (commandId: string) => Promise<void>;
  readonly commit: (request: {
    readonly target: { readonly project_id: string; readonly expected_profile_revision: number };
    readonly page_id: string;
    readonly expected_page_revision: number;
    readonly mutation: { readonly kind: "replace_sections"; readonly sections: readonly VibeSection[]; readonly focused_block_id: string | null };
  }) => Promise<ProjectUiProfileSnapshot>;
  readonly exportPage: (request: {
    readonly project_id: string;
    readonly expected_profile_revision: number;
    readonly page_id: string;
    readonly expected_page_revision: number;
  }) => Promise<VibePageExport>;
  readonly reportError: (error: unknown) => void;
}

interface PersistQueue {
  running: boolean;
  timer: number | null;
  desired: { readonly sections: VibeSection[]; readonly focusedBlockId: string | null } | null;
  profileRevision: number;
  pageRevision: number;
}

class ReactAtomView {
  readonly dom: HTMLElement;
  readonly #root: Root;
  #node: ProseMirrorNode;
  readonly #content: (node: ProseMirrorNode) => ReactNode;
  readonly #onDestroy: () => void;
  constructor(
    node: ProseMirrorNode,
    content: (node: ProseMirrorNode) => ReactNode,
    onSelect: () => void,
    onDestroy: () => void,
  ) {
    this.#node = node;
    this.#content = content;
    this.#onDestroy = onDestroy;
    this.dom = document.createElement("div");
    this.dom.addEventListener("pointerdown", onSelect);
    this.#root = createRoot(this.dom);
    this.refresh();
  }
  refresh(): void {
    const node = this.#node;
    Object.assign(this.dom.dataset, { blockId: node.attrs.block_id as string, vibeKind: node.type.name });
    this.dom.className = `rho-vibe-block rho-vibe-block-${node.type.name}`;
    const placement = placementValue(node.attrs.placement);
    if (placement != null) {
      this.dom.style.setProperty("--rho-grid-column", String(placement.column_start));
      this.dom.style.setProperty("--rho-grid-span", String(placement.column_span));
      this.dom.style.setProperty("--rho-grid-row", String(placement.row_start));
    } else {
      this.dom.style.removeProperty("--rho-grid-column");
      this.dom.style.removeProperty("--rho-grid-span");
      this.dom.style.removeProperty("--rho-grid-row");
    }
    this.#root.render(this.#content(node));
  }
  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.refresh();
    return true;
  }
  selectNode(): void { this.dom.classList.add("ProseMirror-selectednode"); }
  deselectNode(): void { this.dom.classList.remove("ProseMirror-selectednode"); }
  stopEvent(): boolean { return true; }
  ignoreMutation(): boolean { return true; }
  destroy(): void {
    this.#onDestroy();
    queueMicrotask(() => this.#root.unmount());
  }
}

export function VibePageEditor({
  page, profileRevision, instances, renderSurface, invokeCommand, commit, exportPage, reportError,
}: VibePageEditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const atomViews = useRef(new Set<ReactAtomView>());
  const durablePage = useRef(page);
  const handlers = useRef({ instances, renderSurface, invokeCommand });
  const queue = useRef<PersistQueue>({
    running: false,
    timer: null,
    desired: null,
    profileRevision,
    pageRevision: page.page_revision,
  });
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const selectedBlockRef = useRef<string | null>(null);
  const [exported, setExported] = useState<VibePageExport | null>(null);
  const [saving, setSaving] = useState(false);
  handlers.current = { instances, renderSurface, invokeCommand };
  durablePage.current = page;
  queue.current.profileRevision = Math.max(queue.current.profileRevision, profileRevision);
  queue.current.pageRevision = Math.max(queue.current.pageRevision, page.page_revision);

  const resetToDurable = () => {
    const editor = view.current;
    if (editor == null) return;
    editor.updateState(EditorState.create({
      doc: vibePageToDocument(durablePage.current),
      plugins: editorPlugins(),
    }));
  };

  const flush = async () => {
    const current = queue.current;
    if (current.running || current.desired == null) return;
    if (current.timer != null) window.clearTimeout(current.timer);
    current.timer = null;
    const desired = current.desired;
    current.desired = null;
    current.running = true;
    setSaving(true);
    try {
      const snapshot = await commit({
        target: {
          project_id: page.project_id,
          expected_profile_revision: current.profileRevision,
        },
        page_id: page.page_id,
        expected_page_revision: current.pageRevision,
        mutation: {
          kind: "replace_sections",
          sections: desired.sections,
          focused_block_id: desired.focusedBlockId,
        },
      });
      const saved = snapshot.profile.vibe_pages.find((candidate) => candidate.page_id === page.page_id);
      if (saved == null) throw new Error("Committed Vibe Page disappeared from its Profile.");
      current.profileRevision = snapshot.profile.revision;
      current.pageRevision = saved.page_revision;
      durablePage.current = saved;
    } catch (error: unknown) {
      current.desired = null;
      reportError(error);
      resetToDurable();
    } finally {
      current.running = false;
      setSaving(false);
      if (current.desired != null) void flush();
    }
  };

  const enqueue = (document: ProseMirrorNode) => {
    queue.current.desired = {
      sections: documentToVibeSections(document),
      focusedBlockId: selectedBlockRef.current,
    };
    if (queue.current.timer != null) window.clearTimeout(queue.current.timer);
    queue.current.timer = window.setTimeout(() => void flush(), 180);
  };

  useEffect(() => {
    const element = mount.current;
    if (element == null) return;
    const renderAtom = (node: ProseMirrorNode) => {
      const content = JSON.parse(node.attrs.payload as string) as VibeBlockContent;
      if (content.kind === "surface_ref") {
        const instance = handlers.current.instances.get(content.instance_id);
        const profile = instance == null ? null : surfaceUxProfile(instance.surface_id);
        return instance == null || !content.live
          ? <div className="rho-vibe-missing">Surface {content.instance_id} is unavailable. Its exact place is preserved.</div>
          : <SurfaceViewport label={surfaceDisplayLabel(instance.surface_id)}>
              <div className={`rho-vibe-live-surface rho-vibe-live-surface-${profile!.areaRole}`}>{handlers.current.renderSurface(instance)}</div>
            </SurfaceViewport>;
      }
      if (content.kind === "command_ref") {
        return <button className="rho-vibe-command" type="button" onClick={() => void handlers.current.invokeCommand(content.command_id).catch(reportError)}><span>Command</span><strong>{content.label}</strong><code>{content.command_id}</code></button>;
      }
      return <div className="rho-vibe-reference"><span>{content.kind.replaceAll("_", " ")}</span><strong>{atomLabel(content.kind, JSON.stringify(content))}</strong></div>;
    };
    const nodeViews = Object.fromEntries(ATOM_KINDS.map((kind) => [kind, (node: ProseMirrorNode) => {
      const atomView = new ReactAtomView(
        node,
        renderAtom,
        () => {
          const blockId = node.attrs.block_id as string;
          for (const candidate of atomViews.current) candidate.deselectNode();
          atomView.selectNode();
          setSelectedBlock(blockId);
          selectedBlockRef.current = blockId;
          const editor = view.current;
          if (editor != null) enqueue(editor.state.doc);
        },
        () => atomViews.current.delete(atomView),
      );
      atomViews.current.add(atomView);
      return atomView;
    }])) as Record<string, (node: ProseMirrorNode) => ReactAtomView>;
    const editor = new EditorView(element, {
      state: EditorState.create({
        doc: vibePageToDocument(page),
        plugins: editorPlugins(),
      }),
      nodeViews,
      attributes: {
        role: "textbox",
        "aria-label": `${page.label} rich document`,
        "aria-multiline": "true",
      },
      dispatchTransaction(transaction) {
        const next = editor.state.apply(transaction);
        editor.updateState(next);
        if (transaction.docChanged) enqueue(next.doc);
      },
      handleClickOn(editorView, _position, node, nodePosition, event) {
        const target = event.target as HTMLElement | null;
        const block = target?.closest<HTMLElement>("[data-block-id]");
        const blockId = block?.dataset.blockId ?? null;
        setSelectedBlock(blockId);
        selectedBlockRef.current = blockId;
        enqueue(editorView.state.doc);
        if (node.isAtom && NodeSelection.isSelectable(node)) {
          editorView.dispatch(editorView.state.tr.setSelection(NodeSelection.create(editorView.state.doc, nodePosition)));
        }
        return false;
      },
    });
    view.current = editor;
    return () => {
      if (queue.current.timer != null) window.clearTimeout(queue.current.timer);
      editor.destroy();
      view.current = null;
    };
  }, [page.page_id]);

  useEffect(() => {
    for (const atomView of atomViews.current) atomView.refresh();
  }, [instances]);

  useEffect(() => {
    if (queue.current.running || queue.current.desired != null) return;
    const editor = view.current;
    if (editor != null && !editor.state.doc.eq(vibePageToDocument(page))) resetToDurable();
  }, [page.page_revision]);

  const replaceSections = (change: (sections: VibeSection[]) => VibeSection[]) => {
    const editor = view.current;
    if (editor == null) return;
    const sections = change(documentToVibeSections(editor.state.doc));
    const next = vibePageToDocument({ ...page, sections });
    editor.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, next.content));
  };
  const runCommand = (command: Command) => {
    const editor = view.current;
    if (editor != null) command(editor.state, editor.dispatch, editor);
  };
  const locate = (sections: readonly VibeSection[]) => {
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const blockIndex = sections[sectionIndex]!.blocks.findIndex((block) => block.block_id === selectedBlockRef.current);
      if (blockIndex >= 0) return { sectionIndex, blockIndex };
    }
    return null;
  };
  const addBlock = (block: VibeBlock) => replaceSections((sections) => {
    if (sections.length === 0) return [flowSection([block])];
    const index = locate(sections)?.sectionIndex ?? sections.length - 1;
    const target = sections[index]!;
    const next = [...sections];
    const updated = { ...target, blocks: [...target.blocks, block] };
    next[index] = target.layout.kind === "grid" ? reflow(updated) : updated;
    return next;
  });
  const referenced = useMemo(() => new Set(page.sections.flatMap((section) => section.blocks.flatMap((block) => block.content.kind === "surface_ref" && block.content.live ? [block.content.instance_id] : []))), [page]);
  const unplaced = [...instances.values()].filter((instance) => !referenced.has(instance.instance_id));
  const move = (delta: number) => replaceSections((sections) => {
    const found = locate(sections);
    if (found == null) return sections;
    const source = sections[found.sectionIndex]!;
    const sourceBlocks = [...source.blocks];
    const [block] = sourceBlocks.splice(found.blockIndex, 1);
    if (block == null) return sections;
    const next = [...sections];
    const sourceSpans = source.layout.kind === "grid"
      ? new Map(source.layout.placements.map((item) => [item.block_id, item.column_span]))
      : undefined;
    if (delta < 0 && found.blockIndex === 0 && found.sectionIndex > 0) {
      const target = sections[found.sectionIndex - 1]!;
      const updated = { ...target, blocks: [...target.blocks, block] };
      next[found.sectionIndex - 1] = target.layout.kind === "grid"
        ? reflow(updated, new Map(target.layout.placements.map((item) => [item.block_id, item.column_span])))
        : updated;
    } else if (delta > 0 && found.blockIndex === source.blocks.length - 1 && found.sectionIndex + 1 < sections.length) {
      const target = sections[found.sectionIndex + 1]!;
      const updated = { ...target, blocks: [block, ...target.blocks] };
      next[found.sectionIndex + 1] = target.layout.kind === "grid"
        ? reflow(updated, new Map(target.layout.placements.map((item) => [item.block_id, item.column_span])))
        : updated;
    } else {
      const nextIndex = Math.max(0, Math.min(sourceBlocks.length, found.blockIndex + delta));
      if (nextIndex === found.blockIndex) return sections;
      sourceBlocks.splice(nextIndex, 0, block);
    }
    const updatedSource = { ...source, blocks: sourceBlocks };
    next[found.sectionIndex] = source.layout.kind === "grid"
      ? reflow(updatedSource, sourceSpans)
      : updatedSource;
    return next;
  });
  const changeSpan = (delta: number) => replaceSections((sections) => {
    const found = locate(sections);
    if (found == null) return sections;
    const target = sections[found.sectionIndex]!;
    if (target.layout.kind !== "grid") return sections;
    const spans = new Map(target.layout.placements.map((item) => [item.block_id, item.column_span]));
    const id = target.blocks[found.blockIndex]!.block_id;
    spans.set(id, Math.max(1, Math.min(12, (spans.get(id) ?? 12) + delta)));
    const next = [...sections];
    next[found.sectionIndex] = reflow(target, spans);
    return next;
  });

  return (
    <article className="rho-vibe-page rho-vibe-editor" data-page-id={page.page_id}>
      <header className="rho-vibe-page-header">
        <div>
          <span className="rho-eyebrow">Vibe page</span>
          <div className="rho-vibe-page-identity">
            <h1>{page.label}</h1>
            <span className="rho-vibe-save-state" role="status">{saving ? "Saving…" : "Saved"}</span>
          </div>
        </div>
      </header>
      <div className="rho-vibe-toolbar" role="toolbar" aria-label="Vibe Page composition">
        <div className="rho-vibe-toolbar-group rho-vibe-text-tools" role="group" aria-label="Text formatting">
          <button type="button" onClick={() => runCommand(toggleMark(vibeSchema.marks.strong!))} aria-label="Bold" title="Bold"><strong>B</strong></button>
          <button type="button" onClick={() => runCommand(toggleMark(vibeSchema.marks.emphasis!))} aria-label="Italic" title="Italic"><em>I</em></button>
          <button type="button" onClick={() => runCommand(toggleMark(vibeSchema.marks.code!))} aria-label="Inline code" title="Inline code"><code>&lt;/&gt;</code></button>
          <button type="button" onClick={() => runCommand(setBlockType(vibeSchema.nodes.heading!, { level: 2 }))}>Heading</button>
          <button type="button" onClick={() => runCommand(setBlockType(vibeSchema.nodes.paragraph!))}>Body</button>
        </div>
        <div className="rho-vibe-toolbar-group" role="group" aria-label="Edit history">
          <button type="button" onClick={() => runCommand(undo)} aria-label="Undo Page edit">Undo</button>
          <button type="button" onClick={() => runCommand(redo)} aria-label="Redo Page edit">Redo</button>
        </div>
        <div className="rho-vibe-toolbar-group rho-vibe-add-tools" role="group" aria-label="Add content">
          <button type="button" onClick={() => addBlock(plainBlock())}>Add text</button>
          <button type="button" onClick={() => replaceSections((sections) => [...sections, flowSection()])}>New section</button>
          <select aria-label="Add component" value="" onChange={(event) => { if (event.target.value) addBlock(surfaceBlock(event.target.value)); }}>
            <option value="">Add component…</option>
            {unplaced.map((instance) => <option value={instance.instance_id} key={instance.instance_id}>{surfaceDisplayLabel(instance.surface_id)}</option>)}
          </select>
        </div>
        <div className="rho-vibe-toolbar-group rho-vibe-document-tools" role="group" aria-label="Document actions">
          <button type="button" onClick={() => void flush()}>Save now</button>
          <button type="button" onClick={() => void exportPage({
            project_id: page.project_id,
            expected_profile_revision: queue.current.profileRevision,
            page_id: page.page_id,
            expected_page_revision: queue.current.pageRevision,
          }).then(setExported).catch(reportError)}>Export</button>
        </div>
      </div>
      {selectedBlock != null && <div className="rho-vibe-selection-tools" role="toolbar" aria-label="Selected block actions">
        <span>Selected block</span>
        <button type="button" disabled={selectedBlock == null} onClick={() => move(-1)} aria-label="Move selected block earlier">↑</button>
        <button type="button" disabled={selectedBlock == null} onClick={() => move(1)} aria-label="Move selected block later">↓</button>
        <button type="button" disabled={selectedBlock == null} onClick={() => changeSpan(-1)} aria-label="Narrow selected grid block">Narrower</button>
        <button type="button" disabled={selectedBlock == null} onClick={() => changeSpan(1)} aria-label="Widen selected grid block">Wider</button>
        <button type="button" disabled={selectedBlock == null} onClick={() => replaceSections((sections) => {
          const found = locate(sections);
          if (found == null) return sections;
          const next = [...sections];
          const target = sections[found.sectionIndex]!;
          const blocks = target.blocks.filter((_, index) => index !== found.blockIndex);
          next[found.sectionIndex] = target.layout.kind === "grid" ? reflow({ ...target, blocks }) : { ...target, blocks };
          setSelectedBlock(null);
          selectedBlockRef.current = null;
          return next;
        })}>Remove block</button>
        {(() => {
          const found = locate(page.sections);
          const index = found?.sectionIndex ?? Math.max(0, page.sections.length - 1);
          const target = page.sections[index];
          const currentLayout = target?.layout.kind ?? "flow";
          return (
            <button type="button" disabled={target == null} onClick={() => replaceSections((sections) => {
              const found = locate(sections);
              const index = found?.sectionIndex ?? Math.max(0, sections.length - 1);
              const target = sections[index];
              if (target == null) return sections;
              const next = [...sections];
              next[index] = target.layout.kind === "grid" ? { ...target, layout: { kind: "flow" } } : reflow(target);
              return next;
            })}>Section: {currentLayout === "grid" ? "Grid" : "Flow"}</button>
          );
        })()}
      </div>}
      <div ref={mount} className="rho-vibe-prosemirror" aria-label={`${page.label} editor`} />
      {exported != null && <aside className="rho-vibe-export" aria-label="Read-only Page export"><header><strong>Deterministic export</strong><button type="button" onClick={() => setExported(null)}>Close</button></header><pre>{exported.markdown}</pre></aside>}
    </article>
  );
}
