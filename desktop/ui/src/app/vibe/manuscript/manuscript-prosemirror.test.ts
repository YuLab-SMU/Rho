import { afterEach, describe, expect, it } from "vitest";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import fixture from "../../../contracts/generated/rsr-contract-fixtures.json";
import type { ProjectUiProfileSnapshot, VibePage } from "../../../transport";
import { documentToVibeSections } from "../../VibePageEditor";
import {
  blockIdForSelection,
  compactAtomNodeViews,
  createStarterSections,
  findBlockPosition,
  firstTextPosition,
  manuscriptEditorPlugins,
  vibePageToDocument,
  vibeSchema,
} from "./manuscript-prosemirror";

const profile = fixture.project_ui_profile_snapshot as unknown as ProjectUiProfileSnapshot;

function page(): VibePage {
  return structuredClone(profile.profile.vibe_pages[0]!);
}

describe("working-manuscript ProseMirror", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    document.body.replaceChildren();
  });

  it("round-trips the complete Page instead of filtering non-text blocks", () => {
    const current = page();
    expect(documentToVibeSections(vibePageToDocument(current))).toEqual(current.sections);
  });

  it("renders references as compact atoms without remounting a Surface or showing its internal ID", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView(host, {
      state: EditorState.create({ doc: vibePageToDocument(page()) }),
      nodeViews: compactAtomNodeViews(),
    });
    views.push(view);

    const surface = host.querySelector<HTMLElement>(".rho-vibe-manuscript-atom-surface_ref");
    expect(surface?.textContent).toContain("Linked workspace view");
    expect(surface?.textContent).not.toContain("instance:check");
    expect(surface?.querySelector(".rho-surface")).toBeNull();
  });

  it("reports only the exact containing block for text and atom selections", () => {
    const current = page();
    let state = EditorState.create({ doc: vibePageToDocument(current) });
    const textPosition = firstTextPosition(state.doc)!;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, textPosition)));
    expect(blockIdForSelection(state)).toBe("block:narrative");

    const atom = findBlockPosition(state.doc, "block:check")!;
    state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, atom.position)));
    expect(blockIdForSelection(state)).toBe("block:check");
  });

  it("supports formatting shortcuts, history and a real empty-page starter block", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const starter: VibePage = { ...page(), sections: createStarterSections() };
    const manuscriptDocument = vibePageToDocument(starter);
    const position = firstTextPosition(manuscriptDocument)!;
    const populated = manuscriptDocument.type.create(
      manuscriptDocument.attrs,
      manuscriptDocument.content,
    );
    const view = new EditorView(host, {
      state: EditorState.create({ doc: populated, plugins: [...manuscriptEditorPlugins()] }),
    });
    views.push(view);
    view.dispatch(view.state.tr.insertText("Method", position));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position, position + 6)));

    view.dom.dispatchEvent(new KeyboardEvent("keydown", {
      key: "b",
      ctrlKey: true,
      bubbles: true,
    }));
    expect(view.state.doc.rangeHasMark(position, position + 6, vibeSchema.marks.strong)).toBe(true);

    view.dom.dispatchEvent(new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
    }));
    expect(view.state.doc.rangeHasMark(position, position + 6, vibeSchema.marks.strong)).toBe(false);
    expect(documentToVibeSections(view.state.doc)[0]?.blocks).toHaveLength(1);
  });
});
