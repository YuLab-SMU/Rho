import { describe, expect, it } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { createMockUiKernelTransport } from "./mock";
import {
  createTauriProfileTransport,
  type ProfileTransport,
  type ProjectUiProfileSnapshot,
  type UiProfileRevisionRequest,
  type VibePageExport,
} from "./profile";

const snapshot = fixture.project_ui_profile_snapshot as unknown as ProjectUiProfileSnapshot;
const page = snapshot.profile.vibe_pages[0]!;
const scene = snapshot.profile.studio_scenes[0]!;
const target = {
  project_id: snapshot.profile.project_id,
  expected_profile_revision: snapshot.profile.revision,
} satisfies UiProfileRevisionRequest;
const exported = {
  contract: "rho.ui.vibe-page.export.v1",
  project_id: snapshot.profile.project_id,
  page_id: page.page_id,
  page_revision: page.page_revision,
  label: page.label,
  markdown: `# ${page.label}\n`,
} satisfies VibePageExport;

describe("Profile and Vibe generated transport", () => {
  it("owns all eleven command identities and preserves exact request nesting", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      return (command === "ui_profile_page_export" ? exported : snapshot) as T;
    };
    const transport = createTauriProfileTransport(invoke);
    const setMode = { target, mode: "vibe" } as const;
    const selectScene = { target, scene_id: scene.scene_id } as const;
    const selectPage = { target, page_id: page.page_id } as const;
    const applyPage = {
      target,
      page_id: page.page_id,
      expected_page_revision: page.page_revision,
      mutation: { kind: "set_focus", block_id: null },
    } as const;
    const exportPage = {
      project_id: target.project_id,
      expected_profile_revision: target.expected_profile_revision,
      page_id: page.page_id,
      expected_page_revision: page.page_revision,
    } as const;
    const sceneLabel = { target, scene_id: scene.scene_id, label: "Exploration" } as const;
    const sceneTarget = { target, scene_id: scene.scene_id } as const;

    await transport.loadUiProfile();
    await transport.setUiProfileMode(setMode);
    await transport.selectUiProfileScene(selectScene);
    await transport.selectUiProfilePage(selectPage);
    await transport.applyVibePage(applyPage);
    await transport.exportVibePage(exportPage);
    await transport.duplicateUiProfileScene(sceneLabel);
    await transport.saveUiProfileScene(sceneTarget);
    await transport.renameUiProfileScene(sceneLabel);
    await transport.deleteUiProfileScene(sceneTarget);
    await transport.resetUiProfileScene(sceneTarget);

    expect(calls).toEqual([
      { command: "ui_profile_snapshot" },
      { command: "ui_profile_set_mode", args: { request: setMode } },
      { command: "ui_profile_select_scene", args: { request: selectScene } },
      { command: "ui_profile_select_page", args: { request: selectPage } },
      { command: "ui_profile_page_apply", args: { request: applyPage } },
      { command: "ui_profile_page_export", args: { request: exportPage } },
      { command: "ui_profile_scene_duplicate", args: { request: sceneLabel } },
      { command: "ui_profile_scene_save", args: { request: sceneTarget } },
      { command: "ui_profile_scene_rename", args: { request: sceneLabel } },
      { command: "ui_profile_scene_delete", args: { request: sceneTarget } },
      { command: "ui_profile_scene_reset", args: { request: sceneTarget } },
    ]);
  });

  it("preserves rejection semantics and rejects unknown response contracts", async () => {
    const rejected = createTauriProfileTransport(async () => {
      throw new Error("UI Profile revision is stale");
    });
    await expect(rejected.setUiProfileMode({ target, mode: "studio" }))
      .rejects.toThrow("revision is stale");

    const incompatible = createTauriProfileTransport(async <T,>() => ({
      ...snapshot,
      contract_major: 2,
    }) as T);
    await expect(incompatible.loadUiProfile()).rejects.toThrow("unsupported contract version");
  });

  it("keeps browser/mock mode assignable to the narrow Profile facet", async () => {
    const transport: ProfileTransport = createMockUiKernelTransport();
    await expect(transport.loadUiProfile()).resolves.toMatchObject({
      contract: "rho.ui.project-profile.snapshot.v1",
    });
  });
});
