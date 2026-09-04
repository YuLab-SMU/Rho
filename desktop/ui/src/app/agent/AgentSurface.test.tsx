import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentConversationSummary,
  AgentTurnDetail,
  AgentTurnEvent,
  AgentTurnEventFrame,
  AgentTurnSummary,
  RunAgentRequest,
  SurfaceInstance,
} from "../../transport";
import type { AgentCorePorts } from "../workbench/agentPorts";
import type { AgentSurfaceState } from "./AgentSurface";
import { AgentSurface } from "./AgentSurface";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const CONVERSATION_ID = "agent-conversation:1";
const READY = { state: "ready", label: "Agent ready", detail: null } as const;

function agentInstance(viewState: Record<string, unknown> = {}): SurfaceInstance {
  return {
    instance_id: "instance:agent-test",
    surface_id: "rho.agent",
    project_id: "project:test",
    origin: { kind: "application", component_id: "rho.agent" },
    activation_generation: 1,
    surface_revision: 1,
    mode_id: "conversation",
    resource_binding: null,
    runtime_binding: null,
    view_group_id: null,
    view_state: { conversation_id: CONVERSATION_ID, composer: "", ...viewState },
    lifecycle_state: "active",
  };
}

function conversation(overrides: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
  return {
    conversation_id: CONVERSATION_ID,
    project_root: "/tmp/project",
    title: "Mock conversation",
    created_at: "2026-09-03T09:59:00Z",
    updated_at: "2026-09-03T10:00:05Z",
    archived_at: null,
    legacy_unthreaded: false,
    turn_count: 1,
    status: "idle",
    latest_turn_id: "agent-turn:1",
    latest_prompt_preview: "What should we inspect first?",
    terminal_reason: null,
    ...overrides,
  };
}

function turn(overrides: Partial<AgentTurnSummary> = {}): AgentTurnSummary {
  return {
    turn_id: "agent-turn:1",
    conversation_id: CONVERSATION_ID,
    project_root: "/tmp/project",
    status: "completed",
    started_at: "2026-09-03T10:00:00Z",
    finished_at: "2026-09-03T10:00:05Z",
    prompt_preview: "What should we inspect first?",
    model: "mock-model",
    workspace_id_before: null,
    state_revision_before: null,
    project_revision_before: null,
    workspace_id_after: null,
    state_revision_after: null,
    project_revision_after: null,
    final_message: "Start with the Environment receipt.",
    error_message: null,
    retry_of_turn_id: null,
    terminal_reason: null,
    ...overrides,
  };
}

function turnEvent(overrides: Partial<AgentTurnEvent> = {}): AgentTurnEvent {
  return {
    id: 1,
    turn_id: "agent-turn:1",
    timestamp: "2026-09-03T10:00:01Z",
    event_type: "agent.user_prompt",
    title: "You",
    body: "What should we inspect first?",
    status: "completed",
    tool: null,
    request_id: null,
    code: null,
    details_json: "{}",
    ...overrides,
  };
}

/** One turn as the durable event log records it: prompt, one tool call, answer. */
function turnEvents(): readonly AgentTurnEvent[] {
  return [
    turnEvent(),
    turnEvent({
      id: 2,
      event_type: "tool.call_completed",
      title: "Read the Environment receipt",
      body: null,
      tool: "read_file",
      code: "receipt://environment",
    }),
    turnEvent({
      id: 3,
      event_type: "agent.final_message",
      title: "Rho",
      body: "Start with the Environment receipt.",
    }),
  ];
}

function detail(turnSummary: AgentTurnSummary, events: readonly AgentTurnEvent[]): AgentTurnDetail {
  return { turn: turnSummary, events } as AgentTurnDetail;
}

function corePorts(overrides: Partial<AgentCorePorts> = {}): AgentCorePorts {
  return {
    listAgentConversations: vi.fn(async () => [conversation()]),
    listAgentTurns: vi.fn(async () => []),
    getAgentTurnDetail: vi.fn(async () => null),
    subscribeAgentInvalidated: vi.fn(() => () => undefined),
    subscribeAgentTurnEvents: vi.fn(() => () => undefined),
    cancelAgentTurn: vi.fn(async () => ({})),
    retryAgentRuntime: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as AgentCorePorts;
}

function frame(overrides: Partial<AgentTurnEventFrame> = {}): AgentTurnEventFrame {
  return {
    project_root: "/tmp/project",
    turn_id: "agent-turn:1",
    event: null,
    turn_update: null,
    payload_truncated: false,
    ...overrides,
  };
}

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("AgentSurface", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function renderSurface(options: {
    readonly transport?: AgentCorePorts;
    readonly health?: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
    readonly viewState?: Record<string, unknown>;
    readonly runConversation?: (
      current: AgentSurfaceState,
      request: RunAgentRequest,
      onAccepted?: (conversationId: string) => void,
    ) => Promise<AgentSurfaceState>;
  } = {}) {
    const transport = options.transport ?? corePorts();
    const persist = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const runConversation = options.runConversation
      ?? vi.fn(async (current: AgentSurfaceState) => current);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<AgentSurface
        instance={agentInstance(options.viewState)}
        transport={transport}
        health={options.health === undefined ? READY : options.health}
        runConversation={runConversation}
        persist={persist}
        reportError={reportError}
      />);
      await settle();
    });
    return { container, transport, persist, reportError, runConversation };
  }

  function composer(container: HTMLElement): HTMLTextAreaElement {
    return container.querySelector<HTMLTextAreaElement>(".rho-agent-composer textarea")!;
  }

  function send(container: HTMLElement): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Send")!;
  }

  function items(container: HTMLElement): readonly HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(".rho-agent-stream-item")];
  }

  async function type(container: HTMLElement, value: string) {
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setTextarea.call(composer(container), value);
      composer(container).dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
  }

  it("offers one stream and a composer, with no approval or mode control", async () => {
    const { container } = await renderSurface();
    expect(container.querySelector(".rho-agent-surface")).not.toBeNull();
    expect(container.textContent).toContain("Start a conversation");
    expect(send(container).disabled).toBe(true);
    expect([...container.querySelectorAll("button")].map((button) => button.textContent))
      .toEqual(["Send"]);
    expect(container.querySelector(".rho-agent-approval")).toBeNull();
    expect(container.querySelector(".rho-agent-mode")).toBeNull();
  });

  it("replays the durable event log as one ordered stream", async () => {
    const summary = turn();
    const { container } = await renderSurface({
      transport: corePorts({
        listAgentTurns: vi.fn(async () => [summary]),
        getAgentTurnDetail: vi.fn(async () => detail(summary, turnEvents())),
      }),
    });
    const rendered = items(container);
    expect(rendered.map((item) => item.dataset.turnId)).toEqual([
      "agent-turn:1",
      "agent-turn:1",
      "agent-turn:1",
    ]);
    expect(rendered[1]!.className).toContain("rho-agent-stream-tool");
    expect(container.textContent).toContain("What should we inspect first?");
    expect(container.textContent).toContain("Read the Environment receipt");
    expect(container.textContent).toContain("Start with the Environment receipt.");
    // Structured payloads stay monospace; prose does not.
    expect(rendered[1]!.querySelector("pre")?.textContent).toBe("receipt://environment");
    expect(rendered[0]!.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("Start a conversation");
  });

  it("orders the stream chronologically although the transport lists newest first", async () => {
    const latest = turn({
      turn_id: "agent-turn:2",
      started_at: "2026-09-03T10:05:00Z",
      prompt_preview: "And the checks?",
      final_message: "They pass.",
    });
    const earliest = turn();
    const { container } = await renderSurface({
      transport: corePorts({
        listAgentTurns: vi.fn(async () => [latest, earliest]),
        getAgentTurnDetail: vi.fn(async () => null),
      }),
    });
    expect(items(container).map((item) => item.dataset.turnId)).toEqual([
      "agent-turn:1",
      "agent-turn:1",
      "agent-turn:2",
      "agent-turn:2",
    ]);
    expect(container.textContent?.indexOf("What should we inspect first?"))
      .toBeLessThan(container.textContent?.indexOf("And the checks?") ?? -1);
  });

  it("falls back to the durable turn summary when no event detail is available", async () => {
    const summary = turn();
    const { container } = await renderSurface({
      transport: corePorts({
        listAgentTurns: vi.fn(async () => [summary]),
        getAgentTurnDetail: vi.fn(async () => null),
      }),
    });
    const rendered = items(container);
    expect(rendered.map((item) => item.className)).toEqual([
      "rho-agent-stream-item rho-agent-stream-prompt",
      "rho-agent-stream-item rho-agent-stream-answer",
    ]);
    expect(rendered[0]!.textContent).toContain("What should we inspect first?");
    expect(rendered[1]!.textContent).toContain("Start with the Environment receipt.");
  });

  it("reports a failed turn from the durable summary", async () => {
    const failed = turn({
      status: "failed",
      final_message: null,
      error_message: "The Agent process exited before answering.",
    });
    const { container } = await renderSurface({
      transport: corePorts({
        listAgentTurns: vi.fn(async () => [failed]),
        getAgentTurnDetail: vi.fn(async () => null),
      }),
    });
    const rendered = items(container);
    expect(rendered).toHaveLength(2);
    expect(rendered[1]!.className).toContain("rho-agent-stream-failure");
    expect(rendered[1]!.textContent).toContain("The Agent process exited before answering.");
  });

  it("appends live turn events and reloads authoritative state when the turn ends", async () => {
    const listeners = new Set<(frame: AgentTurnEventFrame) => void>();
    const running = turn({ status: "running", final_message: null, finished_at: null });
    const transport = corePorts({
      listAgentTurns: vi.fn(async () => [running]),
      getAgentTurnDetail: vi.fn(async () => detail(running, [])),
      subscribeAgentTurnEvents: vi.fn((listener: (frame: AgentTurnEventFrame) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    });
    const { container } = await renderSurface({ transport });
    const runningRow = container.querySelector(".rho-agent-running");
    expect(runningRow?.textContent).toContain("Agent running");
    expect(runningRow?.textContent).toMatch(/\d+m \d{2}s/u);
    expect([...container.querySelectorAll<HTMLButtonElement>("button")]
      .map((button) => button.textContent)).toContain("Stop");

    await act(async () => {
      for (const listener of listeners) {
        listener(frame({ event: turnEvent({ id: 7, title: "Fitted the model", body: null }) }));
      }
      await settle();
    });
    expect(container.textContent).toContain("Fitted the model");

    const completed = turn();
    vi.mocked(transport.listAgentTurns).mockResolvedValue([completed]);
    vi.mocked(transport.getAgentTurnDetail).mockResolvedValue(
      detail(completed, [...turnEvents(), turnEvent({ id: 7, title: "Fitted the model", body: null })]),
    );
    await act(async () => {
      for (const listener of listeners) {
        listener(frame({ turn_update: {
          status: "completed",
          final_message: "Start with the Environment receipt.",
          error_message: null,
          terminal_reason: null,
        } }));
      }
      await settle();
    });
    expect(container.querySelector(".rho-agent-running")).toBeNull();
    // The terminal frame reloads durable state, so the live event is not duplicated.
    expect(items(container)).toHaveLength(4);
    expect(container.textContent).toContain("Start with the Environment receipt.");
  });

  it("dispatches the composer text as a turn and adopts the conversation the Agent accepted", async () => {
    const runConversation = vi.fn(async (
      current: AgentSurfaceState,
      _request: RunAgentRequest,
      onAccepted?: (conversationId: string) => void,
    ) => {
      onAccepted?.("agent-conversation:2");
      return { ...current, conversation_id: "agent-conversation:2", composer: "" };
    });
    const { container, persist } = await renderSurface({
      viewState: { conversation_id: null },
      transport: corePorts({
        listAgentConversations: vi.fn(async () => [
          conversation(),
          conversation({ conversation_id: "agent-conversation:2" }),
        ]),
      }),
      runConversation,
    });
    await type(container, "Summarize the project structure");
    expect(send(container).disabled).toBe(false);

    await act(async () => {
      send(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });

    expect(runConversation).toHaveBeenCalledTimes(1);
    const [, request] = runConversation.mock.calls[0]!;
    expect(request).toMatchObject({
      prompt: "Summarize the project structure",
      conversation_id: null,
    });
    expect(composer(container).value).toBe("");
    expect(container.querySelector(".rho-agent-surface")?.getAttribute("data-conversation-id"))
      .toBe("agent-conversation:2");
    await type(container, "And the checks?");
    expect(persist).toHaveBeenLastCalledWith({
      conversation_id: "agent-conversation:2",
      composer: "And the checks?",
    });
  });

  it("reports a failed dispatch and keeps the composer usable", async () => {
    const runConversation = vi.fn(async () => {
      throw new Error("The Agent process is not reachable.");
    });
    const { container, reportError } = await renderSurface({ runConversation });
    await type(container, "Run the checks");
    await act(async () => {
      send(container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(composer(container).value).toBe("");
    await type(container, "Run the checks again");
    expect(send(container).disabled).toBe(false);
  });

  it("blocks the composer and explains why while the Agent runtime is not ready", async () => {
    const { container } = await renderSurface({
      health: { state: "degraded", label: "Agent runtime stopped", detail: "Restart to continue." },
    });
    expect(container.querySelector(".rho-agent-degraded")?.textContent).toContain("Agent runtime stopped");
    expect(container.querySelector(".rho-agent-degraded")?.textContent).toContain("Restart to continue.");
    await type(container, "Anything");
    expect(send(container).disabled).toBe(true);
    expect([...container.querySelectorAll("button")].map((button) => button.textContent))
      .toEqual(["Retry", "Send"]);
  });
});
