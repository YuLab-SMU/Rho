import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockEvidenceGraphTransport } from "../../transport/evidence-graph.mock";
import { createMockAuthorityTransport } from "../../transport/authority.mock";
import {
  agentEvidencePorts,
  createEvidenceGraphPorts,
} from "../workbench/evidenceGraphPorts";
import { AgentEvidencePanel } from "./AgentEvidencePanel";
import { AgentFinalAnswer } from "./AgentFinalAnswer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("Agent evidence composition", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps final answer, cited authority state, graph gaps, and draft creation separate", async () => {
    const graphTransport = createMockEvidenceGraphTransport();
    const graph = await graphTransport.traceArtifact("artifact:mock-plot");
    graphTransport.listAgentTurnEvidence = vi.fn(async () => graph);
    const createDraftClaim = vi.spyOn(graphTransport, "createDraftClaim");
    const ports = agentEvidencePorts(createEvidenceGraphPorts({
      ...createMockAuthorityTransport(),
      ...graphTransport,
    }));
    const reportError = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<>
        <AgentFinalAnswer answer="The fitted model is reproducible." />
        <AgentEvidencePanel
          turnId="agent-turn:1"
          finalAnswer="The fitted model is reproducible."
          ports={ports}
          reportError={reportError}
        />
      </>);
      await settle();
    });

    expect(container.textContent).toContain("Final Answer");
    expect(container.textContent).toContain("The fitted model is reproducible.");
    expect(container.textContent).toContain("Cited Evidence");
    expect(container.textContent).toContain("authority: succeeded");
    expect(container.textContent).toContain("graph: managed");
    expect(container.textContent).toContain("missing environment");

    const draft = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Draft conclusion");
    expect(draft).toBeDefined();
    await act(async () => {
      draft!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });

    expect(createDraftClaim).toHaveBeenCalledWith({
      label: "Agent conclusion agent-turn:1",
      summary: "The fitted model is reproducible.",
      claim_kind: "agent_conclusion",
      data_class: "project_internal",
    });
    expect(container.textContent).toContain("Drafted");
    expect(reportError).not.toHaveBeenCalled();
  });
});
