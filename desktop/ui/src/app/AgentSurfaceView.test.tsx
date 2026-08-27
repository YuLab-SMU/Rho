import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentConversationSummary,
  AgentFileMutationResponse,
  AgentTurnDetail,
  AgentTurnSummary,
  RuntimeOutputReference,
  RunAgentRequest,
  SurfaceInstance,
} from "../transport";
import { createMockUiKernelTransport } from "../transport/mock";
import {
  AgentSurfaceView,
  type AgentFileProposal,
  type AgentFileUndoState,
  type AgentSurfaceViewState,
} from "./AgentSurfaceView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mockNow = "2026-08-22T12:00:00Z";

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function makeConversation(overrides: Partial<AgentConversationSummary> & {
  readonly conversation_id: string;
}): AgentConversationSummary {
  return {
    project_root: "/mock/project",
    title: "Agent conversation",
    created_at: mockNow,
    updated_at: mockNow,
    archived_at: null,
    legacy_unthreaded: false,
    turn_count: 1,
    status: "completed",
    latest_turn_id: null,
    latest_mode: "ask",
    latest_prompt_preview: null,
    terminal_reason: "completed",
    pending_request_id: null,
    ...overrides,
  };
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
    readonly instance?: SurfaceInstance;
    readonly persist?: (viewState: AgentSurfaceViewState) => Promise<void>;
    readonly createConversation?: (
      current: AgentSurfaceViewState,
    ) => Promise<AgentSurfaceViewState>;
    readonly runConversation?: (
      current: AgentSurfaceViewState,
      request: RunAgentRequest,
    ) => Promise<AgentSurfaceViewState>;
    readonly applyFileProposal?: (
      turn: AgentTurnSummary,
      eventId: number,
      proposal: AgentFileProposal,
    ) => Promise<{
      readonly response: AgentFileMutationResponse;
      readonly beforeContent: string;
    }>;
    readonly undoFileProposal?: (request: AgentFileUndoState) => Promise<void>;
    readonly pinTask?: (turn: AgentTurnSummary) => Promise<void>;
    readonly runtimeOutputContext?: RuntimeOutputReference | null;
    readonly reportError?: (error: unknown) => void;
  } = {}) {
    const transport = options.transport ?? createMockUiKernelTransport();
    const surfaces = await transport.loadSurfaces();
    const instance: SurfaceInstance = options.instance ?? {
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
    const persist = options.persist ?? vi.fn(async () => undefined);
    const pinTask = options.pinTask ?? vi.fn(async () => undefined);
    const applyFileProposal = options.applyFileProposal ?? vi.fn(async () => {
      throw new Error("applyFileProposal is not expected in this test");
    });
    const undoFileProposal = options.undoFileProposal ?? vi.fn(async () => undefined);
    const reportError = options.reportError ?? vi.fn();
    const setRuntimeOutputContext = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const health = options.health === undefined
      ? { state: "ready", label: "Agent runtime ready", detail: null }
      : options.health;
    const renderView = async (overrides: {
      readonly transport?: ReturnType<typeof createMockUiKernelTransport>;
      readonly health?: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
      readonly instance?: SurfaceInstance;
      readonly createConversation?: (
        current: AgentSurfaceViewState,
      ) => Promise<AgentSurfaceViewState>;
      readonly runConversation?: (
        current: AgentSurfaceViewState,
        request: RunAgentRequest,
      ) => Promise<AgentSurfaceViewState>;
      readonly persist?: (viewState: AgentSurfaceViewState) => Promise<void>;
      readonly runtimeOutputContext?: RuntimeOutputReference | null;
      readonly reportError?: (error: unknown) => void;
    } = {}) => {
      const renderTransport = overrides.transport ?? transport;
      const renderPersist = overrides.persist ?? persist;
      const createConversation = overrides.createConversation ?? (async (current) => {
        const conversation = await renderTransport.createAgentConversation();
        const next = { ...current, conversation_id: conversation.conversation_id };
        await renderPersist(next);
        return next;
      });
      const runConversation = overrides.runConversation ?? (async (current, request) => {
        const response = await renderTransport.runAgent(request);
        const next = { ...current, conversation_id: response.conversation_id, composer: "" };
        await renderPersist(next);
        return next;
      });
      await act(async () => {
        root.render(<AgentSurfaceView
          instance={overrides.instance ?? instance}
          transport={renderTransport}
          health={overrides.health === undefined ? health : overrides.health}
          createConversation={createConversation}
          runConversation={runConversation}
          persist={renderPersist}
          pinTask={pinTask}
          applyFileProposal={applyFileProposal}
          undoFileProposal={undoFileProposal}
          reportError={overrides.reportError ?? reportError}
          runtimeOutputContext={overrides.runtimeOutputContext === undefined
            ? options.runtimeOutputContext ?? null
            : overrides.runtimeOutputContext}
          setRuntimeOutputContext={setRuntimeOutputContext}
        />);
        await settle();
      });
    };
    await renderView({
      ...(options.createConversation == null ? {} : { createConversation: options.createConversation }),
      ...(options.runConversation == null ? {} : { runConversation: options.runConversation }),
    });
    return {
      container,
      instance,
      applyFileProposal,
      persist,
      pinTask,
      renderView,
      reportError,
      root,
      setRuntimeOutputContext,
      transport,
      undoFileProposal,
    };
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

  async function selectInput(element: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(element, value);
      element.dispatchEvent(new Event("change", { bubbles: true }));
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

    const proposal = container.querySelector(".rho-agent-file-proposal")!;
    expect(proposal.querySelector(".rho-agent-decision-kind")!.textContent).toBe("File change");
    const content = proposal.querySelector<HTMLDetailsElement>(".rho-agent-file-content")!;
    expect(content.open).toBe(false);
    const activity = container.querySelector(".rho-agent-activity")!;
    expect(proposal.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

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
      modelId: "mock-profile",
      expectedRevision: 1,
      expectedConfigSnapshotId: "mock-config-snapshot-1",
      contextWindowTokens: 65_536,
      reservedOutputTokens: 8_192,
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
    transport.selectAgentChatModel = vi.fn(async (request) => {
      expect(request.expectedRevision).toBe(current.revision);
      expect(request.expectedConfigSnapshotId).toBe(current.config_store.config_snapshot_id);
      current = {
        ...current,
        revision: current.revision + 1,
        config_store: {
          ...current.config_store,
          config_snapshot_id: `${current.config_store.config_snapshot_id}:select`,
        },
        selected_model_id: request.modelId,
        capability_routes: current.capability_routes.map((route) =>
          route.capability === "agent.chat"
            ? { ...route, model_id: request.modelId, model_display_name: "Alternate model" }
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

    expect(transport.selectAgentChatModel).toHaveBeenCalledWith({
      modelId: "mock-profile-alternate",
      expectedRevision: base.revision,
      expectedConfigSnapshotId: base.config_store.config_snapshot_id,
    });
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

  it("admits Stop once and blocks same-event view snapshots", async () => {
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
    const cancelGate = deferred<Awaited<ReturnType<typeof transport.cancelAgentTurn>>>();
    const cancelAgentTurn = vi.fn(() => cancelGate.promise);
    transport.cancelAgentTurn = cancelAgentTurn;
    const { container, persist } = await renderAgent({ transport });

    const statusRow = container.querySelector(".rho-agent-composer .rho-agent-running")!;
    expect(statusRow.textContent).toContain("Agent running");
    const stop = [...statusRow.querySelectorAll("button")].find((button) => button.textContent === "Stop")!;
    const plan = [...container.querySelectorAll<HTMLButtonElement>('.rho-agent-mode button')]
      .find((button) => button.textContent === "plan")!;
    await act(async () => {
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(cancelAgentTurn).toHaveBeenCalledWith("agent-turn:mock-running");
    expect(cancelAgentTurn).toHaveBeenCalledOnce();
    expect(stop.disabled).toBe(true);
    expect(plan.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    await act(async () => {
      cancelGate.resolve({ status: "cancelled", turn_id: runningTurn.turn_id });
      await settle();
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("names the wait and admits an approval response only once", async () => {
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
    const approvalGate = deferred<Awaited<ReturnType<typeof transport.respondAgentApproval>>>();
    const respondAgentApproval = vi.fn(() => approvalGate.promise);
    transport.respondAgentApproval = respondAgentApproval;
    const { container, persist } = await renderAgent({ transport });

    expect(container.querySelector(".rho-agent-composer .rho-agent-running")!.textContent)
      .toContain("Waiting for a decision or response");
    const approval = container.querySelector(".rho-agent-approval")!;
    expect(approval.querySelector(".rho-agent-decision-kind")!.textContent).toBe("Approval required");
    expect(approval.querySelector("pre")!.textContent).toContain("install.packages('demo')");
    expect(container.querySelector(".rho-agent-file-proposal")).toBeNull();

    const approve = [...approval.querySelectorAll("button")].find((button) => button.textContent === "Approve")!;
    const plan = [...container.querySelectorAll<HTMLButtonElement>('.rho-agent-mode button')]
      .find((button) => button.textContent === "plan")!;
    await act(async () => {
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(respondAgentApproval).toHaveBeenCalledWith({
      request_id: "approval-request:mock-1",
      decision: "approve",
      reason: null,
    });
    expect(respondAgentApproval).toHaveBeenCalledOnce();
    expect(approve.disabled).toBe(true);
    expect(plan.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    await act(async () => {
      approvalGate.resolve({
        status: "delivered",
        request_id: "approval-request:mock-1",
        turn_id: waitingTurn.turn_id,
      });
      await settle();
    });
    expect(persist).not.toHaveBeenCalled();
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

  it("admits turn Retry once and blocks same-event view decisions", async () => {
    const transport = createMockUiKernelTransport();
    const failedTurn = makeTurn({
      turn_id: "agent-turn:retry-guard",
      status: "failed",
      terminal_reason: "provider_error",
      prompt_preview: "Retry exactly once",
      error_message: "Provider rejected the request.",
    });
    transport.listAgentTurns = vi.fn(async () => [failedTurn]);
    transport.getAgentTurnDetail = vi.fn(async () => makeDetail(failedTurn));
    const retryGate = deferred<Awaited<ReturnType<typeof transport.retryAgentTurn>>>();
    const retryAgentTurn = vi.fn(() => retryGate.promise);
    transport.retryAgentTurn = retryAgentTurn;
    const { container, persist } = await renderAgent({ transport });
    const retry = [...container.querySelectorAll<HTMLButtonElement>(
      '[data-turn-id="agent-turn:retry-guard"] footer button',
    )].find((button) => button.textContent === "Retry")!;
    const plan = [...container.querySelectorAll<HTMLButtonElement>('.rho-agent-mode button')]
      .find((button) => button.textContent === "plan")!;

    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(retryAgentTurn).toHaveBeenCalledOnce();
    expect(retry.disabled).toBe(true);
    expect(plan.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    await act(async () => {
      retryGate.resolve({
        status: "started",
        turn_id: "agent-turn:retry-created",
        conversation_id: failedTurn.conversation_id,
        retry_of_turn_id: failedTurn.turn_id,
        auto_approve: false,
        task_kind: "agent_turn",
      });
      await settle();
    });
    expect(persist).not.toHaveBeenCalled();
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

  it("admits Apply and Undo once each and blocks same-event view decisions", async () => {
    const transport = createMockUiKernelTransport();
    const mutationResponse = await transport.applyAgentFileEdit({
      turn_id: "agent-turn:mock-1",
      proposal_event_id: 3,
      path: "analysis.R",
      expected_disk_sha256: null,
      before_content: "before",
    });
    const applyGate = deferred<{
      readonly response: AgentFileMutationResponse;
      readonly beforeContent: string;
    }>();
    const undoGate = deferred<void>();
    const applyFileProposal = vi.fn(() => applyGate.promise);
    const undoFileProposal = vi.fn(() => undoGate.promise);
    const { container, persist } = await renderAgent({
      applyFileProposal,
      transport,
      undoFileProposal,
    });
    const proposal = container.querySelector(".rho-agent-file-proposal")!;
    const apply = [...proposal.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Apply")!;
    const reject = [...proposal.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Reject")!;
    const plan = [...container.querySelectorAll<HTMLButtonElement>('.rho-agent-mode button')]
      .find((button) => button.textContent === "plan")!;

    await act(async () => {
      apply.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      apply.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      reject.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(applyFileProposal).toHaveBeenCalledOnce();
    expect(apply.disabled).toBe(true);
    expect(plan.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    await act(async () => {
      applyGate.resolve({ response: mutationResponse, beforeContent: "before" });
      await settle();
    });
    const undo = [...proposal.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Undo applied edit")!;
    expect(undo).not.toBeNull();

    await act(async () => {
      undo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      undo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      reject.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(undoFileProposal).toHaveBeenCalledOnce();
    expect(undo.disabled).toBe(true);
    expect(plan.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    await act(async () => {
      undoGate.resolve();
      await settle();
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("admits context review once and blocks same-event mode and file decisions", async () => {
    const transport = createMockUiKernelTransport();
    const preview = await transport.previewAgentContext({
      prompt: "Review this context once",
      mode: "ask",
      task_kind: "agent_turn",
      model_id: null,
      editor_context: null,
      conversation_id: "agent-conversation:mock-shared",
      runtime_output_context: null,
    });
    const previewGate = deferred<typeof preview>();
    const previewAgentContext = vi.fn(() => previewGate.promise);
    transport.previewAgentContext = previewAgentContext;
    const { container, persist } = await renderAgent({ transport });
    await typeInput(
      container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!,
      "Review this context once",
    );
    const review = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-context-controls button")]
      .find((button) => button.textContent === "Review context")!;
    const plan = [...container.querySelectorAll<HTMLButtonElement>('.rho-agent-mode button')]
      .find((button) => button.textContent === "plan")!;
    const reject = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-file-proposal button")]
      .find((button) => button.textContent === "Reject")!;

    await act(async () => {
      review.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      review.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      reject.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });

    expect(previewAgentContext).toHaveBeenCalledOnce();
    expect(review.disabled).toBe(true);
    expect(plan.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    await act(async () => {
      previewGate.resolve(preview);
      await settle();
    });
    expect(container.querySelector<HTMLButtonElement>('.rho-agent-mode button[aria-pressed="true"]')!.textContent)
      .toBe("ask");
    expect(container.querySelector(".rho-agent-file-outcome")).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("submits the unchanged Agent request only through the composition-root capability", async () => {
    const transport = createMockUiKernelTransport();
    const rawRunAgent = vi.spyOn(transport, "runAgent");
    const runConversation = vi.fn(async (current: AgentSurfaceViewState) => ({
      ...current,
      composer: "",
    }));
    const { container, setRuntimeOutputContext } = await renderAgent({
      runConversation,
      transport,
    });

    const textarea = container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    await typeInput(textarea, "What changed since yesterday?");
    const send = container.querySelector<HTMLButtonElement>(".rho-agent-context-controls .rho-primary-action")!;
    await click(send);

    expect(runConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "agent-conversation:mock-shared",
      composer: "What changed since yesterday?",
    }), {
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
    expect(rawRunAgent).not.toHaveBeenCalled();
    expect(setRuntimeOutputContext).toHaveBeenCalledWith(null);
    expect(container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!.value).toBe("");
  });

  it("keeps a no-conversation Send local until its admitted identity workflow succeeds", async () => {
    const transport = createMockUiKernelTransport();
    let conversations: readonly AgentConversationSummary[] = [];
    transport.listAgentConversations = vi.fn(async () => conversations);
    transport.listAgentTurns = vi.fn(async () => []);
    const rawRunAgent = vi.spyOn(transport, "runAgent");
    let invalidate: (() => void) | null = null;
    transport.subscribeAgentInvalidated = vi.fn((listener) => {
      invalidate = listener;
      return () => undefined;
    });
    const createdConversation = makeConversation({
      conversation_id: "agent-conversation:send-created",
      title: "Created by Send",
      turn_count: 1,
      status: "completed",
      terminal_reason: "completed",
    });
    const workflow = deferred<AgentSurfaceViewState>();
    const runConversation = vi.fn(() => {
      conversations = [createdConversation];
      invalidate?.();
      return workflow.promise;
    });
    const persist = vi.fn(async () => undefined);
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
        conversation_id: null,
        mode: "ask",
        composer: "",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const { container, reportError } = await renderAgent({
      instance,
      persist,
      runConversation,
      transport,
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    await typeInput(textarea, "Start from this prompt");
    await click(container.querySelector<HTMLButtonElement>(
      ".rho-agent-context-controls .rho-primary-action",
    )!);

    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;
    expect(runConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: null,
      composer: "Start from this prompt",
    }), expect.objectContaining({
      conversation_id: null,
      prompt: "Start from this prompt",
    }));
    expect(rawRunAgent).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(picker.value).toBe("");
    expect(textarea.value).toBe("Start from this prompt");

    await act(async () => {
      workflow.resolve({
        conversation_id: createdConversation.conversation_id,
        mode: "ask",
        composer: "",
        auto_approve: false,
        file_decisions: {},
      });
      await settle();
    });
    expect(picker.value).toBe(createdConversation.conversation_id);
    expect(textarea.value).toBe("");
    expect(persist).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("preserves a missing bounded-list preference, blocks Send, and recovers after explicit clear", async () => {
    const transport = createMockUiKernelTransport();
    const visibleConversation = makeConversation({
      conversation_id: "agent-conversation:visible",
      title: "Visible bounded result",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    transport.listAgentConversations = vi.fn(async () => [visibleConversation]);
    transport.listAgentTurns = vi.fn(async () => []);
    const persist = vi.fn(async () => undefined);
    const runConversation = vi.fn(async (current: AgentSurfaceViewState) => ({
      ...current,
      composer: "",
    }));
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
        conversation_id: "agent-conversation:outside-bounded-result",
        mode: "ask",
        composer: "Do not target a hidden conversation",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const { container } = await renderAgent({ instance, persist, runConversation, transport });
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;
    const send = container.querySelector<HTMLButtonElement>(
      ".rho-agent-context-controls .rho-primary-action",
    )!;

    expect([...picker.options].map((option) => option.value)).toContain(visibleConversation.conversation_id);
    expect(picker.value).toBe("agent-conversation:outside-bounded-result");
    expect(picker.selectedOptions[0]?.textContent).toBe("Selected conversation unavailable");
    expect(container.querySelector(".rho-agent-empty")!.textContent)
      .toContain("Choose No conversation or a listed conversation");
    expect(send.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(runConversation).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();

    await selectInput(picker, "");
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: null }));
    expect(picker.value).toBe("");
    expect(send.disabled).toBe(false);

    await click(send);

    expect(runConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: null,
    }), expect.objectContaining({
      conversation_id: null,
      prompt: "Do not target a hidden conversation",
    }));
    expect(persist).toHaveBeenCalledOnce();
  });

  it("blocks Review and Send before the initial bounded-list validation settles", async () => {
    const transport = createMockUiKernelTransport();
    const preferredConversation = makeConversation({
      conversation_id: "agent-conversation:initial-validation",
      title: "Initial validation target",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    const listGate = deferred<readonly AgentConversationSummary[]>();
    let listCall = 0;
    transport.listAgentConversations = vi.fn(() => {
      listCall += 1;
      return listCall === 1 ? listGate.promise : Promise.resolve([preferredConversation]);
    });
    transport.listAgentTurns = vi.fn(async () => []);
    const previewAgentContext = vi.spyOn(transport, "previewAgentContext");
    const runConversation = vi.fn(async (current: AgentSurfaceViewState) => ({
      ...current,
      composer: "",
    }));
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
        conversation_id: preferredConversation.conversation_id,
        mode: "ask",
        composer: "Wait for the bounded list",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const { container } = await renderAgent({ instance, runConversation, transport });
    const send = container.querySelector<HTMLButtonElement>(
      ".rho-agent-context-controls .rho-primary-action",
    )!;
    const review = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-context-controls button")]
      .find((button) => button.textContent === "Review context")!;
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;

    expect(send.disabled).toBe(true);
    expect(review.disabled).toBe(true);
    expect(picker.selectedOptions[0]?.textContent).toBe("Checking selected conversation…");
    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      review.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(runConversation).not.toHaveBeenCalled();
    expect(previewAgentContext).not.toHaveBeenCalled();

    await act(async () => {
      listGate.resolve([preferredConversation]);
      await settle();
    });
    expect(send.disabled).toBe(false);
    expect(review.disabled).toBe(false);

    await click(send);
    expect(runConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: preferredConversation.conversation_id,
      composer: "Wait for the bounded list",
      mode: "ask",
    }), expect.objectContaining({
      conversation_id: preferredConversation.conversation_id,
      prompt: "Wait for the bounded list",
      mode: "ask",
    }));
  });

  it("blocks a same-event Send when invalidation starts a new bounded-list validation", async () => {
    const transport = createMockUiKernelTransport();
    const preferredConversation = makeConversation({
      conversation_id: "agent-conversation:invalidation-race",
      title: "Invalidation race target",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    const invalidationGate = deferred<readonly AgentConversationSummary[]>();
    let listCall = 0;
    transport.listAgentConversations = vi.fn(() => {
      listCall += 1;
      return listCall === 1 ? Promise.resolve([preferredConversation]) : invalidationGate.promise;
    });
    transport.listAgentTurns = vi.fn(async () => []);
    let invalidate: (() => void) | null = null;
    transport.subscribeAgentInvalidated = vi.fn((listener) => {
      invalidate = listener;
      return () => undefined;
    });
    const runConversation = vi.fn(async (current: AgentSurfaceViewState) => current);
    const persist = vi.fn(async () => undefined);
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
        conversation_id: preferredConversation.conversation_id,
        mode: "ask",
        composer: "Do not race invalidation",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const { container } = await renderAgent({ instance, persist, runConversation, transport });
    const send = container.querySelector<HTMLButtonElement>(
      ".rho-agent-context-controls .rho-primary-action",
    )!;
    expect(send.disabled).toBe(false);

    await act(async () => {
      invalidate?.();
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(runConversation).not.toHaveBeenCalled();
    expect(send.disabled).toBe(true);

    await act(async () => {
      invalidationGate.resolve([]);
      await settle();
    });
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;
    expect(picker.value).toBe(preferredConversation.conversation_id);
    expect(picker.selectedOptions[0]?.textContent).toBe("Selected conversation unavailable");
    expect(send.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ["conversation list rejection", "conversations", "reject"],
    ["conversation list result", "conversations", "resolve"],
    ["turn list result", "turns", "resolve"],
    ["turn detail result", "detail", "resolve"],
  ] as const)("keeps exact no-conversation Send identity when a superseded %s settles late", async (_label, stage, outcome) => {
    const transport = createMockUiKernelTransport();
    const createdConversation = makeConversation({
      conversation_id: "agent-conversation:send-exact",
      title: "Exact Send conversation",
      latest_turn_id: "agent-turn:send-exact",
      latest_prompt_preview: "Exact Send prompt",
    });
    const createdTurn = makeTurn({
      turn_id: "agent-turn:send-exact",
      conversation_id: createdConversation.conversation_id,
      prompt_preview: "Exact Send prompt",
      final_message: "Exact Send answer",
    });
    const createdDetail = makeDetail(createdTurn);
    const staleConversation = makeConversation({
      conversation_id: "agent-conversation:send-stale",
      title: "Stale Send conversation",
      latest_turn_id: "agent-turn:send-stale",
      latest_prompt_preview: "STALE SEND PROMPT",
    });
    const staleTurn = makeTurn({
      turn_id: "agent-turn:send-stale",
      conversation_id: createdConversation.conversation_id,
      prompt_preview: "STALE SEND PROMPT",
      final_message: "STALE SEND ANSWER",
    });
    const staleDetail = makeDetail(staleTurn);
    const conversationsGate = deferred<readonly AgentConversationSummary[]>();
    const turnsGate = deferred<readonly AgentTurnSummary[]>();
    const detailGate = deferred<AgentTurnDetail | null>();
    let conversationsCall = 0;
    let turnsCall = 0;
    let detailCall = 0;
    transport.listAgentConversations = vi.fn(() => {
      conversationsCall += 1;
      if (conversationsCall === 1) return Promise.resolve([]);
      if (conversationsCall === 2 && stage === "conversations") return conversationsGate.promise;
      return Promise.resolve([createdConversation]);
    });
    transport.listAgentTurns = vi.fn(() => {
      turnsCall += 1;
      if (turnsCall === 1 && stage === "turns") return turnsGate.promise;
      return Promise.resolve([createdTurn]);
    });
    transport.getAgentTurnDetail = vi.fn(() => {
      detailCall += 1;
      if (detailCall === 1 && stage === "detail") return detailGate.promise;
      return Promise.resolve(createdDetail);
    });
    let invalidate: (() => void) | null = null;
    transport.subscribeAgentInvalidated = vi.fn((listener) => {
      invalidate = listener;
      return () => undefined;
    });
    const runConversation = vi.fn(async (current: AgentSurfaceViewState) => ({
      ...current,
      conversation_id: createdConversation.conversation_id,
      composer: "",
    }));
    const persist = vi.fn(async () => undefined);
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
        conversation_id: null,
        mode: "ask",
        composer: "Run exact Send",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const { container, reportError } = await renderAgent({
      instance,
      persist,
      runConversation,
      transport,
    });

    await click(container.querySelector<HTMLButtonElement>(
      ".rho-agent-context-controls .rho-primary-action",
    )!);
    await vi.waitFor(() => {
      if (stage === "conversations") expect(conversationsCall).toBe(2);
      if (stage === "turns") expect(turnsCall).toBe(1);
      if (stage === "detail") expect(detailCall).toBe(1);
    });
    await act(async () => {
      invalidate?.();
      await settle();
    });
    expect(container.textContent).toContain("Exact Send answer");

    await act(async () => {
      const lateError = new Error(`late ${stage} refresh rejected`);
      if (stage === "conversations") {
        if (outcome === "reject") conversationsGate.reject(lateError);
        else conversationsGate.resolve([staleConversation]);
      }
      if (stage === "turns") turnsGate.resolve([staleTurn]);
      if (stage === "detail") detailGate.resolve(staleDetail);
      await settle();
    });

    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;
    expect(picker.value).toBe(createdConversation.conversation_id);
    expect(container.querySelector(`[data-turn-id="${createdTurn.turn_id}"]`)).not.toBeNull();
    expect(container.textContent).toContain("Exact Send answer");
    expect(container.textContent).not.toContain("STALE SEND");
    expect(container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!.value).toBe("");
    expect(persist).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    ["conversation list", "conversations"],
    ["turn list", "turns"],
    ["turn detail", "detail"],
  ] as const)("drops a deferred old-activation %s after the exact host activation changes", async (_label, stage) => {
    const oldConversation = makeConversation({
      conversation_id: "agent-conversation:activation-a",
      project_root: "/projects/a",
      title: "Activation A",
      latest_turn_id: "agent-turn:activation-a",
      latest_prompt_preview: "OLD ACTIVATION PROMPT",
    });
    const oldTurn = makeTurn({
      turn_id: "agent-turn:activation-a",
      conversation_id: oldConversation.conversation_id,
      project_root: oldConversation.project_root,
      prompt_preview: "OLD ACTIVATION PROMPT",
      final_message: "OLD ACTIVATION ANSWER",
    });
    const oldDetail = makeDetail(oldTurn);
    const conversationsGate = deferred<AgentConversationSummary[]>();
    const turnsGate = deferred<AgentTurnSummary[]>();
    const detailGate = deferred<AgentTurnDetail | null>();
    const oldTransport = createMockUiKernelTransport();
    const oldListConversations = vi.fn(() => stage === "conversations"
      ? conversationsGate.promise
      : Promise.resolve([oldConversation]));
    const oldListTurns = vi.fn(() => stage === "turns"
      ? turnsGate.promise
      : Promise.resolve([oldTurn]));
    const oldGetDetail = vi.fn(() => stage === "detail"
      ? detailGate.promise
      : Promise.resolve(oldDetail));
    oldTransport.listAgentConversations = oldListConversations;
    oldTransport.listAgentTurns = oldListTurns;
    oldTransport.getAgentTurnDetail = oldGetDetail;
    const oldSurface = (await oldTransport.loadSurfaces()).catalog.instances.find(
      (candidate) => candidate.surface_id === "rho.agent",
    )!;
    const oldInstance: SurfaceInstance = {
      ...oldSurface,
      instance_id: "surface-instance:agent-test",
      view_state: {
        conversation_id: oldConversation.conversation_id,
        mode: "ask",
        composer: "",
        auto_approve: false,
      },
    };

    const {
      container,
      instance,
      persist: oldPersist,
      renderView,
      reportError: oldReportError,
    } = await renderAgent({ instance: oldInstance, transport: oldTransport });
    if (stage === "conversations") expect(oldListConversations).toHaveBeenCalledTimes(1);
    if (stage === "turns") expect(oldListTurns).toHaveBeenCalledTimes(1);
    if (stage === "detail") expect(oldGetDetail).toHaveBeenCalledTimes(1);
    expect(oldPersist).not.toHaveBeenCalled();

    const nextConversation = makeConversation({
      conversation_id: "agent-conversation:activation-b",
      project_root: "/projects/b",
      title: "Activation B",
      latest_turn_id: "agent-turn:activation-b",
      latest_prompt_preview: "NEW ACTIVATION PROMPT",
    });
    const nextTurn = makeTurn({
      turn_id: "agent-turn:activation-b",
      conversation_id: nextConversation.conversation_id,
      project_root: nextConversation.project_root,
      prompt_preview: "NEW ACTIVATION PROMPT",
      final_message: "NEW ACTIVATION ANSWER",
    });
    const nextDetail = makeDetail(nextTurn);
    const nextTransport = createMockUiKernelTransport();
    const nextListConversations = vi.fn(async () => [nextConversation]);
    const nextListTurns = vi.fn(async () => [nextTurn]);
    const nextGetDetail = vi.fn(async () => nextDetail);
    let invalidateNext: (() => void) | null = null;
    nextTransport.listAgentConversations = nextListConversations;
    nextTransport.listAgentTurns = nextListTurns;
    nextTransport.getAgentTurnDetail = nextGetDetail;
    nextTransport.subscribeAgentInvalidated = vi.fn((listener) => {
      invalidateNext = listener;
      return () => undefined;
    });
    const nextPersist = vi.fn(async () => undefined);
    const nextReportError = vi.fn();
    const nextInstance: SurfaceInstance = {
      ...instance,
      project_id: "project:activation-b",
      activation_generation: instance.activation_generation + 1,
      view_state: {
        conversation_id: nextConversation.conversation_id,
        mode: "ask",
        composer: "",
        auto_approve: false,
      },
    };

    await renderView({
      instance: nextInstance,
      transport: nextTransport,
      persist: nextPersist,
      reportError: nextReportError,
    });

    expect(nextListConversations).toHaveBeenCalledTimes(1);
    expect(nextListTurns).toHaveBeenCalledWith(nextConversation.conversation_id, 50);
    expect(nextGetDetail).toHaveBeenCalledWith(nextTurn.turn_id);
    expect(container.querySelector(`[data-turn-id="${nextTurn.turn_id}"]`)).not.toBeNull();
    expect(container.textContent).toContain("NEW ACTIVATION ANSWER");
    expect(container.querySelector<HTMLSelectElement>(
      `select[aria-label="Conversation for ${instance.instance_id}"]`,
    )!.value).toBe(nextConversation.conversation_id);

    await act(async () => {
      if (stage === "conversations") conversationsGate.resolve([oldConversation]);
      if (stage === "turns") turnsGate.resolve([oldTurn]);
      if (stage === "detail") detailGate.resolve(oldDetail);
      await settle();
    });

    expect(container.querySelector(`[data-turn-id="${oldTurn.turn_id}"]`)).toBeNull();
    expect(container.textContent).not.toContain("OLD ACTIVATION PROMPT");
    expect(container.textContent).toContain("NEW ACTIVATION ANSWER");
    expect(oldPersist).not.toHaveBeenCalled();
    expect(oldReportError).not.toHaveBeenCalled();
    expect(nextReportError).not.toHaveBeenCalled();
    expect(nextPersist).not.toHaveBeenCalled();

    const callsBeforeInvalidation = nextListConversations.mock.calls.length;
    await act(async () => {
      expect(invalidateNext).not.toBeNull();
      invalidateNext?.();
      await settle();
    });
    expect(nextListConversations).toHaveBeenCalledTimes(callsBeforeInvalidation + 1);
    expect(container.querySelector(`[data-turn-id="${nextTurn.turn_id}"]`)).not.toBeNull();
  });

  it("does not project a rejected stale refresh into the newly accepted host", async () => {
    const staleGate = deferred<AgentConversationSummary[]>();
    const staleTransport = createMockUiKernelTransport();
    staleTransport.listAgentConversations = vi.fn(() => staleGate.promise);
    const staleReportError = vi.fn();
    const { instance, renderView } = await renderAgent({
      transport: staleTransport,
      reportError: staleReportError,
    });

    const currentConversation = makeConversation({
      conversation_id: "agent-conversation:current",
      project_root: "/projects/current",
      title: "Current activation",
      turn_count: 0,
      status: "idle",
      latest_turn_id: null,
      terminal_reason: null,
    });
    const currentTransport = createMockUiKernelTransport();
    currentTransport.listAgentConversations = vi.fn(async () => [currentConversation]);
    currentTransport.listAgentTurns = vi.fn(async () => []);
    const currentReportError = vi.fn();
    await renderView({
      instance: {
        ...instance,
        project_id: "project:current",
        activation_generation: instance.activation_generation + 1,
      },
      transport: currentTransport,
      reportError: currentReportError,
    });

    await act(async () => {
      staleGate.reject(new Error("late activation A failure"));
      await settle();
    });
    expect(staleReportError).not.toHaveBeenCalled();
    expect(currentReportError).not.toHaveBeenCalled();
  });

  it("persists explicit picker selection before adoption, suppresses its stale refresh, and recovers after failure", async () => {
    const selectedConversation = makeConversation({
      conversation_id: "agent-conversation:selected",
      title: "Selected conversation",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    const recoveryConversation = makeConversation({
      conversation_id: "agent-conversation:recovery",
      title: "Recovery conversation",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    const staleRefresh = deferred<readonly AgentConversationSummary[]>();
    const transport = createMockUiKernelTransport();
    let listCall = 0;
    transport.listAgentConversations = vi.fn(() => {
      listCall += 1;
      if (listCall === 2) return staleRefresh.promise;
      return Promise.resolve([selectedConversation, recoveryConversation]);
    });
    transport.listAgentTurns = vi.fn(async () => []);
    let invalidate: (() => void) | null = null;
    transport.subscribeAgentInvalidated = vi.fn((listener) => {
      invalidate = listener;
      return () => undefined;
    });
    const firstPersist = deferred<void>();
    let persistCall = 0;
    const persist = vi.fn(() => {
      persistCall += 1;
      if (persistCall === 1) return firstPersist.promise;
      if (persistCall === 2) return Promise.reject(new Error("explicit selection stale"));
      return Promise.resolve();
    });
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
        conversation_id: recoveryConversation.conversation_id,
        mode: "ask",
        composer: "",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const { container, reportError } = await renderAgent({ instance, persist, transport });
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;

    await act(async () => {
      invalidate?.();
      await vi.waitFor(() => expect(listCall).toBe(2));
    });
    await selectInput(picker, selectedConversation.conversation_id);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
      conversation_id: selectedConversation.conversation_id,
    }));
    expect(picker.value).toBe(recoveryConversation.conversation_id);

    await act(async () => {
      firstPersist.resolve();
      await settle();
    });
    expect(picker.value).toBe(selectedConversation.conversation_id);
    await act(async () => {
      staleRefresh.reject(new Error("late refresh superseded by explicit selection"));
      await settle();
    });
    expect(picker.value).toBe(selectedConversation.conversation_id);
    expect(reportError).not.toHaveBeenCalled();

    await selectInput(picker, recoveryConversation.conversation_id);
    expect(picker.value).toBe(selectedConversation.conversation_id);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenLastCalledWith(expect.objectContaining({
      message: "explicit selection stale",
    }));

    await selectInput(picker, recoveryConversation.conversation_id);
    expect(picker.value).toBe(recoveryConversation.conversation_id);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledTimes(1);

    await selectInput(picker, "");
    expect(picker.value).toBe("");
    expect(persist).toHaveBeenCalledTimes(4);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ conversation_id: null }));
  });

  it("blocks stale view snapshots while an explicit conversation selection is pending", async () => {
    const oldConversation = makeConversation({
      conversation_id: "agent-conversation:selection-old",
      title: "Old selection",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    const selectedConversation = makeConversation({
      conversation_id: "agent-conversation:selection-new",
      title: "New selection",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    const transport = createMockUiKernelTransport();
    transport.listAgentConversations = vi.fn(async () => [oldConversation, selectedConversation]);
    transport.listAgentTurns = vi.fn(async () => []);
    const createAgentConversation = vi.spyOn(transport, "createAgentConversation");
    const persistGate = deferred<void>();
    const persist = vi.fn(() => persistGate.promise);
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
        conversation_id: oldConversation.conversation_id,
        mode: "act",
        composer: "",
        auto_approve: true,
      },
      lifecycle_state: "active",
    };
    const { container } = await renderAgent({ instance, persist, transport });
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;
    const plan = [...container.querySelectorAll<HTMLButtonElement>('.rho-agent-mode button')]
      .find((button) => button.textContent === "plan")!;
    const autoApprove = container.querySelector<HTMLInputElement>(".rho-agent-auto-approve input")!;
    const suggestion = container.querySelector<HTMLButtonElement>(".rho-agent-suggestions button")!;
    const newButton = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
      .find((button) => button.textContent === "New")!;
    const pickerValueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;

    await act(async () => {
      pickerValueSetter.call(picker, selectedConversation.conversation_id);
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      newButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      autoApprove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      suggestion.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });

    expect(persist).toHaveBeenCalledOnce();
    expect(createAgentConversation).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: selectedConversation.conversation_id,
      mode: "act",
      auto_approve: true,
    }));
    expect(plan.disabled).toBe(true);
    expect(autoApprove.disabled).toBe(true);
    expect(suggestion.disabled).toBe(true);

    await act(async () => {
      persistGate.resolve();
      await settle();
    });

    expect(picker.value).toBe(selectedConversation.conversation_id);
    expect(container.querySelector<HTMLButtonElement>('.rho-agent-mode button[aria-pressed="true"]')!.textContent)
      .toBe("act");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("blocks stale mode and file-decision snapshots while New is pending", async () => {
    const transport = createMockUiKernelTransport();
    const oldConversation = (await transport.listAgentConversations())[0]!;
    const createdConversation = makeConversation({
      conversation_id: "agent-conversation:new-workflow-target",
      title: "New workflow target",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    let conversations: readonly AgentConversationSummary[] = [oldConversation];
    transport.listAgentConversations = vi.fn(async () => conversations);
    const createGate = deferred<AgentSurfaceViewState>();
    const createConversation = vi.fn(() => createGate.promise);
    const runConversation = vi.fn(async (current: AgentSurfaceViewState) => current);
    const persist = vi.fn(async () => undefined);
    const { container } = await renderAgent({ createConversation, persist, runConversation, transport });
    const newButton = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
      .find((button) => button.textContent === "New")!;
    const plan = [...container.querySelectorAll<HTMLButtonElement>('.rho-agent-mode button')]
      .find((button) => button.textContent === "plan")!;
    const reject = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-file-proposal button")]
      .find((button) => button.textContent === "Reject")!;
    const textarea = container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
    await typeInput(textarea, "Do not admit Send while New is pending");
    const send = container.querySelector<HTMLButtonElement>(
      ".rho-agent-context-controls .rho-primary-action",
    )!;

    await act(async () => {
      newButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      newButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      reject.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });

    expect(createConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: oldConversation.conversation_id,
      mode: "ask",
    }));
    expect(createConversation).toHaveBeenCalledOnce();
    expect(runConversation).not.toHaveBeenCalled();
    expect(plan.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    conversations = [createdConversation, oldConversation];
    await act(async () => {
      createGate.resolve({
        conversation_id: createdConversation.conversation_id,
        mode: "ask",
        composer: "",
        auto_approve: false,
        file_decisions: {},
      });
      await settle();
    });

    expect(container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!.value).toBe(createdConversation.conversation_id);
    expect(container.querySelector<HTMLButtonElement>('.rho-agent-mode button[aria-pressed="true"]')!.textContent)
      .toBe("ask");
    expect(persist).not.toHaveBeenCalled();
  });

  it("blocks a stale mode snapshot while Send is pending", async () => {
    const transport = createMockUiKernelTransport();
    const oldConversation = makeConversation({
      conversation_id: "agent-conversation:send-workflow-old",
      title: "Send workflow old",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    const sentConversation = makeConversation({
      conversation_id: "agent-conversation:send-workflow-target",
      title: "Send workflow target",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    let conversations: readonly AgentConversationSummary[] = [oldConversation];
    transport.listAgentConversations = vi.fn(async () => conversations);
    transport.listAgentTurns = vi.fn(async () => []);
    const runGate = deferred<AgentSurfaceViewState>();
    const runConversation = vi.fn(() => runGate.promise);
    const createConversation = vi.fn(async (current: AgentSurfaceViewState) => current);
    const persist = vi.fn(async () => undefined);
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
        conversation_id: oldConversation.conversation_id,
        mode: "ask",
        composer: "Send without restoring the old identity",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const { container } = await renderAgent({ createConversation, instance, persist, runConversation, transport });
    const send = container.querySelector<HTMLButtonElement>(
      ".rho-agent-context-controls .rho-primary-action",
    )!;
    const plan = [...container.querySelectorAll<HTMLButtonElement>('.rho-agent-mode button')]
      .find((button) => button.textContent === "plan")!;
    const newButton = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
      .find((button) => button.textContent === "New")!;

    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      newButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });

    expect(runConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: oldConversation.conversation_id,
      mode: "ask",
    }), expect.objectContaining({
      conversation_id: oldConversation.conversation_id,
      mode: "ask",
    }));
    expect(runConversation).toHaveBeenCalledOnce();
    expect(createConversation).not.toHaveBeenCalled();
    expect(plan.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    conversations = [sentConversation, oldConversation];
    await act(async () => {
      runGate.resolve({
        conversation_id: sentConversation.conversation_id,
        mode: "ask",
        composer: "",
        auto_approve: false,
        file_decisions: {},
      });
      await settle();
    });

    expect(container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!.value).toBe(sentConversation.conversation_id);
    expect(container.querySelector<HTMLButtonElement>('.rho-agent-mode button[aria-pressed="true"]')!.textContent)
      .toBe("ask");
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps a deferred New action live across an unrelated same-activation callback rerender", async () => {
    const sharedConversation = makeConversation({
      conversation_id: "agent-conversation:mock-shared",
      title: "Shared conversation",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    const createdConversation = makeConversation({
      conversation_id: "agent-conversation:created-during-rerender",
      title: "Created during rerender",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    let conversations = [sharedConversation];
    const createGate = deferred<AgentConversationSummary>();
    const transport = createMockUiKernelTransport();
    transport.listAgentConversations = vi.fn(async () => conversations);
    transport.listAgentTurns = vi.fn(async () => []);
    transport.createAgentConversation = vi.fn(() => createGate.promise);
    const {
      container,
      persist: actionPersist,
      renderView,
      reportError: actionReportError,
    } = await renderAgent({ transport });

    const newButton = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
      .find((button) => button.textContent === "New")!;
    await click(newButton);
    expect(newButton.disabled).toBe(true);

    const rerenderPersist = vi.fn(async () => undefined);
    const rerenderReportError = vi.fn();
    await renderView({ persist: rerenderPersist, reportError: rerenderReportError });
    expect(container.querySelector<HTMLButtonElement>(".rho-agent-toolbar-action")!.disabled).toBe(true);

    conversations = [createdConversation, sharedConversation];
    await act(async () => {
      createGate.resolve(createdConversation);
      await settle();
    });

    const currentNewButton = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
      .find((button) => button.textContent === "New")!;
    expect(currentNewButton.disabled).toBe(false);
    expect(container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!.value).toBe(createdConversation.conversation_id);
    expect(actionPersist).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: createdConversation.conversation_id,
    }));
    expect(actionReportError).not.toHaveBeenCalled();
    expect(rerenderReportError).not.toHaveBeenCalled();
  });

  it("suppresses a rejected synchronous create invalidation after adopting the created conversation", async () => {
    const sharedConversation = makeConversation({
      conversation_id: "agent-conversation:mock-shared",
      title: "Shared conversation",
      turn_count: 0,
      status: "idle",
      terminal_reason: null,
    });
    const transport = createMockUiKernelTransport();
    const listConversations = transport.listAgentConversations.bind(transport);
    const staleRefresh = deferred<readonly AgentConversationSummary[]>();
    let listCall = 0;
    transport.listAgentConversations = vi.fn(async (limit = 50) => {
      listCall += 1;
      if (listCall === 1) return [sharedConversation];
      if (listCall === 2) return staleRefresh.promise;
      return listConversations(limit);
    });
    transport.listAgentTurns = vi.fn(async () => []);
    const { container, persist, reportError } = await renderAgent({ transport });
    const newButton = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
      .find((button) => button.textContent === "New")!;

    await click(newButton);
    await act(async () => {
      await vi.waitFor(() => expect(listCall).toBeGreaterThanOrEqual(3));
    });
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;
    const createdConversationId = picker.value;
    expect(createdConversationId).toMatch(/^agent-conversation:mock-/u);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
      conversation_id: createdConversationId,
    }));

    await act(async () => {
      staleRefresh.reject(new Error("late refresh superseded by New"));
      await settle();
    });
    expect(picker.value).toBe(createdConversationId);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not fallback-select a synchronously invalidated conversation when composite persistence fails", async () => {
    const transport = createMockUiKernelTransport();
    const listConversations = transport.listAgentConversations.bind(transport);
    let listCall = 0;
    transport.listAgentConversations = vi.fn(async (limit = 50) => {
      listCall += 1;
      return listCall === 1 ? [] : listConversations(limit);
    });
    transport.listAgentTurns = vi.fn(async () => []);
    const persist = vi.fn(async () => {
      throw new Error("exact Agent selection persist rejected");
    });
    const instance: SurfaceInstance = {
      instance_id: "surface-instance:agent-test",
      surface_id: "rho.agent",
      project_id: (await transport.loadSurfaces()).project_id,
      origin: { kind: "application", component_id: "rho.agent" },
      activation_generation: 1,
      surface_revision: 1,
      mode_id: "conversation",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: {
        conversation_id: null,
        mode: "ask",
        composer: "",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const { container, reportError } = await renderAgent({ instance, persist, transport });

    await click([...container.querySelectorAll<HTMLButtonElement>(".rho-agent-toolbar-action")]
      .find((button) => button.textContent === "New")!);
    await act(async () => { await settle(); });
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;
    expect(picker.value).toBe("");
    expect([...picker.options].some((option) => option.value.startsWith("agent-conversation:mock-")))
      .toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: "exact Agent selection persist rejected",
    }));
  });

  it("keeps an empty host unselected when an external create invalidates its read projection", async () => {
    const transport = createMockUiKernelTransport();
    const listConversations = transport.listAgentConversations.bind(transport);
    let listCall = 0;
    transport.listAgentConversations = vi.fn(async (limit = 50) => {
      listCall += 1;
      return listCall === 1 ? [] : listConversations(limit);
    });
    transport.listAgentTurns = vi.fn(async () => []);
    const persist = vi.fn(async () => undefined);
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
        conversation_id: null,
        mode: "ask",
        composer: "",
        auto_approve: false,
      },
      lifecycle_state: "active",
    };
    const { container, reportError } = await renderAgent({ instance, persist, transport });

    const created = await transport.createAgentConversation();
    await act(async () => { await settle(); });
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Conversation for surface-instance:agent-test"]',
    )!;
    expect([...picker.options].map((option) => option.value)).toContain(created.conversation_id);
    expect(picker.value).toBe("");
    expect(persist).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("shows degraded diagnostics and admits runtime retry only once", async () => {
    const transport = createMockUiKernelTransport();
    const diagnosticsResult = await transport.getAgentRuntimeDiagnostics();
    const retryGate = deferred<typeof diagnosticsResult>();
    const retryAgentRuntime = vi.fn(() => retryGate.promise);
    transport.retryAgentRuntime = retryAgentRuntime;
    const { container, persist } = await renderAgent({
      health: { state: "needs_attention", label: "Agent dependencies need attention", detail: "aisdk is incompatible." },
      transport,
    });
    const banner = container.querySelector(".rho-agent-degraded")!;
    expect(banner.textContent).toContain("Agent dependencies need attention");
    expect(banner.textContent).toContain("aisdk is incompatible.");
    const retry = [...banner.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Retry Agent runtime")!;
    const diagnostics = banner.querySelector<HTMLDetailsElement>(".rho-agent-runtime-diagnostics")!;
    expect(diagnostics.querySelector("summary")!.textContent).toBe("Dependency details");
    expect(diagnostics.querySelector("pre")!.textContent).toContain("aisdk");
    const send = container.querySelector<HTMLButtonElement>(".rho-agent-context-controls .rho-primary-action")!;
    expect(send.disabled).toBe(true);
    const plan = [...container.querySelectorAll<HTMLButtonElement>('.rho-agent-mode button')]
      .find((button) => button.textContent === "plan")!;
    const reject = [...container.querySelectorAll<HTMLButtonElement>(".rho-agent-file-proposal button")]
      .find((button) => button.textContent === "Reject")!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      plan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      reject.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(retryAgentRuntime).toHaveBeenCalledOnce();
    expect(retry.disabled).toBe(true);
    expect(plan.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    await act(async () => {
      retryGate.resolve(diagnosticsResult);
      await settle();
    });
    expect(persist).not.toHaveBeenCalled();
  });
});
