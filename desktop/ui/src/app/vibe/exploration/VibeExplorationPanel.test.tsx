import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentConversationSummary,
  AgentTurnDetail,
  AgentTurnEvent,
  AgentTurnSummary,
} from "../../../transport";
import {
  VibeExplorationPanel,
  type VibeExplorationPanelProps,
  type VibeExplorationTransport,
} from "./VibeExplorationPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-08-27T10:00:00Z";

function conversation(
  overrides: Partial<AgentConversationSummary> = {},
): AgentConversationSummary {
  return {
    conversation_id: "conversation:one",
    project_root: "/projects/rho",
    title: "Compare cluster 3 and cluster 7",
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    legacy_unthreaded: false,
    turn_count: 1,
    status: "completed",
    latest_turn_id: "turn:one",
    latest_mode: "act",
    latest_prompt_preview: "Use donor-aware analysis.",
    terminal_reason: null,
    pending_request_id: null,
    ...overrides,
  };
}

function turn(overrides: Partial<AgentTurnSummary> = {}): AgentTurnSummary {
  return {
    turn_id: "turn:one",
    conversation_id: "conversation:one",
    project_root: "/projects/rho",
    mode: "act",
    status: "completed",
    started_at: NOW,
    finished_at: NOW,
    prompt_preview: "Use donor-aware analysis.",
    model: "provider/private-model",
    workspace_id_before: "workspace:one",
    state_revision_before: 4,
    project_revision_before: 7,
    workspace_id_after: "workspace:one",
    state_revision_after: 5,
    project_revision_after: 8,
    final_message: "The recorded Agent run finished.",
    error_message: null,
    pending_request_id: null,
    retry_of_turn_id: null,
    terminal_reason: null,
    ...overrides,
  };
}

function event(
  id: number,
  eventType: string,
  overrides: Partial<AgentTurnEvent> = {},
): AgentTurnEvent {
  return {
    id,
    turn_id: "turn:one",
    timestamp: NOW,
    event_type: eventType,
    title: `Event ${id}`,
    body: `Public activity ${id}`,
    status: "completed",
    tool: null,
    request_id: null,
    code: null,
    details_json: JSON.stringify({ hidden_reasoning: `secret-${id}` }),
    ...overrides,
  };
}

function detail(
  summary: AgentTurnSummary,
  events: readonly AgentTurnEvent[] = [],
): AgentTurnDetail {
  return {
    turn: summary,
    events,
    approvals: [],
    context_items: [],
  };
}

interface MutableTransportState {
  conversations: readonly AgentConversationSummary[];
  turns: Map<string, readonly AgentTurnSummary[]>;
  details: Map<string, AgentTurnDetail | null>;
  listFailure: Error | null;
  onCancel: ((turnId: string) => void) | null;
  onRetry: ((turnId: string) => {
    readonly conversationId: string;
    readonly turnId: string;
  }) | null;
}

function createTransport(initial: {
  readonly conversations?: readonly AgentConversationSummary[];
  readonly turns?: readonly AgentTurnSummary[];
  readonly details?: readonly AgentTurnDetail[];
} = {}) {
  const conversations = initial.conversations ?? [];
  const turns = initial.turns ?? [];
  const state: MutableTransportState = {
    conversations,
    turns: new Map(turns.length === 0
      ? []
      : [[turns[0]!.conversation_id, turns]]),
    details: new Map((initial.details ?? []).map((item) => [item.turn.turn_id, item])),
    listFailure: null,
    onCancel: null,
    onRetry: null,
  };
  const listeners = new Set<() => void>();
  const transport: VibeExplorationTransport = {
    listAgentConversations: vi.fn(async () => {
      if (state.listFailure != null) throw state.listFailure;
      return state.conversations;
    }),
    listAgentTurns: vi.fn(async (conversationId) => (
      conversationId == null ? [] : state.turns.get(conversationId) ?? []
    )),
    getAgentTurnDetail: vi.fn(async (turnId) => state.details.get(turnId) ?? null),
    cancelAgentTurn: vi.fn(async (turnId: string) => {
      state.onCancel?.(turnId);
      return { status: "cancelled" as const, turn_id: turnId };
    }),
    retryAgentTurn: vi.fn(async (turnId: string) => {
      const next = state.onRetry?.(turnId) ?? {
        conversationId: state.conversations[0]?.conversation_id ?? "conversation:retry",
        turnId: "turn:retry",
      };
      return {
        status: "started" as const,
        turn_id: next.turnId,
        conversation_id: next.conversationId,
        retry_of_turn_id: turnId,
        auto_approve: false,
        task_kind: "agent_turn",
      };
    }),
    subscribeAgentInvalidated: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    emitInvalidated() {
      for (const listener of [...listeners]) listener();
    },
    state,
    transport,
  };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (button == null) throw new Error(`Button not found: ${label}`);
  return button;
}

describe("Vibe autonomous exploration panel", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function baseProps(
    transport: VibeExplorationTransport,
    overrides: Partial<VibeExplorationPanelProps> = {},
  ): VibeExplorationPanelProps {
    return {
      projectId: "project:one",
      presentation: "overview",
      selection: { conversationId: null, turnId: null },
      exactRefs: { conversationIds: [], taskIds: [] },
      transport,
      onSelectionChange: vi.fn(),
      onCompose: vi.fn(),
      onOpenAgent: vi.fn(),
      onError: vi.fn(),
      ...overrides,
    };
  }

  function mount(props: VibeExplorationPanelProps) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<VibeExplorationPanel {...props} />));
    return { container, root };
  }

  it("shows loading and an honest empty state while applying the bounded conversation query", async () => {
    const pending = deferred<readonly AgentConversationSummary[]>();
    const transport = createTransport().transport;
    transport.listAgentConversations = vi.fn(() => pending.promise);
    const onCompose = vi.fn();
    const props = baseProps(transport, { onCompose });
    const { container } = mount(props);

    expect(container.textContent).toContain("正在读取最近的 Agent 工作");
    await act(async () => {
      pending.resolve([]);
      await settle();
    });

    expect(transport.listAgentConversations).toHaveBeenCalledWith(50);
    expect(container.textContent).toContain("尚无自主探索");
    expect(container.querySelectorAll("[role='tab']")).toHaveLength(0);
    act(() => findButton(container, "开始探索").click());
    expect(onCompose).toHaveBeenCalledWith({ conversationId: null, turnId: null });
  });

  it("renders only durable public Agent truth and stops the exact running Turn", async () => {
    const runningConversation = conversation({ status: "running" });
    const runningTurn = turn({ status: "running", finished_at: null, final_message: null });
    const publicEvent = event(2, "tool.call_started", {
      title: "Run donor aggregation",
      body: "The recorded tool call started.",
      code: "aggregate_by_donor()",
    });
    const ignoredEvent = event(1, "agent.plugin_context", {
      title: "Invented scientific route",
      body: "Candidate observation",
    });
    const harness = createTransport({
      conversations: [runningConversation],
      turns: [runningTurn],
      details: [detail(runningTurn, [ignoredEvent, publicEvent])],
    });
    harness.state.onCancel = () => {
      const cancelledTurn = turn({
        status: "interrupted",
        terminal_reason: "user_cancelled",
        error_message: "Stopped by the user.",
      });
      harness.state.conversations = [conversation({
        status: "interrupted",
        terminal_reason: "user_cancelled",
      })];
      harness.state.turns.set("conversation:one", [cancelledTurn]);
      harness.state.details.set("turn:one", detail(cancelledTurn, [publicEvent]));
    };
    const props = baseProps(harness.transport, {
      selection: { conversationId: "conversation:one", turnId: "turn:one" },
    });
    const { container } = mount(props);
    await act(settle);

    expect(container.textContent).toContain("Run donor aggregation");
    expect(container.textContent).toContain("尚未与当前手稿内容建立精确对应");
    expect(container.textContent).not.toContain("Invented scientific route");
    expect(container.textContent).not.toContain("Candidate observation");
    expect(container.textContent).not.toContain("secret-2");
    expect(container.textContent).not.toContain("aggregate_by_donor");
    expect(container.textContent).not.toContain("provider/private-model");

    await act(async () => {
      findButton(container, "停止探索").click();
      await settle();
    });
    expect(harness.transport.cancelAgentTurn).toHaveBeenCalledWith("turn:one");
    expect(container.textContent).toContain("已取消");
    expect(container.textContent).toContain("探索已取消");
  });

  it("reports a stop failure without losing durable truth and permits recovery", async () => {
    const runningConversation = conversation({ status: "running" });
    const runningTurn = turn({ status: "running", finished_at: null, final_message: null });
    const harness = createTransport({
      conversations: [runningConversation],
      turns: [runningTurn],
      details: [detail(runningTurn)],
    });
    const cancel = vi.fn(async (turnId: string) => ({
      status: "cancelled" as const,
      turn_id: turnId,
    }));
    cancel.mockRejectedValueOnce(new Error("stop temporarily unavailable"));
    harness.transport.cancelAgentTurn = cancel;
    const onError = vi.fn();
    const { container } = mount(baseProps(harness.transport, { onError }));
    await act(settle);

    await act(async () => {
      findButton(container, "停止探索").click();
      await settle();
    });
    expect(container.textContent).toContain("stop temporarily unavailable");
    expect(findButton(container, "停止探索").disabled).toBe(false);
    expect(onError).toHaveBeenCalled();

    await act(async () => {
      findButton(container, "停止探索").click();
      await settle();
    });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("stop temporarily unavailable");
  });

  it("shows waiting attention and marks a manuscript relationship only for exact identifiers", async () => {
    const waitingConversation = conversation({
      status: "waiting",
      pending_request_id: "approval:one",
    });
    const waitingTurn = turn({
      status: "waiting",
      finished_at: null,
      final_message: null,
      pending_request_id: "approval:one",
    });
    const harness = createTransport({
      conversations: [waitingConversation],
      turns: [waitingTurn],
      details: [detail(waitingTurn)],
    });
    const { container } = mount(baseProps(harness.transport, {
      exactRefs: { conversationIds: [], taskIds: ["turn:one"] },
    }));
    await act(settle);

    expect(container.textContent).toContain("等待你处理");
    expect(container.textContent).toContain("来自手稿中的精确引用");
    expect(container.textContent).toContain("授权与敏感操作仍在完整 Agent 界面中处理");
  });

  it("retries the exact failed Turn and adopts the returned durable identity", async () => {
    const failedConversation = conversation({ status: "failed", terminal_reason: "agent_failure" });
    const failedTurn = turn({
      status: "failed",
      terminal_reason: "agent_failure",
      final_message: null,
      error_message: "Recorded execution failed.",
    });
    const harness = createTransport({
      conversations: [failedConversation],
      turns: [failedTurn],
      details: [detail(failedTurn)],
    });
    harness.state.onRetry = () => {
      const retryTurn = turn({
        turn_id: "turn:retry",
        status: "running",
        finished_at: null,
        final_message: null,
        error_message: null,
        retry_of_turn_id: "turn:one",
      });
      harness.state.conversations = [conversation({
        status: "running",
        latest_turn_id: "turn:retry",
        turn_count: 2,
      })];
      harness.state.turns.set("conversation:one", [retryTurn, failedTurn]);
      harness.state.details.set("turn:retry", detail(retryTurn));
      return { conversationId: "conversation:one", turnId: "turn:retry" };
    };
    const onSelectionChange = vi.fn();
    const { container } = mount(baseProps(harness.transport, {
      selection: { conversationId: "conversation:one", turnId: "turn:one" },
      onSelectionChange,
    }));
    await act(settle);

    expect(container.textContent).toContain("Recorded execution failed");
    await act(async () => {
      findButton(container, "重试").click();
      await settle();
    });

    expect(harness.transport.retryAgentTurn).toHaveBeenCalledWith("turn:one");
    expect(onSelectionChange).toHaveBeenCalledWith({
      conversationId: "conversation:one",
      turnId: "turn:retry",
    });
    expect(container.textContent).toContain("这是一次精确记录的重试");
    expect(container.textContent).toContain("探索中");
  });

  it("keeps focused public activity disclosure separate from overview", async () => {
    const summary = turn();
    const harness = createTransport({
      conversations: [conversation()],
      turns: [summary],
      details: [detail(summary, [event(1, "tool.call_completed", {
        title: "Recorded command completed",
        code: "verified_public_command()",
      })])],
    });
    const props = baseProps(harness.transport);
    const { container, root } = mount(props);
    await act(settle);
    expect(container.textContent).not.toContain("查看执行代码");

    await act(async () => {
      root.render(<VibeExplorationPanel {...props} presentation="focused" />);
      await settle();
    });
    expect(container.textContent).toContain("公开执行记录 · 1");
    expect(container.textContent).toContain("查看执行代码");
    expect(container.textContent).toContain("verified_public_command");
    expect(container.textContent).not.toContain("secret-1");
  });

  it("preserves prior truth with an explicit stale marker when invalidation refresh fails", async () => {
    const summary = turn();
    const harness = createTransport({
      conversations: [conversation()],
      turns: [summary],
      details: [detail(summary)],
    });
    const onError = vi.fn();
    const { container } = mount(baseProps(harness.transport, { onError }));
    await act(settle);
    expect(container.textContent).toContain("Compare cluster 3 and cluster 7");

    harness.state.listFailure = new Error("refresh unavailable");
    await act(async () => {
      harness.emitInvalidated();
      await settle();
    });

    expect(container.textContent).toContain("Compare cluster 3 and cluster 7");
    expect(container.textContent).toContain("记录可能不是最新");
    expect(container.textContent).toContain("refresh unavailable");
    expect(onError).toHaveBeenCalled();
  });

  it("defensively bounds conversations, Turns, and detail reads", async () => {
    const conversations = Array.from({ length: 55 }, (_, index) => conversation({
      conversation_id: `conversation:${index}`,
      title: `Recorded exploration ${index}`,
      latest_turn_id: index === 0 ? "turn:0" : null,
      turn_count: index === 0 ? 55 : 0,
    }));
    const turns = Array.from({ length: 55 }, (_, index) => turn({
      turn_id: `turn:${index}`,
      conversation_id: "conversation:0",
      prompt_preview: `Recorded task ${index}`,
    }));
    const harness = createTransport({ conversations, turns });
    const { container } = mount(baseProps(harness.transport, { presentation: "focused" }));
    await act(settle);

    expect(container.querySelectorAll("button[data-exploration-conversation]")).toHaveLength(50);
    expect(container.querySelectorAll("[aria-label='最近 Turn 记录'] button")).toHaveLength(50);
    expect(harness.transport.listAgentTurns).toHaveBeenCalledWith("conversation:0", 50);
    expect(harness.transport.getAgentTurnDetail).toHaveBeenCalledTimes(20);
  });

  it("rejects late results from the previous project epoch", async () => {
    const first = deferred<readonly AgentConversationSummary[]>();
    const second = deferred<readonly AgentConversationSummary[]>();
    let calls = 0;
    const harness = createTransport();
    harness.transport.listAgentConversations = vi.fn(() => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    });
    const props = baseProps(harness.transport, { projectId: "project:old" });
    const { container, root } = mount(props);

    act(() => root.render(<VibeExplorationPanel {...props} projectId="project:new" />));
    const newConversation = conversation({
      conversation_id: "conversation:new",
      title: "New project exploration",
      latest_turn_id: null,
      turn_count: 0,
    });
    await act(async () => {
      second.resolve([newConversation]);
      await settle();
    });
    expect(container.textContent).toContain("New project exploration");

    await act(async () => {
      first.resolve([conversation({ title: "Old project must not return" })]);
      await settle();
    });
    expect(container.textContent).toContain("New project exploration");
    expect(container.textContent).not.toContain("Old project must not return");
  });

  it("supports roving keyboard focus without changing selection until activation", async () => {
    const firstConversation = conversation();
    const secondConversation = conversation({
      conversation_id: "conversation:two",
      title: "Inspect batch sensitivity",
      latest_turn_id: null,
      turn_count: 0,
    });
    const summary = turn();
    const harness = createTransport({
      conversations: [firstConversation, secondConversation],
      turns: [summary],
      details: [detail(summary)],
    });
    harness.state.turns.set("conversation:two", []);
    const onSelectionChange = vi.fn();
    const { container } = mount(baseProps(harness.transport, { onSelectionChange }));
    await act(settle);
    onSelectionChange.mockClear();

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(
      "button[data-exploration-conversation]",
    )];
    expect(buttons).toHaveLength(2);
    buttons[0]!.focus();
    act(() => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "ArrowDown",
    })));
    expect(document.activeElement).toBe(buttons[1]);
    expect(onSelectionChange).not.toHaveBeenCalled();

    await act(async () => {
      buttons[1]!.click();
      await settle();
    });
    expect(onSelectionChange).toHaveBeenCalledWith({
      conversationId: "conversation:two",
      turnId: null,
    });
    expect(harness.transport.listAgentTurns).toHaveBeenLastCalledWith("conversation:two", 50);
  });

  it("preserves an unresolved exact selection instead of falling back to recent work", async () => {
    const recentTurn = turn();
    const harness = createTransport({
      conversations: [conversation()],
      turns: [recentTurn],
      details: [detail(recentTurn)],
    });
    const unresolved: VibeExplorationPanelProps["selection"] = {
      conversationId: "conversation:missing",
      turnId: "turn:missing",
    };
    const onSelectionChange = vi.fn();
    const { container } = mount(baseProps(harness.transport, {
      selection: unresolved,
      exactRefs: {
        conversationIds: ["conversation:missing"],
        taskIds: ["turn:missing"],
      },
      onSelectionChange,
    }));
    await act(settle);

    expect(container.textContent).toContain("选中的探索记录已不可用");
    expect(container.textContent).not.toContain("来自手稿中的精确引用");
    expect(harness.transport.listAgentTurns).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});
