import { describe, expect, it } from "vitest";

import { createMockUiKernelTransport } from "../../transport/mock";
import { WorkbenchProjectionStore } from "../../transport/workbench-store";
import { presentAgentTurnInStudio } from "./agent-studio-presentation-controller";

async function fixture() {
  const transport = createMockUiKernelTransport();
  const store = new WorkbenchProjectionStore(transport);
  await store.refresh();
  const snapshot = store.getSnapshot();
  if (snapshot.status !== "ready") throw new Error("mock workbench did not load");
  const turns = await transport.listAgentTurns("agent-conversation:mock-shared");
  const turn = turns[0];
  if (turn == null) throw new Error("mock Agent turn did not load");
  let sequence = 0;
  return {
    transport,
    store,
    projectId: snapshot.snapshot.project_id,
    turn,
    allocateLayoutNodeId: () => `layout:agent-test:${++sequence}`,
  };
}

describe("Agent Studio presentation controller", () => {
  it("preserves the human Scene and composes a separate code-and-results Scene", async () => {
    const context = await fixture();
    await context.store.admitMutation(context.projectId, (lease) => (
      presentAgentTurnInStudio({
        ...context,
        lease,
        presentation: {
          title: "Analysis results",
          code_paths: ["analysis.R"],
          execution_id: null,
          plot_id: null,
          show_plots: true,
          show_environment: false,
        },
      })
    ));

    const profile = await context.transport.loadUiProfile();
    expect(profile.profile.studio_scenes).toHaveLength(2);
    const result = profile.profile.studio_scenes.find(
      (scene) => scene.scene_id === profile.profile.active_studio_scene_id,
    );
    expect(result?.label).toBe("Result · Analysis results");
    expect(JSON.stringify(result?.root)).toContain("surface-instance:");
    const source = profile.profile.studio_scenes.find((scene) => scene.scene_id !== result?.scene_id);
    expect(source?.label).toBe("Rho Studio");
  });

  it("removes a partial result Scene when no declared result can be admitted", async () => {
    const context = await fixture();
    await expect(context.store.admitMutation(context.projectId, (lease) => (
      presentAgentTurnInStudio({
        ...context,
        lease,
        presentation: {
          title: "Missing result",
          code_paths: ["missing.R"],
          execution_id: null,
          plot_id: null,
          show_plots: false,
          show_environment: false,
        },
      })
    ))).rejects.toThrow("no admitted Surface instances");

    const profile = await context.transport.loadUiProfile();
    expect(profile.profile.studio_scenes).toHaveLength(1);
    expect(profile.profile.studio_scenes[0]?.label).toBe("Rho Studio");
  });
});
