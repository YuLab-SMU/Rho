import { describe, expect, it } from "vitest";

import type { SurfaceInstance } from "../../../transport";
import {
  exactAgentSurfaceRequest,
  exactSurfaceInstance,
  exactSurfaceRequestForTarget,
} from "./vibe-studio-target";

function instance(overrides: Partial<SurfaceInstance> = {}): SurfaceInstance {
  return {
    instance_id: "instance:runs",
    surface_id: "rho.runs",
    project_id: "project:atlas",
    origin: { kind: "application", component_id: "rho.runs" },
    activation_generation: 1,
    surface_revision: 4,
    mode_id: "history",
    resource_binding: null,
    runtime_binding: null,
    view_group_id: null,
    view_state: { selected_id: "run:18", filter: "" },
    lifecycle_state: "active",
    ...overrides,
  };
}

describe("Vibe exact Studio target mapping", () => {
  it("maps Run, Artifact and Check identities without fuzzy filter state", () => {
    expect(exactSurfaceRequestForTarget({ kind: "run", id: "run:18" })).toMatchObject({
      surfaceId: "rho.runs",
      modeId: "history",
      viewState: { selected_id: "run:18", filter: "" },
      mayCreate: true,
    });
    expect(exactSurfaceRequestForTarget({ kind: "artifact", id: "artifact:7" })).toMatchObject({
      surfaceId: "rho.artifacts",
      modeId: "list",
      viewState: { selected_id: "artifact:7", filter: "" },
      mayCreate: true,
    });
    expect(exactSurfaceRequestForTarget({ kind: "check", id: "check:3" })).toMatchObject({
      surfaceId: "rho.check-result",
      viewState: { check_result_id: "check:3" },
      mayCreate: false,
    });
  });

  it("maps Agent view and compose intents to one exact conversation", () => {
    expect(exactAgentSurfaceRequest("conversation:4", false)).toMatchObject({
      surfaceId: "rho.agent",
      modeId: "conversation",
      viewState: {
        conversation_id: "conversation:4",
        mode: "ask",
        composer: "",
        auto_approve: false,
      },
    });
    expect(exactAgentSurfaceRequest("conversation:4", true).modeId).toBe("composer");
  });

  it("finds only an exact typed view-state identity", () => {
    const recent = instance({
      instance_id: "instance:recent",
      view_state: { selected_id: "run:recent", filter: "run:18" },
    });
    const exact = instance();
    const request = exactSurfaceRequestForTarget({ kind: "run", id: "run:18" });

    expect(exactSurfaceInstance([recent, exact], request)?.instance_id).toBe("instance:runs");
    expect(exactSurfaceInstance([recent], request)).toBeNull();
  });

  it("rejects empty exact identities", () => {
    expect(() => exactSurfaceRequestForTarget({ kind: "run", id: "   " })).toThrow(
      "identity is empty",
    );
  });
});
