import { describe, expect, it } from "vitest";
import { history, undo } from "prosemirror-history";
import { EditorState } from "prosemirror-state";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { documentToVibeSections, vibePageToDocument, vibeSchema } from "../app/VibePageEditor";
import type { ProjectUiProfileSnapshot, VibePage } from "./types";
import { applyVibePageMutation, exportVibePage, validateVibePage } from "./vibe-model";

const profile = fixture.project_ui_profile_snapshot as unknown as ProjectUiProfileSnapshot;

function page(): VibePage {
  return structuredClone(profile.profile.vibe_pages[0]!);
}

describe("Vibe Page document model", () => {
  it("round-trips ordered rich text, references, Grid identity, and live Surface atoms", () => {
    const current = page();
    const sections = documentToVibeSections(vibePageToDocument(current));
    expect(sections).toEqual(current.sections);
    expect(sections[0]?.layout.kind).toBe("grid");
    expect(sections[0]?.blocks.map((block) => block.block_id)).toEqual([
      "block:narrative",
      "block:check",
    ]);
  });

  it("rejects stale and overlapping candidates without changing the source", () => {
    const current = page();
    const before = structuredClone(current);
    expect(() => applyVibePageMutation(current, current.page_revision - 1, {
      kind: "set_focus",
      block_id: null,
    })).toThrow("stale");
    const section = current.sections[0]!;
    expect(section.layout.kind).toBe("grid");
    const placements = section.layout.kind === "grid" ? section.layout.placements : [];
    expect(() => applyVibePageMutation(current, current.page_revision, {
      kind: "replace_sections",
      focused_block_id: current.focused_block_id,
      sections: [{
        ...section,
        layout: {
          kind: "grid",
          placements: placements.map((placement, index) => index === 1
            ? { ...placement, column_start: 2 }
            : placement),
        },
      }],
    })).toThrow("overlap");
    expect(current).toEqual(before);
  });

  it("preserves ProseMirror history while durable conversion stays contract-shaped", () => {
    const current = page();
    let state = EditorState.create({ doc: vibePageToDocument(current), plugins: [history()] });
    const richPosition = (() => {
      let found = 0;
      state.doc.descendants((node, position) => {
        if (found === 0 && node.type === vibeSchema.nodes.paragraph) found = position + 1;
      });
      return found;
    })();
    state = state.apply(state.tr.insertText("Evidence: ", richPosition));
    expect(JSON.stringify(documentToVibeSections(state.doc))).toContain("Evidence: ");
    expect(undo(state, (transaction) => { state = state.apply(transaction); })).toBe(true);
    expect(documentToVibeSections(state.doc)).toEqual(current.sections);
  });

  it("exports deterministic placeholders and rejects duplicate live mounts", () => {
    const current = page();
    expect(exportVibePage(current)).toEqual(exportVibePage(current));
    expect(exportVibePage(current).markdown).toContain("[Surface: instance:check · live=true]");
    const section = current.sections[0]!;
    const surface = section.blocks.find((block) => block.content.kind === "surface_ref")!;
    const duplicate = {
      ...current,
      sections: [...current.sections, {
        section_id: "section:duplicate",
        heading: null,
        layout: { kind: "flow" as const },
        blocks: [{ ...surface, block_id: "block:duplicate" }],
      }],
    };
    expect(() => validateVibePage(duplicate)).toThrow("cannot mount twice");
  });
});
