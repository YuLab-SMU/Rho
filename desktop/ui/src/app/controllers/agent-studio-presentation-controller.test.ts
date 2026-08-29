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

async function createExecution(context: Awaited<ReturnType<typeof fixture>>) {
  const runtimes = context.store.getRuntimeSnapshot();
  const surfaces = context.store.getSurfaceSnapshot();
  if (runtimes.status !== "ready" || surfaces.status !== "ready") {
    throw new Error("mock Runtime or Surface state did not load");
  }
  const runtime = runtimes.snapshot.instances.find((candidate) => candidate.primary_scientific_runtime);
  const console = surfaces.snapshot.catalog.instances.find((candidate) => candidate.surface_id === "rho.console");
  if (runtime == null || console == null) throw new Error("mock execution target is unavailable");
  return context.store.admitMutation(context.projectId, (lease) => context.store.startExecution({
    runtime: {
      project_id: context.projectId,
      runtime_provider_id: runtime.runtime_provider_id,
      runtime_instance_id: runtime.runtime_instance_id,
      activation_generation: runtime.activation_generation,
      expected_project_revision: runtimes.snapshot.project_revision,
      expected_state_revision: runtime.state_revision,
    },
    console_instance_id: console.instance_id,
    expected_console_revision: console.surface_revision,
    code: "summary(iris)",
    source_context: null,
  }, lease));
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

  it("opens an attached Console pinned to the exact Agent execution", async () => {
    const context = await fixture();
    const started = await createExecution(context);
    await context.store.admitMutation(context.projectId, (lease) => (
      presentAgentTurnInStudio({
        ...context,
        lease,
        presentation: {
          title: "Executed analysis",
          code_paths: ["analysis.R"],
          execution_id: started.execution.execution_id,
          plot_id: null,
          show_plots: false,
          show_environment: false,
        },
      })
    ));

    const surfaces = await context.transport.loadSurfaces();
    const resultConsole = surfaces.catalog.instances.find((instance) =>
      instance.surface_id === "rho.console"
      && typeof instance.view_state === "object"
      && instance.view_state != null
      && "pinned_execution_id" in instance.view_state
      && instance.view_state.pinned_execution_id === started.execution.execution_id);
    expect(resultConsole).toBeDefined();
    expect(resultConsole?.runtime_binding?.runtime_instance_id)
      .toBe(started.execution.runtime_instance_id);
    const profile = await context.transport.loadUiProfile();
    const resultScene = profile.profile.studio_scenes.find(
      (scene) => scene.scene_id === profile.profile.active_studio_scene_id,
    );
    expect(JSON.stringify(resultScene?.root)).toContain(resultConsole?.instance_id);
    expect(JSON.stringify(resultScene?.root)).not.toContain("rho.runs");
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
