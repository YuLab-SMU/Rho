import { describe, expect, it } from "vitest";

import type { SurfaceInstance, VibePage } from "../../../transport";
import {
  correspondenceForFocus,
  exactReferencesForBlock,
  focusForPage,
  initialVibeWorkspaceViewState,
  reduceVibeWorkspaceView,
} from "./vibe-workspace-model";

function page(): VibePage {
  return {
    project_id: "project:alpha",
    page_id: "page:analysis",
    page_revision: 4,
    label: "Cluster 3 与 7 的差异比较",
    focused_block_id: null,
    sections: [{
      section_id: "section:method",
      heading: "分析方法",
      layout: { kind: "flow" },
      blocks: [{
        block_id: "block:method",
        content: {
          kind: "rich_text",
          document: { blocks: [{ kind: "paragraph", content: [{ text: "以 donor 为统计单位进行比较。", marks: [] }] }] },
        },
      }, {
        block_id: "block:agent",
        content: { kind: "surface_ref", instance_id: "instance:agent", live: true },
      }, {
        block_id: "block:artifact",
        content: { kind: "artifact_ref", artifact_id: "artifact:de", label: "差异表达表" },
      }],
    }],
  };
}

function instances(): ReadonlyMap<string, SurfaceInstance> {
  return new Map([["instance:agent", {
    project_id: "project:alpha",
    instance_id: "instance:agent",
    surface_id: "rho.agent",
    origin: { kind: "application", component_id: "rho.agent" },
    surface_revision: 2,
    activation_generation: 1,
    lifecycle_state: "active",
    mode_id: "conversation",
    view_group_id: null,
    resource_binding: null,
    runtime_binding: null,
    view_state: { conversation_id: "conversation:exact", mode: "ask", composer: "", auto_approve: false },
  } as SurfaceInstance]]);
}

describe("Vibe workspace view model", () => {
  it("uses overview first and resets local focus across project or Page changes", () => {
    let state = initialVibeWorkspaceViewState("project:alpha", "page:analysis");
    state = reduceVibeWorkspaceView(state, { kind: "activate_region", region: "verification" });
    state = reduceVibeWorkspaceView(state, { kind: "select_block", blockId: "block:artifact" });
    expect(state).toMatchObject({ activeRegion: "verification", layoutMode: "focus-verification", blockId: "block:artifact" });
    expect(reduceVibeWorkspaceView(state, {
      kind: "replace_page",
      projectId: "project:beta",
      pageId: "page:other",
    })).toEqual(initialVibeWorkspaceViewState("project:beta", "page:other"));
  });

  it("derives only typed references from the selected block", () => {
    expect(exactReferencesForBlock(page(), "block:method", instances())).toMatchObject({
      conversationIds: [], artifactIds: [], findingIds: [], taskIds: [],
    });
    expect(exactReferencesForBlock(page(), "block:agent", instances())).toMatchObject({
      surfaceInstanceIds: ["instance:agent"],
      conversationIds: ["conversation:exact"],
    });
    expect(exactReferencesForBlock(page(), "block:artifact", instances()).artifactIds).toEqual(["artifact:de"]);
    expect(exactReferencesForBlock(page(), "block:missing", instances())).toMatchObject({
      surfaceInstanceIds: [], conversationIds: [], artifactIds: [],
    });
  });

  it("does not infer a conversation from a non-Agent Surface", () => {
    const values = new Map(instances());
    values.set("instance:agent", { ...values.get("instance:agent")!, surface_id: "rho.check" });
    expect(exactReferencesForBlock(page(), "block:agent", values)).toMatchObject({
      surfaceInstanceIds: ["instance:agent"], conversationIds: [],
    });
  });

  it("explains exact correspondence and honest absence without visible IDs", () => {
    const state = { ...initialVibeWorkspaceViewState("project:alpha", "page:analysis"), blockId: "block:agent" };
    const linked = correspondenceForFocus(focusForPage(page(), state, instances()));
    expect(linked.hasExactLink).toBe(true);
    expect(linked.summary).toContain("Agent 引用");
    expect(linked.summary).not.toContain("conversation:exact");

    const unlinked = correspondenceForFocus(focusForPage(page(), { ...state, blockId: "block:method" }, instances()));
    expect(unlinked.hasExactLink).toBe(false);
    expect(unlinked.summary).toContain("尚未建立精确");
  });

  it("drops a selected block that does not exist in the current Page", () => {
    const focus = focusForPage(page(), {
      ...initialVibeWorkspaceViewState("project:alpha", "page:analysis"),
      blockId: "block:missing",
    }, instances());
    expect(focus.blockId).toBeNull();
    expect(focus.exactRefs).toMatchObject({ conversationIds: [], artifactIds: [] });
  });
});
