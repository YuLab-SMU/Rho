import { describe, expect, it } from "vitest";

import type { AgentTurnEvent } from "../../transport";
import {
  agentStudioPresentationKey,
  buildAgentStudioPresentationLayout,
  parseAgentStudioPresentation,
} from "./studio-presentation";

function event(body: unknown, details: unknown = {}): AgentTurnEvent {
  return {
    id: 17,
    turn_id: "agent-turn:qc",
    timestamp: "2026-08-28T00:00:00Z",
    event_type: "tool.call_completed",
    title: "Studio presentation prepared",
    body: body == null ? null : JSON.stringify(body),
    status: "completed",
    tool: "present_in_studio",
    request_id: null,
    code: null,
    details_json: JSON.stringify(details),
  };
}

describe("Agent Studio presentation", () => {
  it("accepts only bounded project-contained presentation references", () => {
    const parsed = parseAgentStudioPresentation(event({
      kind: "rho.studio_presentation",
      title: "QC results",
      code_paths: ["analysis/qc.R"],
      execution_id: "agent_workspace_1234",
      plot_id: "plot:qc",
      show_plots: false,
      show_environment: true,
    }));

    expect(parsed?.presentation).toEqual({
      title: "QC results",
      code_paths: ["analysis/qc.R"],
      execution_id: "agent_workspace_1234",
      plot_id: "plot:qc",
      show_plots: true,
      show_environment: true,
    });
    expect(agentStudioPresentationKey("agent-turn:qc", 17)).toBe("agent-turn:qc:17");
    expect(parseAgentStudioPresentation(event({
      kind: "rho.studio_presentation",
      title: "Escape",
      code_paths: ["../secret"],
      execution_id: null,
      plot_id: null,
      show_plots: false,
      show_environment: false,
    }))).toBeNull();
    expect(parseAgentStudioPresentation(event({
      kind: "rho.studio_presentation",
      title: "Empty",
      code_paths: [],
      execution_id: null,
      plot_id: null,
      show_plots: false,
      show_environment: false,
    }))).toBeNull();
  });

  it("recovers a proposal from persisted successful tool arguments", () => {
    const parsed = parseAgentStudioPresentation(event(null, {
      success: true,
      arguments: {
        title: "Model review",
        code_paths: ["R/model.R"],
        execution_id: "execution:model",
        show_plots: true,
        show_environment: false,
      },
    }));

    expect(parsed?.presentation.title).toBe("Model review");
    expect(parsed?.presentation.code_paths).toEqual(["R/model.R"]);
    expect(parsed?.presentation.plot_id).toBeNull();
  });

  it("builds a familiar code-and-results workbench without arbitrary layout input", () => {
    let sequence = 0;
    const layout = buildAgentStudioPresentationLayout({
      source: ["surface:source"],
      console: "surface:console",
      plots: "surface:plots",
      environment: "surface:environment",
    }, () => `layout:agent:${++sequence}`);

    expect(layout.kind).toBe("container");
    if (layout.kind !== "container") throw new Error("expected a root container");
    expect(layout.axis).toBe("horizontal");
    expect(layout.children).toHaveLength(2);
    expect(layout.children.map((child) => child.basis)).toEqual([
      { kind: "fraction", weight: 3 },
      { kind: "fraction", weight: 2 },
    ]);
    expect(JSON.stringify(layout)).toContain("surface:source");
    expect(JSON.stringify(layout)).toContain("surface:environment");
  });
});
