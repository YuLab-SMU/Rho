import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import type { Node as ProseMirrorNode, NodeType } from "prosemirror-model";
import { NodeSelection, Plugin } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView, NodeView } from "prosemirror-view";

import type { VibeBlockContent, VibePage, VibeSection } from "../../../transport";
import {
  documentToVibeSections,
  vibePageToDocument,
  vibeSchema,
} from "../../VibePageEditor";

import { keymap } from "prosemirror-keymap";

const PLACEHOLDER = "Write the working manuscript…";

function nextId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    ?? `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  return `${prefix}:${random}`;
}

export function createStarterSections(): readonly VibeSection[] {
  return [{
    section_id: nextId("vibe-section"),
    heading: null,
    layout: { kind: "flow" },
    blocks: [{
      block_id: nextId("vibe-block"),
      content: {
        kind: "rich_text",
        document: { blocks: [{ kind: "paragraph", content: [] }] },
      },
    }],
  }];
}

export function pageHasBlocks(page: VibePage): boolean {
  return page.sections.some((section) => section.blocks.length > 0);
}

export function blockIdForSelection(state: EditorState): string | null {
  if (state.selection instanceof NodeSelection) {
    const selected = state.selection.node.attrs.block_id;
    if (typeof selected === "string" && selected.length > 0) return selected;
  }
  for (let depth = state.selection.$from.depth; depth >= 0; depth -= 1) {
    const candidate = state.selection.$from.node(depth).attrs.block_id;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

export function findBlockPosition(
  document: ProseMirrorNode,
  blockId: string,
): { readonly position: number; readonly node: ProseMirrorNode } | null {
  let result: { readonly position: number; readonly node: ProseMirrorNode } | null = null;
  document.descendants((node, position) => {
    if (node.attrs.block_id === blockId) {
      result = { position, node };
      return false;
    }
    return result == null;
  });
  return result;
}

export function firstTextPosition(document: ProseMirrorNode): number | null {
  let result: number | null = null;
  document.descendants((node, position) => {
    if (node.isTextblock) {
      result = position + 1;
      return false;
    }
    return result == null;
  });
  return result;
}

export function markIsActive(state: EditorState, mark: "strong" | "emphasis" | "code"): boolean {
  const type = vibeSchema.marks[mark];
  if (state.selection.empty) {
    return type.isInSet(state.storedMarks ?? state.selection.$from.marks()) != null;
  }
  return state.doc.rangeHasMark(state.selection.from, state.selection.to, type);
}

export function selectedTextKind(state: EditorState): "body" | "heading" {
  for (let depth = state.selection.$from.depth; depth >= 0; depth -= 1) {
    if (state.selection.$from.node(depth).type === vibeSchema.nodes.heading) return "heading";
  }
  return "body";
}

export function manuscriptEditorPlugins(): readonly Plugin[] {
  const placeholder = new Plugin({
    props: {
      decorations(state) {
        let decoration: Decoration | null = null;
        state.doc.descendants((node, position) => {
          if (node.type === vibeSchema.nodes.paragraph && node.content.size === 0) {
            decoration = Decoration.node(position, position + node.nodeSize, {
              class: "rho-vibe-manuscript-placeholder",
              "data-placeholder": PLACEHOLDER,
            });
            return false;
          }
          return decoration == null;
        });
        return decoration == null ? null : DecorationSet.create(state.doc, [decoration]);
      },
    },
  });
  return [
    history(),
    placeholder,
    keymap({
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
      "Mod-b": toggleMark(vibeSchema.marks.strong),
      "Mod-i": toggleMark(vibeSchema.marks.emphasis),
      "Mod-`": toggleMark(vibeSchema.marks.code),
    }),
    keymap(baseKeymap),
  ];
}

function atomPresentation(content: VibeBlockContent): {
  readonly kind: string;
  readonly label: string | null;
} {
  switch (content.kind) {
    case "callout": return { kind: "Note", label: content.text };
    case "divider": return { kind: "Divider", label: null };
    case "file_excerpt": return {
      kind: "File excerpt",
      label: `${content.resource.resource_id} · lines ${content.start_line}–${content.end_line}`,
    };
    case "artifact_ref": return { kind: "Artifact", label: content.label };
    case "finding_ref": return { kind: "Finding", label: content.label };
    case "task_ref": return { kind: "Task", label: content.label };
    case "surface_ref": return { kind: "Workspace view", label: "Linked workspace view" };
    case "command_ref": return { kind: "Command", label: content.label };
    case "rich_text": return { kind: "Text", label: null };
  }
}

export class CompactManuscriptAtomView implements NodeView {
  readonly dom: HTMLElement;
  #node: ProseMirrorNode;

  constructor(node: ProseMirrorNode) {
    this.#node = node;
    this.dom = document.createElement("div");
    this.dom.contentEditable = "false";
    this.refresh();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.refresh();
    return true;
  }

  selectNode(): void {
    this.dom.dataset.selected = "true";
  }

  deselectNode(): void {
    delete this.dom.dataset.selected;
  }

  stopEvent(): boolean {
    return false;
  }

  ignoreMutation(): boolean {
    return true;
  }

  private refresh(): void {
    const content = JSON.parse(this.#node.attrs.payload as string) as VibeBlockContent;
    const presentation = atomPresentation(content);
    const blockId = this.#node.attrs.block_id as string;
    this.dom.className = `rho-vibe-manuscript-atom rho-vibe-manuscript-atom-${content.kind}`;
    this.dom.dataset.blockId = blockId;
    this.dom.dataset.vibeKind = content.kind;
    this.dom.replaceChildren();
    if (content.kind === "divider") {
      this.dom.setAttribute("role", "separator");
      this.dom.setAttribute("aria-label", "Manuscript divider");
      return;
    }
    this.dom.removeAttribute("role");
    const kind = document.createElement("span");
    kind.className = "rho-vibe-manuscript-atom-kind";
    kind.textContent = presentation.kind;
    this.dom.append(kind);
    if (presentation.label != null) {
      const label = document.createElement("strong");
      label.textContent = presentation.label;
      this.dom.append(label);
      this.dom.setAttribute("aria-label", `${presentation.kind} reference: ${presentation.label}`);
    } else {
      this.dom.setAttribute("aria-label", presentation.kind);
    }
  }
}

export function compactAtomNodeViews(): Record<string, (node: ProseMirrorNode) => NodeView> {
  const entries = Object.values(vibeSchema.nodes)
    .filter((node: NodeType) => node.spec.atom === true && node.spec.group?.split(" ").includes("vibe_block"))
    .map((node) => [node.name, (value: ProseMirrorNode) => new CompactManuscriptAtomView(value)] as const);
  return Object.fromEntries(entries);
}

export function sectionsFromEditor(view: EditorView): readonly VibeSection[] {
  return documentToVibeSections(view.state.doc);
}

export { vibePageToDocument, vibeSchema };
