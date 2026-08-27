import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentFileMutationResponse,
  AgentTurnDetail,
  AgentTurnSummary,
  SurfaceInstance,
} from "../transport";
import { createMockUiKernelTransport } from "../transport/mock";
import { AgentSurfaceView } from "./AgentSurfaceView";

type ApplyFileProposalFn = ComponentProps<typeof AgentSurfaceView>["applyFileProposal"];

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
    readonly applyFileProposal?: ApplyFileProposalFn;
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
    const applyFileProposal = vi.fn(options.applyFileProposal ?? (async () => {
      throw new Error("applyFileProposal is not expected in this test");
    }));
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
      }, {
        id: 11,
        turn_id: base.turn.turn_id,
        timestamp: mockNow,
        event_type: "tool.call_completed",
        title: "Read project metadata",
        body: null,
        status: "completed",
        tool: "read_project_metadata",
        request_id: null,
        code: null,
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

    // File changes appear as one in-flow entry; the timeline itself carries
    // no diff content and no per-file decision buttons.
    const entry = container.querySelector(".rho-agent-timeline .rho-agent-files-entry")!;
    expect(entry.textContent).toContain("1 file changed");
    expect(entry.textContent).toContain("analysis.R");
    expect(container.querySelector(".rho-agent-timeline .rho-agent-file-proposal")).toBeNull();

    const activity = container.querySelector(".rho-agent-activity")!;
    expect(entry.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Title-level activity narration is visible as one-line rows.
    const rows = [...activity.querySelectorAll(".rho-agent-activity-row")].map((row) => row.textContent);
    expect(rows).toEqual(["Read project metadata"]);

    // Technical payloads stay collapsed: code behind its per-row disclosure,
    // context byte evidence behind the context-used disclosure.
    const codeReview = activity.querySelector<HTMLDetailsElement>(".rho-agent-code-review")!;
    expect(codeReview.open).toBe(false);
    expect(codeReview.querySelector("summary")!.textContent).toBe("Run summary statistics");
    const contextUsed = activity.querySelector<HTMLDetailsElement>(".rho-agent-context-used")!;
    expect(contextUsed.open).toBe(false);

    // The entry swaps the timeline for the conversation-scoped review
    // surface (both stay in the DOM for the shared broker-path contract;
    // visibility toggles) with the proposal row, its collapsed content, and
    // the batch bar.
    await click(entry);
    const timeline = container.querySelector<HTMLElement>(".rho-agent-timeline")!;
    expect(timeline.hidden).toBe(true);
    const review = container.querySelector<HTMLElement>(".rho-agent-files-review")!;
    expect(review.hidden).toBe(false);
    expect(review.textContent).toContain("1 file changed");
    expect(review.textContent).toContain("Applying writes the proposed content to the project file.");
    expect(review.textContent).toContain("Apply all");
    expect(review.textContent).toContain("Reject all");
    const proposal = review.querySelector(".rho-agent-file-proposal")!;
    expect(proposal.querySelector(".rho-agent-decision-kind")!.textContent).toBe("File change");
    const content = proposal.querySelector<HTMLDetailsElement>(".rho-agent-file-content")!;
    expect(content.open).toBe(false);

    // Back returns to the conversation timeline.
    await click(review.querySelector(".rho-agent-review-back")!);
    expect(container.querySelector<HTMLElement>(".rho-agent-timeline")!.hidden).toBe(false);
  });

  it("shows a truthful empty state for a conversation without turns", async () => {
    const transport = createMockUiKernelTransport();
    transport.listAgentTurns = async () => [];
    const { container } = await renderAgent({ transport });
    const empty = container.querySelector(".rho-agent-empty")!;
    expect(empty.textContent).toContain("Ready for the first turn");
    expect(empty.textContent).toContain("composer");
    expect(container.querySelector(".rho-agent-composer textarea")).not.toBeNull();

    const chip = empty.querySelector<HTMLButtonElement>(".rho-agent-suggestions button")!;
    const suggestion = chip.textContent!;
    await click(chip);
    expect(container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!.value).toBe(suggestion);
  });

  it("switches Ask/Plan/Act, persists mode, and resets auto-approve outside Act", async () => {
    const { container, persist } = await renderAgent();

    // The modes live in one compact chip whose popover carries the options
    // with their one-line hints (Alma Reasoning pattern).
    const menu = container.querySelector<HTMLDetailsElement>(".rho-agent-mode-menu")!;
    expect(menu.open).toBe(false);
    expect(menu.querySelector("summary")!.textContent).toBe("ask");
    const modeButton = (label: string) => [...container.querySelectorAll(".rho-agent-mode button")]
      .find((button) => button.textContent === label)!;
    const actOption = modeButton("act").closest(".rho-agent-mode-option")!;
    expect(actOption.textContent).toContain("Work with project tools");

    await click(modeButton("act"));
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "act", auto_approve: false }));
    expect(modeButton("act").getAttribute("aria-pressed")).toBe("true");
    expect(menu.querySelector("summary")!.textContent).toBe("act");

    // The Act-only auto-approve toggle lives inside the same popover.
    const autoApprove = container.querySelector<HTMLInputElement>(".rho-agent-mode-menu .rho-agent-auto-approve input")!;
    await click(autoApprove);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "act", auto_approve: true }));

    await click(modeButton("ask"));
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "ask", auto_approve: false }));
    expect(container.querySelector(".rho-agent-auto-approve")).toBeNull();

    // Review context stays the control row's first child as an icon action.
    const reviewContext = container.querySelector(".rho-agent-context-controls > button:first-child")!;
    expect(reviewContext.getAttribute("aria-label")).toBe("Review context");
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

  it("switches the chat model through the revision-checked route and clears the reviewed preview", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const alternate = {
      ...base.models[0]!,
      id: "mock-profile-alternate",
      display_name: "Alternate model",
      model_id: "alternate-model",
      selected: false,
    };
    let current = { ...base, models: [...base.models, alternate] };
    transport.loadAgentLlmSettings = vi.fn(async () => structuredClone(current));
    transport.selectAgentChatModel = vi.fn(async (modelId, expectedRevision) => {
      expect(expectedRevision).toBe(current.revision);
      current = {
        ...current,
        revision: current.revision + 1,
        selected_model_id: modelId,
        capability_routes: current.capability_routes.map((route) =>
          route.capability === "agent.chat"
            ? { ...route, model_id: modelId, model_display_name: "Alternate model" }
            : route),
      };
      return structuredClone(current);
    });
    const { container } = await renderAgent({ transport });

    const menu = container.querySelector<HTMLDetailsElement>(".rho-agent-model-menu")!;
    expect(menu.querySelector("summary")!.textContent).toContain("Mock model");

    const textarea = container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    await typeInput(textarea, "Check this project");
    await click(container.querySelector(".rho-agent-context-controls button:first-child")!);
    expect(container.querySelector(".rho-agent-context-preview")).not.toBeNull();

    await click(menu.querySelector("summary")!);
    expect(menu.open).toBe(true);
    const option = [...menu.querySelectorAll("div[role='menu'] button")]
      .find((button) => button.textContent!.includes("Alternate model"))!;
    await click(option);

    expect(transport.selectAgentChatModel).toHaveBeenCalledWith("mock-profile-alternate", base.revision);
    expect(menu.open).toBe(false);
    expect(menu.querySelector("summary")!.textContent).toContain("Alternate model");
    expect(container.querySelector(".rho-agent-context-preview")).toBeNull();
  });

  it("offers search, provider groups, and per-row metadata in a long model menu", async () => {
    const transport = createMockUiKernelTransport();
    const base = await transport.loadAgentLlmSettings();
    const extra = Array.from({ length: 7 }, (_, index) => ({
      ...base.models[0]!,
      id: `mock-profile-extra-${index}`,
      display_name: `Extra model ${index}`,
      model_id: `extra-model-${index}`,
      provider_display_name: index < 4 ? "Second Provider" : "Third Provider",
      selected: false,
    }));
    transport.loadAgentLlmSettings = vi.fn(async () =>
      structuredClone({ ...base, models: [...base.models, ...extra] }));
    const { container } = await renderAgent({ transport });

    const menu = container.querySelector<HTMLDetailsElement>(".rho-agent-model-menu")!;
    await click(menu.querySelector("summary")!);
    expect(menu.open).toBe(true);

    // Eight switchable models: the search filter is shown.
    const search = menu.querySelector<HTMLInputElement>(".rho-agent-model-search")!;
    expect(search).not.toBeNull();

    // Provider group headers appear in first-seen order.
    expect([...menu.querySelectorAll(".rho-agent-model-group-label")].map((label) => label.textContent))
      .toEqual(["Mock Provider", "Second Provider", "Third Provider"]);

    // The active row carries the check, the mono model id, and metadata.
    const active = menu.querySelector("div[role='menu'] button[aria-checked='true']")!;
    expect(active.querySelector(".rho-agent-model-check")!.textContent).toBe("✓");
    expect(active.querySelector(".rho-agent-model-id")!.textContent).toBe("mock-model");
    expect(active.querySelector("small")!.textContent).toBe("33k context · ready");

    // Search filters across name, id, and provider; groups re-render.
    await typeInput(search, "third");
    const filtered = [...menu.querySelectorAll("div[role='menu'] button")];
    expect(filtered.length).toBe(3);
    expect(filtered.every((button) => button.textContent!.includes("Extra model"))).toBe(true);
    expect([...menu.querySelectorAll(".rho-agent-model-group-label")].map((label) => label.textContent))
      .toEqual(["Third Provider"]);

    await typeInput(search, "does-not-exist");
    expect([...menu.querySelectorAll("div[role='menu'] button")].length).toBe(0);
    expect(menu.textContent).toContain("No model matches the search.");

    // Closing the menu resets the query.
    await act(async () => { menu.open = false; await settle(); });
    await click(menu.querySelector("summary")!);
    expect(menu.querySelector<HTMLInputElement>(".rho-agent-model-search")!.value).toBe("");
    expect([...menu.querySelectorAll("div[role='menu'] button")].length).toBe(8);
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
    // The code under review stays visible yet collapsed inside the strip.
    const approvalCode = approval.querySelector<HTMLDetailsElement>(".rho-agent-approval-code")!;
    expect(approvalCode.open).toBe(false);
    expect(approvalCode.querySelector("pre")!.textContent).toContain("install.packages('demo')");
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
    await click(container.querySelector(".rho-agent-files-entry")!);
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

  it("applies and rejects batches through the existing per-file paths", async () => {
    const transport = createMockUiKernelTransport();
    const base = (await transport.getAgentTurnDetail("agent-turn:mock-1"))!;
    const proposalEvent = (id: number, path: string) => ({
      id,
      turn_id: base.turn.turn_id,
      timestamp: mockNow,
      event_type: "tool.call_completed",
      title: "Proposed file edit",
      body: JSON.stringify({
        kind: "rho.file_edit_proposal",
        operation: "append",
        path,
        content: `\n# ${path}\n`,
      }),
      status: "completed",
      tool: "propose_file_edit",
      request_id: null,
      code: null,
      details_json: JSON.stringify({ success: true }),
    });
    transport.getAgentTurnDetail = async () => makeDetail(base.turn, {
      events: [...base.events, proposalEvent(10, "b.R"), proposalEvent(11, "c.R")],
      approvals: base.approvals,
    });
    const mutation: AgentFileMutationResponse = {
      status: "applied",
      path: "analysis.R",
      content: null,
      start: 0,
      end: 0,
      after_sha256: "f".repeat(64),
      project: { root: "/mock/project", files: [], truncated: false },
      workspace: {
        workspace_id: "workspace:mock",
        kernel_instance_id: "kernel:mock",
        execution_seq: 1,
        state_revision: 4,
        project_revision: 1,
      },
    };
    const applyFileProposal = vi.fn<ApplyFileProposalFn>(async () => ({ response: mutation, beforeContent: "" }));
    const { container, persist } = await renderAgent({ transport, applyFileProposal });

    await click(container.querySelector(".rho-agent-files-entry")!);
    const batch = container.querySelector(".rho-agent-review-batch")!;
    const applyAll = [...batch.querySelectorAll("button")].find((button) => button.textContent === "Apply all (3)")!;
    await click(applyAll);

    expect(applyFileProposal).toHaveBeenCalledTimes(3);
    const appliedPaths = applyFileProposal.mock.calls.map((call) => call[2].path);
    expect(appliedPaths).toEqual(["analysis.R", "b.R", "c.R"]);

    const rejectAll = [...batch.querySelectorAll("button")].find((button) => button.textContent === "Reject all")!;
    await click(rejectAll);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
      file_decisions: {
        "agent-turn:mock-1:3": "rejected",
        "agent-turn:mock-1:10": "rejected",
        "agent-turn:mock-1:11": "rejected",
      },
    }));
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

  it("applies live turn frames and reconciles gaps and terminals through refresh", async () => {
    const transport = createMockUiKernelTransport();
    let currentTurn = makeTurn({
      turn_id: "agent-turn:mock-live",
      status: "running",
      finished_at: null,
      terminal_reason: null,
      prompt_preview: "Inspect the runtime logs",
    });
    transport.listAgentTurns = async () => [currentTurn];
    transport.getAgentTurnDetail = async () => makeDetail(currentTurn);
    const listConversations = vi.fn(transport.listAgentConversations.bind(transport));
    transport.listAgentConversations = listConversations;
    const { container } = await renderAgent({ transport });
    const baselineRefreshCalls = listConversations.mock.calls.length;

    const frameEvent = (id: number, title: string) => ({
      id,
      turn_id: currentTurn.turn_id,
      timestamp: mockNow,
      event_type: "tool.call_completed",
      title,
      body: null,
      status: "completed",
      tool: "read_project_metadata",
      request_id: null,
      code: null,
      details_json: "{}",
    });

    // An in-order activity frame lands incrementally, with no refresh.
    await act(async () => {
      transport.emitAgentTurnEvent({
        turn_id: currentTurn.turn_id,
        event: frameEvent(1, "Read project metadata"),
        turn_update: null,
        payload_truncated: false,
      });
      await settle();
    });
    expect(container.querySelector('[data-turn-id="agent-turn:mock-live"]')!.textContent)
      .toContain("Read project metadata");
    expect(listConversations.mock.calls.length).toBe(baselineRefreshCalls);

    // A gap frame (id 3 after id 1) reconciles through the store refresh.
    await act(async () => {
      transport.emitAgentTurnEvent({
        turn_id: currentTurn.turn_id,
        event: frameEvent(3, "Run summary statistics"),
        turn_update: null,
        payload_truncated: false,
      });
      await settle();
    });
    expect(listConversations.mock.calls.length).toBeGreaterThan(baselineRefreshCalls);

    // A terminal frame updates the running turn; the reconciling refresh
    // then brings the canonical completed state from the store.
    currentTurn = {
      ...currentTurn,
      status: "completed",
      finished_at: mockNow,
      final_message: "Done live.",
      terminal_reason: "completed",
    };
    await act(async () => {
      transport.emitAgentTurnEvent({
        turn_id: currentTurn.turn_id,
        event: null,
        turn_update: {
          status: "completed",
          final_message: "Done live.",
          error_message: null,
          terminal_reason: "completed",
        },
        payload_truncated: false,
      });
      await settle();
    });
    const turn = container.querySelector('[data-turn-id="agent-turn:mock-live"]')!;
    expect(turn.textContent).toContain("Done live.");
    expect(turn.querySelector(".rho-agent-turn-status")).toBeNull();
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
