import { describe, expect, it } from "vitest";

import type { SurfaceInstance, VibePage } from "../../../transport";
import { focusForPage, initialVibeWorkspaceViewState } from "./vibe-workspace-model";
import { verificationFocusForVibe } from "./vibe-verification-focus";

const page: VibePage = {
  project_id: "project:atlas",
  page_id: "page:contrast",
  page_revision: 3,
  label: "Cluster 3 与 7 的差异比较",
  focused_block_id: "block:artifact",
  sections: [{
    section_id: "section:result",
    heading: "结果",
    layout: { kind: "flow" },
    blocks: [{
      block_id: "block:artifact",
      content: { kind: "artifact_ref", artifact_id: "artifact:de", label: "差异表达表" },
    }, {
      block_id: "block:check",
      content: { kind: "surface_ref", instance_id: "instance:check", live: true },
    }, {
      block_id: "block:finding",
      content: { kind: "finding_ref", finding_id: "finding:seed", label: "随机性检查项" },
    }],
  }],
};

const check = {
  project_id: "project:atlas",
  instance_id: "instance:check",
  surface_id: "rho.check-result",
  origin: { kind: "application", component_id: "rho.check-result" },
  surface_revision: 1,
  activation_generation: 1,
  lifecycle_state: "active",
  mode_id: null,
  view_group_id: null,
  resource_binding: null,
  runtime_binding: null,
  view_state: { check_result_id: "check-result:7" },
} as SurfaceInstance;

function project(blockId: string) {
  const instances = new Map([[check.instance_id, check]]);
  const focus = focusForPage(page, {
    ...initialVibeWorkspaceViewState(page.project_id, page.page_id),
    blockId,
  }, instances);
  return verificationFocusForVibe({
    page,
    projectRoot: "/projects/atlas",
    projectRevision: 12,
    epoch: 4,
    focus,
    instances,
  });
}

describe("Vibe verification focus", () => {
  it("keeps the UI project identity separate from the normalized project root", () => {
    expect(project("block:artifact")).toMatchObject({
      projectId: "project:atlas",
      projectRoot: "/projects/atlas",
      projectRevision: 12,
    });
  });

  it("carries only the selected block's exact typed reference and human label", () => {
    expect(project("block:artifact")?.references).toEqual([{
      kind: "artifact",
      id: "artifact:de",
      label: "差异表达表",
      origin: { kind: "page-block", pageId: "page:contrast", blockId: "block:artifact" },
    }]);
    expect(project("block:check")?.references).toEqual([{
      kind: "check",
      id: "check-result:7",
      label: "项目检查结果",
      origin: { kind: "surface", instanceId: "instance:check" },
    }]);
  });

  it("preserves a Finding identity as unresolved instead of guessing a Check result", () => {
    expect(project("block:finding")?.references).toEqual([{
      kind: "finding",
      id: "finding:seed",
      label: "随机性检查项",
      origin: { kind: "page-block", pageId: "page:contrast", blockId: "block:finding" },
    }]);
  });

  it("returns no verification focus when the selected block no longer exists", () => {
    expect(project("block:missing")).toBeNull();
  });
});
