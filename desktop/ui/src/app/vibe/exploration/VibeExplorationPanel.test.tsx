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
    latest_prompt_preview: "Use donor-aware analysis.",
    terminal_reason: null,
    ...overrides,
  };
}

function turn(overrides: Partial<AgentTurnSummary> = {}): AgentTurnSummary {
  return {
    turn_id: "turn:one",
    conversation_id: "conversation:one",
    project_root: "/projects/rho",
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
  };
}

interface MutableTransportState {
  conversations: readonly AgentConversationSummary[];
  turns: Map<string, readonly AgentTurnSummary[]>;
  details: Map<string, AgentTurnDetail | null>;
  listFailure: Error | null;
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
      projectRoot: "/projects/rho",
      pageId: "page:one",
      presentation: "overview",
      selection: { conversationId: null, turnId: null },
      exactRefs: { conversationIds: [], taskIds: [] },
      transport,
      onSelectionChange: vi.fn(),
      onOpenHost: vi.fn(),
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
    const onOpenHost = vi.fn();
    const props = baseProps(transport, { onCompose, onOpenHost });
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
    expect(onOpenHost).toHaveBeenCalledOnce();
    expect(onCompose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("还没有 Agent 记录");
    expect(container.textContent).toContain("在 Studio 中发起探索");
    expect(container.textContent).not.toContain("开始探索");
    act(() => findButton(container, "在 Studio 中发起探索").click());
    expect(onCompose).toHaveBeenCalledWith({ conversationId: null, turnId: null });
  });

  it("renders only durable public Agent truth without exposing Agent mutation controls", async () => {
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
    expect(container.textContent).not.toContain("停止探索");
    expect(container.textContent).not.toContain("重试");
  });

  it("opens the complete public Agent record inside Vibe and enters Studio only from an explicit secondary action", async () => {
    const summary = turn();
    const publicEvent = event(2, "tool.call_completed", {
      title: "Donor-aware aggregation completed",
      body: "The public execution record is available.",
      code: "aggregate_by_donor()",
    });
    const ignoredEvent = event(1, "agent.plugin_context", {
      title: "Private plugin context",
      body: "Must not render",
    });
    const harness = createTransport({
      conversations: [conversation()],
      turns: [summary],
      details: [detail(summary, [ignoredEvent, publicEvent])],
    });
    const onOpenHost = vi.fn();
    const onCompose = vi.fn();
    const onOpenAgent = vi.fn();
    const { container } = mount(baseProps(harness.transport, {
      onOpenHost,
      onCompose,
      onOpenAgent,
    }));
    await act(settle);

    act(() => findButton(container, "在 Vibe 中查看 Agent 记录").click());

    expect(onOpenHost).toHaveBeenCalledOnce();
    expect(onCompose).not.toHaveBeenCalled();
    expect(onOpenAgent).not.toHaveBeenCalled();
    const host = container.querySelector<HTMLElement>(".rho-vibe-agent-record-host");
    const heading = host?.querySelector<HTMLHeadingElement>("h3");
    expect(host).not.toBeNull();
    expect(heading?.textContent).toContain("Compare cluster 3 and cluster 7");
    expect(document.activeElement).toBe(heading);
    expect(host?.textContent).toContain("Donor-aware aggregation completed");
    expect(host?.textContent).toContain("查看执行代码");
    expect(host?.textContent).not.toContain("Private plugin context");
    expect(host?.textContent).not.toContain("Must not render");
    expect(host?.textContent).not.toContain("secret-2");
    expect(host?.querySelector("textarea, .rho-agent-approval, .rho-agent-file-proposal"))
      .toBeNull();
    const trustedAgentActions = [
      "Approve",
      "Reject",
      "Apply",
      "Undo applied edit",
      "Stop",
      "Retry",
      "Context",
      "Send",
    ];
    const hostButtons = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .map((button) => button.textContent?.trim() ?? "");
    for (const trustedAction of trustedAgentActions) {
      expect(hostButtons).not.toContain(trustedAction);
    }
    const hostLabels = [...(host?.querySelectorAll<HTMLLabelElement>("label") ?? [])]
      .map((label) => label.textContent?.trim() ?? "");
    expect(hostLabels).not.toContain("Auto-approve project tools for this conversation");

    act(() => findButton(container, "在 Studio 中深入检查").click());
    expect(onOpenAgent).toHaveBeenCalledWith({
      conversationId: "conversation:one",
      turnId: "turn:one",
    });
    expect(onCompose).not.toHaveBeenCalled();
  });

  it("keeps the host open while navigating Turns and sends the exact current Turn to Studio", async () => {
    const firstTurn = turn({ turn_id: "turn:one", prompt_preview: "First recorded task" });
    const secondTurn = turn({ turn_id: "turn:two", prompt_preview: "Second recorded task" });
    const harness = createTransport({
      conversations: [conversation({ turn_count: 2 })],
      turns: [firstTurn, secondTurn],
      details: [detail(firstTurn), detail(secondTurn)],
    });
    const onSelectionChange = vi.fn();
    const onOpenAgent = vi.fn();
    const { container } = mount(baseProps(harness.transport, {
      presentation: "focused",
      selection: { conversationId: "conversation:one", turnId: "turn:one" },
      onSelectionChange,
      onOpenAgent,
    }));
    await act(settle);

    act(() => findButton(container, "在 Vibe 中查看 Agent 记录").click());
    const turnButtons = [...container.querySelectorAll<HTMLButtonElement>(
      ".rho-vibe-agent-record-host button[data-exploration-turn]",
    )];
    expect(turnButtons).toHaveLength(2);
    turnButtons[1]!.focus();
    act(() => turnButtons[1]!.click());

    expect(container.querySelector(".rho-vibe-agent-record-host")).not.toBeNull();
    expect(container.textContent).toContain("Second recorded task");
    expect(document.activeElement).toBe(turnButtons[1]);
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      conversationId: "conversation:one",
      turnId: "turn:two",
    });
    act(() => findButton(container, "在 Studio 中深入检查").click());
    expect(onOpenAgent).toHaveBeenCalledWith({
      conversationId: "conversation:one",
      turnId: "turn:two",
    });
  });

  it("fails closed inside the host when invalidation removes the exact selected Turn", async () => {
    const summary = turn();
    const harness = createTransport({
      conversations: [conversation()],
      turns: [summary],
      details: [detail(summary)],
    });
    const selection = { conversationId: "conversation:one", turnId: "turn:one" };
    const { container } = mount(baseProps(harness.transport, { selection }));
    await act(settle);
    act(() => findButton(container, "在 Vibe 中查看 Agent 记录").click());

    harness.state.turns.set("conversation:one", []);
    harness.state.details.delete("turn:one");
    await act(async () => {
      harness.emitInvalidated();
      await settle();
    });

    expect(container.querySelector(".rho-vibe-agent-record-host")).not.toBeNull();
    expect(container.textContent).toContain("所选 Turn 已不可用");
    expect(container.textContent).toContain("不会用其他记录替代");
    expect(container.textContent).not.toContain("在 Studio 中提出任务");
    expect(container.textContent).not.toContain("在 Studio 中深入检查");
  });

  it("fails closed when invalidation removes the exact Turn from a legacy conversation", async () => {
    const summary = turn();
    const harness = createTransport({
      conversations: [conversation({ legacy_unthreaded: true })],
      turns: [summary],
      details: [detail(summary)],
    });
    const selection = { conversationId: "conversation:one", turnId: "turn:one" };
    const { container } = mount(baseProps(harness.transport, { selection }));
    await act(settle);
    act(() => findButton(container, "在 Vibe 中查看 Agent 记录").click());

    expect(container.textContent).toContain("在 Studio 中发起新的探索");
    harness.state.turns.set("conversation:one", []);
    harness.state.details.delete("turn:one");
    await act(async () => {
      harness.emitInvalidated();
      await settle();
    });

    expect(container.textContent).toContain("所选 Turn 已不可用");
    expect(container.textContent).toContain("不会用其他记录替代");
    expect(container.textContent).not.toContain("在 Studio 中发起新的探索");
    expect(container.textContent).not.toContain("在 Studio 中深入检查");
  });

  it("keeps the host and focus stable while a refresh failure marks its public record stale", async () => {
    const summary = turn();
    const harness = createTransport({
      conversations: [conversation()],
      turns: [summary],
      details: [detail(summary)],
    });
    const onError = vi.fn();
    const { container } = mount(baseProps(harness.transport, { onError }));
    await act(settle);
    act(() => findButton(container, "在 Vibe 中查看 Agent 记录").click());
    const heading = container.querySelector<HTMLHeadingElement>(".rho-vibe-agent-record-host h3")!;
    expect(document.activeElement).toBe(heading);

    harness.state.listFailure = new Error(
      "Agent refresh failed at /Users/alice/private/agent.json for turn_id=turn:private-8.",
    );
    await act(async () => {
      harness.emitInvalidated();
      await settle();
    });

    expect(container.querySelector(".rho-vibe-agent-record-host")).not.toBeNull();
    expect(container.textContent).toContain("记录可能不是最新");
    expect(container.textContent).toContain("[local path]");
    expect(container.textContent).toContain("[internal reference]");
    expect(container.textContent).not.toContain("/Users/alice/private/agent.json");
    expect(document.activeElement).toBe(heading);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("closes with Escape, restores its trigger, and clears on selection, Page, or project replacement", async () => {
    const summary = turn();
    const harness = createTransport({
      conversations: [conversation()],
      turns: [summary],
      details: [detail(summary, [event(1, "tool.call_completed")])],
    });
    const props = baseProps(harness.transport);
    const { container, root } = mount(props);
    await act(settle);

    act(() => findButton(container, "在 Vibe 中查看 Agent 记录").click());
    const heading = container.querySelector<HTMLHeadingElement>(".rho-vibe-agent-record-host h3")!;
    expect(document.activeElement).toBe(heading);

    act(() => heading.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "Escape",
    })));
    const restoredTrigger = findButton(container, "在 Vibe 中查看 Agent 记录");
    expect(container.querySelector(".rho-vibe-agent-record-host")).toBeNull();
    expect(document.activeElement).toBe(restoredTrigger);

    act(() => restoredTrigger.click());
    await act(async () => {
      root.render(<VibeExplorationPanel {...props} projectId="project:two" />);
      await settle();
    });
    expect(container.querySelector(".rho-vibe-agent-record-host")).toBeNull();

    await act(async () => {
      root.render(<VibeExplorationPanel {...props} />);
      await settle();
    });
    act(() => findButton(container, "在 Vibe 中查看 Agent 记录").click());
    await act(async () => {
      root.render(<VibeExplorationPanel
        {...props}
        selection={{ conversationId: "conversation:missing", turnId: "turn:missing" }}
      />);
      await settle();
    });
    expect(container.querySelector(".rho-vibe-agent-record-host")).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector("button[data-exploration-conversation]"),
    );

    await act(async () => {
      root.render(<VibeExplorationPanel {...props} pageId="page:two" />);
      await settle();
    });
    act(() => findButton(container, "在 Vibe 中查看 Agent 记录").click());
    expect(container.querySelector(".rho-vibe-agent-record-host")).not.toBeNull();
    await act(async () => {
      root.render(<VibeExplorationPanel {...props} pageId="page:three" />);
      await settle();
    });
    expect(container.querySelector(".rho-vibe-agent-record-host")).toBeNull();
  });

  it("shows failed-turn attention and marks a manuscript relationship only for exact identifiers", async () => {
    const waitingConversation = conversation({
      status: "failed",
    });
    const waitingTurn = turn({
      status: "failed",
      final_message: null,
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

    harness.state.listFailure = new Error(
      "Refresh unavailable for agent-turn:private-42 at /Users/alice/private/rho/turn.json; retry later.",
    );
    await act(async () => {
      harness.emitInvalidated();
      await settle();
    });

    expect(container.textContent).toContain("Compare cluster 3 and cluster 7");
    expect(container.textContent).toContain("记录可能不是最新");
    expect(container.textContent).toContain("Refresh unavailable");
    expect(container.textContent).toContain("[local path]");
    expect(container.textContent).toContain("[internal reference]");
    expect(container.textContent).not.toContain("/Users/alice/private/rho/turn.json");
    expect(container.textContent).not.toContain("agent-turn:private-42");
    const reported = onError.mock.calls.at(-1)?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toContain("retry later");
    expect((reported as Error).message).not.toContain("/Users/alice/private/rho/turn.json");
    expect((reported as Error).message).not.toContain("agent-turn:private-42");
  });

  it("redacts paths and internal references from an initial failure without hiding its cause", async () => {
    const harness = createTransport();
    harness.state.listFailure = new Error(
      "Runtime unavailable while reading conversation_id=private-77 from /private/tmp/rho/agent-state.json.",
    );
    const onError = vi.fn();
    const { container } = mount(baseProps(harness.transport, { onError }));

    await act(settle);

    const alert = container.querySelector<HTMLElement>("[role='alert']");
    expect(alert?.textContent).toContain("Runtime unavailable while reading");
    expect(alert?.textContent).toContain("[internal reference]");
    expect(alert?.textContent).toContain("[local path]");
    expect(alert?.textContent).not.toContain("conversation_id=private-77");
    expect(alert?.textContent).not.toContain("/private/tmp/rho/agent-state.json");
    const reported = onError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toContain("Runtime unavailable while reading");
    expect((reported as Error).message).not.toContain("conversation_id=private-77");
    expect((reported as Error).message).not.toContain("/private/tmp/rho/agent-state.json");
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

    act(() => root.render(
      <VibeExplorationPanel
        {...props}
        projectId="project:new"
        projectRoot="/projects/new"
      />,
    ));
    const newConversation = conversation({
      conversation_id: "conversation:new",
      project_root: "/projects/new",
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

  it("fails closed when typed Agent records belong to another project root", async () => {
    const harness = createTransport({
      conversations: [conversation({
        project_root: "/projects/other",
        title: "Other project exploration must not render",
      })],
    });
    const onError = vi.fn();
    const { container } = mount(baseProps(harness.transport, { onError }));

    await act(settle);

    expect(container.textContent).toContain("自主探索记录暂时不可用");
    expect(container.textContent).not.toContain("Other project exploration must not render");
    expect(onError).toHaveBeenCalledTimes(1);
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

  it("supports Arrow, Home, and End navigation across the ordered Turn list", async () => {
    const firstTurn = turn({ turn_id: "turn:one", prompt_preview: "First recorded task" });
    const secondTurn = turn({ turn_id: "turn:two", prompt_preview: "Second recorded task" });
    const thirdTurn = turn({ turn_id: "turn:three", prompt_preview: "Third recorded task" });
    const harness = createTransport({
      conversations: [conversation({ turn_count: 3 })],
      turns: [firstTurn, secondTurn, thirdTurn],
      details: [detail(firstTurn), detail(secondTurn), detail(thirdTurn)],
    });
    const onSelectionChange = vi.fn();
    const { container } = mount(baseProps(harness.transport, {
      presentation: "focused",
      selection: { conversationId: "conversation:one", turnId: "turn:one" },
      onSelectionChange,
    }));
    await act(settle);
    onSelectionChange.mockClear();

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(
      "button[data-exploration-turn]",
    )];
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.closest("ol")).not.toBeNull();

    buttons[0]!.focus();
    act(() => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "ArrowDown",
    })));
    expect(document.activeElement).toBe(buttons[1]);

    act(() => buttons[1]!.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "End",
    })));
    expect(document.activeElement).toBe(buttons[2]);

    act(() => buttons[2]!.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "Home",
    })));
    expect(document.activeElement).toBe(buttons[0]);

    act(() => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "ArrowUp",
    })));
    expect(document.activeElement).toBe(buttons[0]);
    expect(onSelectionChange).not.toHaveBeenCalled();
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
    const recentConversation = container.querySelector<HTMLButtonElement>(
      "button[data-exploration-conversation]",
    );
    expect(recentConversation?.tabIndex).toBe(0);
    expect(recentConversation?.hasAttribute("aria-current")).toBe(false);
  });

  it("keeps a loaded conversation keyboard-reachable when its exact Turn is unresolved", async () => {
    const recentTurn = turn();
    const harness = createTransport({
      conversations: [conversation()],
      turns: [recentTurn],
      details: [detail(recentTurn)],
    });
    const { container } = mount(baseProps(harness.transport, {
      presentation: "focused",
      selection: { conversationId: "conversation:one", turnId: "turn:missing" },
      exactRefs: { conversationIds: ["conversation:one"], taskIds: ["turn:missing"] },
    }));
    await act(settle);

    const visibleTurn = container.querySelector<HTMLButtonElement>("button[data-exploration-turn]");
    expect(visibleTurn?.tabIndex).toBe(0);
    expect(visibleTurn?.hasAttribute("aria-current")).toBe(false);
  });
});
