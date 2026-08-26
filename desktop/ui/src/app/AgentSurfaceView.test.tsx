import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentTurnDetail,
  AgentTurnSummary,
  SurfaceInstance,
} from "../transport";
import { createMockUiKernelTransport } from "../transport/mock";
import { AgentSurfaceView } from "./AgentSurfaceView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mockNow = "2026-08-22T12:00:00Z";

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function makeTurn(overrides: Partial<AgentTurnSummary> & { readonly turn_id: string }): AgentTurnSummary {
  return {
    conversation_id: "agent-conversation:mock-shared",
    project_root: "/mock/project",
    mode: "ask",
    status: "completed",
    started_at: mockNow,
    finished_at: mockNow,
    prompt_preview: "What should we inspect first?",
    model: "mock/provider-model",
    workspace_id_before: "workspace:mock",
    state_revision_before: 4,
    project_revision_before: 1,
    workspace_id_after: "workspace:mock",
    state_revision_after: 4,
    project_revision_after: 1,
    final_message: null,
    error_message: null,
    pending_request_id: null,
    retry_of_turn_id: null,
    terminal_reason: "completed",
    ...overrides,
  };
}

function makeDetail(
  turn: AgentTurnSummary,
  overrides: Partial<Omit<AgentTurnDetail, "turn">> = {},
): AgentTurnDetail {
  return { turn, events: [], approvals: [], context_items: [], ...overrides };
}

describe("Studio Agent Surface", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function renderAgent(options: {
    readonly transport?: ReturnType<typeof createMockUiKernelTransport>;
    readonly health?: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
  } = {}) {
    const transport = options.transport ?? createMockUiKernelTransport();
    const surfaces = await transport.loadSurfaces();
    const instance: SurfaceInstance = {
      instance_id: "surface-instance:agent-test",
      surface_id: "rho.agent",
      project_id: surfaces.project_id,
      origin: { kind: "application", component_id: "rho.agent" },
      activation_generation: 1,
      surface_revision: 1,
      mode_id: "conversation",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: {
        conversation_id: "agent-conversation:mock-shared",
        mode: "ask",
        composer: "",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const persist = vi.fn(async () => undefined);
    const pinTask = vi.fn(async () => undefined);
    const applyFileProposal = vi.fn(async () => {
      throw new Error("applyFileProposal is not expected in this test");
    });
    const undoFileProposal = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const setRuntimeOutputContext = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<AgentSurfaceView
        instance={instance}
        transport={transport}
        health={options.health === undefined
          ? { state: "ready", label: "Agent runtime ready", detail: null }
          : options.health}
        persist={persist}
        pinTask={pinTask}
        applyFileProposal={applyFileProposal}
        undoFileProposal={undoFileProposal}
        reportError={reportError}
        runtimeOutputContext={null}
        setRuntimeOutputContext={setRuntimeOutputContext}
      />);
      await settle();
    });
    return { container, instance, applyFileProposal, persist, pinTask, reportError, root, setRuntimeOutputContext, transport };
  }

  async function click(element: Element) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
  }

  async function typeInput(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
    await act(async () => {
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
  }

  it("renders goal before answer with technical evidence collapsed after decisions", async () => {
    const transport = createMockUiKernelTransport();
    const base = (await transport.getAgentTurnDetail("agent-turn:mock-1"))!;
    transport.getAgentTurnDetail = async () => makeDetail(base.turn, {
      events: [...base.events, {
        id: 10,
        turn_id: base.turn.turn_id,
        timestamp: mockNow,
        event_type: "tool.call_completed",
        title: "Run summary statistics",
        body: null,
        status: "completed",
        tool: "execute_r_code",
        request_id: null,
        code: "summary(dataset)",
        details_json: "{}",
      }],
      approvals: base.approvals,
      context_items: [{
        ordinal: 1,
        source_kind: "runtime_output",
        source_id: "execution:1-3",
        source_revision: "sequence:3",
        source_sha256: "b".repeat(64),
        trust_class: "explicit_project_data",
        capacity_source: "conservative",
        original_bytes: 2048,
        included_bytes: 1024,
        estimated_tokens: 512,
        disposition: "truncated",
        reason_code: "budget",
      }],
    });
    const { container } = await renderAgent({ transport });

    const goal = container.querySelector(".rho-agent-goal .rho-agent-prompt")!;
    expect(goal.textContent).toContain("What should we inspect first?");
    const answer = container.querySelector(".rho-agent-answer")!;
    expect(answer.textContent).toContain("Start with the project structure");
    expect(goal.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const proposal = container.querySelector(".rho-agent-file-proposal")!;
    expect(proposal.querySelector(".rho-agent-decision-kind")!.textContent).toBe("File change");
    const technical = container.querySelector(".rho-agent-technical")!;
    expect(proposal.compareDocumentPosition(technical) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const codeReview = technical.querySelector<HTMLDetailsElement>(".rho-agent-code-review")!;
    expect(codeReview.open).toBe(false);
    const contextUsed = technical.querySelector<HTMLDetailsElement>(".rho-agent-context-used")!;
    expect(contextUsed.open).toBe(false);
  });

  it("shows a truthful empty state for a conversation without turns", async () => {
    const transport = createMockUiKernelTransport();
    transport.listAgentTurns = async () => [];
    const { container } = await renderAgent({ transport });
    const empty = container.querySelector(".rho-agent-empty")!;
    expect(empty.textContent).toContain("Ready for the first turn");
    expect(empty.textContent).toContain("composer");
    expect(container.querySelector(".rho-agent-composer textarea")).not.toBeNull();
  });

  it("switches Ask/Plan/Act, persists mode, and resets auto-approve outside Act", async () => {
    const { container, persist } = await renderAgent();
    const modeButton = (label: string) => [...container.querySelectorAll(".rho-agent-mode button")]
      .find((button) => button.textContent === label)!;

    await click(modeButton("act"));
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "act", auto_approve: false }));
    expect(modeButton("act").getAttribute("aria-pressed")).toBe("true");

    const autoApprove = container.querySelector<HTMLInputElement>(".rho-agent-auto-approve input")!;
    await click(autoApprove);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "act", auto_approve: true }));

    await click(modeButton("ask"));
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "ask", auto_approve: false }));
    expect(container.querySelector(".rho-agent-auto-approve")).toBeNull();
  });

  it("keeps context capacity behind its disclosure and rejects fractional token counts", async () => {
    const transport = createMockUiKernelTransport();
    const { container, reportError } = await renderAgent({ transport });
    expect(container.querySelector(".rho-agent-capacity")).toBeNull();

    const toggle = [...container.querySelectorAll(".rho-agent-toolbar button")]
      .find((button) => button.textContent === "Context")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const form = container.querySelector<HTMLFormElement>(".rho-agent-capacity")!;
    const contextInput = form.querySelector<HTMLInputElement>("input[aria-label='Context window tokens']")!;
    expect(contextInput.value).toBe("32768");

    await typeInput(contextInput, "32768.5");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Context capacity must use whole token counts.",
    }));
  });

  it("saves context capacity through the existing revision-checked path", async () => {
    const transport = createMockUiKernelTransport();
    const setCapacity = vi.fn(transport.setAgentContextCapacity.bind(transport));
    transport.setAgentContextCapacity = setCapacity;
    const { container } = await renderAgent({ transport });

    const toggle = [...container.querySelectorAll(".rho-agent-toolbar button")]
      .find((button) => button.textContent === "Context")!;
    await click(toggle);
    const form = container.querySelector<HTMLFormElement>(".rho-agent-capacity")!;
    const contextInput = form.querySelector<HTMLInputElement>("input[aria-label='Context window tokens']")!;
    const reserveInput = form.querySelector<HTMLInputElement>("input[aria-label='Reserved output tokens']")!;
    await typeInput(contextInput, "65536");
    await typeInput(reserveInput, "8192");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    expect(setCapacity).toHaveBeenCalledWith({
      model_id: "mock-profile",
      expected_revision: 1,
      context_window_tokens: 65_536,
      reserved_output_tokens: 8_192,
    });
  });

  it("keeps Stop beside the composer for a running turn and cancels through the existing path", async () => {
    const transport = createMockUiKernelTransport();
    const runningTurn = makeTurn({
      turn_id: "agent-turn:mock-running",
      status: "running",
      finished_at: null,
      terminal_reason: null,
      prompt_preview: "Inspect the runtime logs",
    });
    transport.listAgentTurns = async () => [runningTurn];
    transport.getAgentTurnDetail = async () => makeDetail(runningTurn);
    const cancelAgentTurn = vi.fn(transport.cancelAgentTurn.bind(transport));
    transport.cancelAgentTurn = cancelAgentTurn;
    const { container } = await renderAgent({ transport });

    const statusRow = container.querySelector(".rho-agent-composer .rho-agent-running")!;
    expect(statusRow.textContent).toContain("Agent running");
    const stop = [...statusRow.querySelectorAll("button")].find((button) => button.textContent === "Stop")!;
    await click(stop);
    expect(cancelAgentTurn).toHaveBeenCalledWith("agent-turn:mock-running");
  });

  it("names the wait next to a distinct approval decision and responds through the existing path", async () => {
    const transport = createMockUiKernelTransport();
    const waitingTurn = makeTurn({
      turn_id: "agent-turn:mock-waiting",
      status: "waiting",
      finished_at: null,
      terminal_reason: null,
      prompt_preview: "Install the reviewed dependency",
    });
    transport.listAgentTurns = async () => [waitingTurn];
    transport.getAgentTurnDetail = async () => makeDetail(waitingTurn, {
      approvals: [{
        request_id: "approval-request:mock-1",
        turn_id: waitingTurn.turn_id,
        project_root: "/mock/project",
        tool: "execute_r_code",
        policy: "approval_required",
        status: "waiting",
        decision: null,
        reason: null,
        arguments_json: JSON.stringify({ code: "install.packages('demo')" }),
        code: "install.packages('demo')",
        workspace_id: "workspace:mock",
        state_revision: 4,
        project_revision: 1,
        requested_at: mockNow,
        responded_at: null,
        continuation_outcome: null,
      }],
    });
    const respondAgentApproval = vi.fn(async () => ({
      status: "delivered" as const,
      request_id: "approval-request:mock-1",
      turn_id: waitingTurn.turn_id,
    }));
    transport.respondAgentApproval = respondAgentApproval;
    const { container } = await renderAgent({ transport });

    expect(container.querySelector(".rho-agent-composer .rho-agent-running")!.textContent)
      .toContain("Waiting for a decision or response");
    const approval = container.querySelector(".rho-agent-approval")!;
    expect(approval.querySelector(".rho-agent-decision-kind")!.textContent).toBe("Approval required");
    expect(approval.querySelector("pre")!.textContent).toContain("install.packages('demo')");
    expect(container.querySelector(".rho-agent-file-proposal")).toBeNull();

    const approve = [...approval.querySelectorAll("button")].find((button) => button.textContent === "Approve")!;
    await click(approve);
    expect(respondAgentApproval).toHaveBeenCalledWith({
      request_id: "approval-request:mock-1",
      decision: "approve",
      reason: null,
    });
  });

  it("renders failed and cancelled turns with distinct truthful copy", async () => {
    const transport = createMockUiKernelTransport();
    const failedTurn = makeTurn({
      turn_id: "agent-turn:mock-failed",
      status: "failed",
      terminal_reason: "provider_error",
      prompt_preview: "Run the full check",
      error_message: "Provider rejected the request.",
    });
    const cancelledTurn = makeTurn({
      turn_id: "agent-turn:mock-cancelled",
      status: "cancelled",
      terminal_reason: "user_cancelled",
      prompt_preview: "Summarize the workspace",
    });
    transport.listAgentTurns = async () => [failedTurn, cancelledTurn];
    transport.getAgentTurnDetail = async (turnId) =>
      makeDetail(turnId === failedTurn.turn_id ? failedTurn : cancelledTurn);
    const { container } = await renderAgent({ transport });

    const failed = container.querySelector('[data-turn-id="agent-turn:mock-failed"]')!;
    const failure = failed.querySelector(".rho-agent-turn-failure")!;
    expect(failure.textContent).toContain("Turn failed");
    expect(failure.textContent).toContain("Provider rejected the request.");
    expect(failed.querySelector(".rho-agent-turn-status")!.textContent).toBe("Failed");

    const cancelled = container.querySelector('[data-turn-id="agent-turn:mock-cancelled"]')!;
    expect(cancelled.querySelector(".rho-agent-turn-cancelled")!.textContent)
      .toContain("cancelled before completion");
    expect(cancelled.querySelector(".rho-agent-turn-failure")).toBeNull();

    for (const turn of [failed, cancelled]) {
      expect([...turn.querySelectorAll("footer button")].some((button) => button.textContent === "Retry")).toBe(true);
    }
  });

  it("persists a rejected file proposal without touching the apply path", async () => {
    const { container, persist, applyFileProposal } = await renderAgent();
    const proposal = container.querySelector(".rho-agent-file-proposal")!;
    const reject = [...proposal.querySelectorAll("button")].find((button) => button.textContent === "Reject")!;
    await click(reject);

    expect(applyFileProposal).not.toHaveBeenCalled();
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
      file_decisions: { "agent-turn:mock-1:3": "rejected" },
    }));
    expect(proposal.textContent).toContain("rejected in this view");
    expect([...proposal.querySelectorAll("button")].some((button) => button.textContent === "Apply")).toBe(false);
  });

  it("submits through the composer with unchanged runAgent arguments and clears the draft", async () => {
    const transport = createMockUiKernelTransport();
    const runAgent = vi.fn(transport.runAgent.bind(transport));
    transport.runAgent = runAgent;
    const { container, setRuntimeOutputContext } = await renderAgent({ transport });

    const textarea = container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    await typeInput(textarea, "What changed since yesterday?");
    const send = container.querySelector<HTMLButtonElement>(".rho-agent-context-controls .rho-primary-action")!;
    await click(send);

    expect(runAgent).toHaveBeenCalledWith({
      prompt: "What changed since yesterday?",
      mode: "ask",
      task_kind: "agent_turn",
      model_id: null,
      auto_approve: false,
      editor_context: null,
      conversation_id: "agent-conversation:mock-shared",
      runtime_output_context: null,
      context_plan_digest: null,
    });
    expect(setRuntimeOutputContext).toHaveBeenCalledWith(null);
    expect(container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!.value).toBe("");
    expect(container.querySelector(".rho-agent-timeline")!.textContent)
      .toContain("Mock ask response for: What changed since yesterday?");
  });

  it("shows the degraded banner with dependency diagnostics when the runtime is not ready", async () => {
    const { container } = await renderAgent({
      health: { state: "needs_attention", label: "Agent dependencies need attention", detail: "aisdk is incompatible." },
    });
    const banner = container.querySelector(".rho-agent-degraded")!;
    expect(banner.textContent).toContain("Agent dependencies need attention");
    expect(banner.textContent).toContain("aisdk is incompatible.");
    expect([...banner.querySelectorAll("button")].some((button) => button.textContent === "Retry Agent runtime")).toBe(true);
    const diagnostics = banner.querySelector<HTMLDetailsElement>(".rho-agent-runtime-diagnostics")!;
    expect(diagnostics.querySelector("summary")!.textContent).toBe("Dependency details");
    expect(diagnostics.querySelector("pre")!.textContent).toContain("aisdk");
    const send = container.querySelector<HTMLButtonElement>(".rho-agent-context-controls .rho-primary-action")!;
    expect(send.disabled).toBe(true);
  });
});
