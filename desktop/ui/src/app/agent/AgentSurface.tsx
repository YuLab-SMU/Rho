import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type {
  AgentTurnDetail,
  AgentTurnEvent,
  AgentTurnEventFrame,
  AgentTurnSummary,
  RunAgentRequest,
  SurfaceInstance,
} from "../../transport";
import type { AgentCorePorts } from "../workbench/agentPorts";

import "../../styles/agent-surface.css";

export interface AgentSurfaceState {
  readonly conversation_id: string | null;
  readonly composer: string;
}

type StreamKind = "prompt" | "event" | "tool" | "answer" | "failure";

interface StreamItem {
  readonly key: string;
  readonly turn_id: string | null;
  readonly kind: StreamKind;
  readonly text: string;
  readonly body: string | null;
  readonly code: string | null;
}

/** Bound on how much turn history one refresh reads back into the stream. */
const TURN_STREAM_LIMIT = 20;

function initialState(instance: SurfaceInstance): AgentSurfaceState {
  const candidate = typeof instance.view_state === "object" && instance.view_state != null
    ? instance.view_state as Record<string, unknown>
    : {};
  return {
    conversation_id: typeof candidate.conversation_id === "string"
      ? candidate.conversation_id
      : null,
    composer: typeof candidate.composer === "string" ? candidate.composer : "",
  };
}

function statusIsLive(status: string): boolean {
  return status === "running" || status === "waiting";
}

function turnStatusLabel(status: string): string {
  switch (status) {
    case "running": return "Running";
    case "waiting": return "Waiting";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

function eventItem(turnId: string, event: AgentTurnEvent): StreamItem {
  const isTool = event.tool != null;
  return {
    key: `${turnId}:event:${event.id}`,
    turn_id: turnId,
    kind: isTool ? "tool" : "event",
    text: event.title,
    body: isTool ? null : event.body,
    code: event.code ?? (isTool ? event.body : null),
  };
}

function seedStream(
  turns: readonly AgentTurnSummary[],
  details: ReadonlyMap<string, AgentTurnDetail>,
): readonly StreamItem[] {
  return [...turns]
    .sort((left, right) => left.started_at.localeCompare(right.started_at))
    .flatMap((turn) => {
      const failure: StreamItem | null = turn.status === "failed" && turn.error_message != null
        ? {
            key: `${turn.turn_id}:failure`,
            turn_id: turn.turn_id,
            kind: "failure",
            text: turn.error_message,
            body: null,
            code: null,
          }
        : null;
      const events = details.get(turn.turn_id)?.events ?? [];
      if (events.length > 0) {
        return [
          ...events.map((event) => eventItem(turn.turn_id, event)),
          ...failure != null ? [failure] : [],
        ];
      }
      // Without a loaded detail the durable summary is the only record of the turn.
      return [
        {
          key: `${turn.turn_id}:prompt`,
          turn_id: turn.turn_id,
          kind: "prompt",
          text: turn.prompt_preview,
          body: null,
          code: null,
        },
        ...failure != null
          ? [failure]
          : turn.final_message != null && turn.final_message.trim() !== ""
            ? [{
                key: `${turn.turn_id}:answer`,
                turn_id: turn.turn_id,
                kind: "answer" as const,
                text: turn.final_message,
                body: null,
                code: null,
              }]
            : [],
      ];
    });
}

function refreshFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The Agent conversation could not be refreshed.";
}

function elapsedLabel(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return "";
  const seconds = Math.max(0, Math.floor((now - started) / 1_000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// One continuous stream of what the external Agent did, plus a composer: Rho
// observes and dispatches, it never gates. See AGENTS.md for the split.
export function AgentSurface({
  instance,
  transport,
  health,
  runConversation,
  persist,
  reportError,
}: {
  readonly instance: SurfaceInstance;
  readonly transport: AgentCorePorts;
  readonly health: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
  readonly runConversation: (
    current: AgentSurfaceState,
    request: RunAgentRequest,
    onAccepted?: (conversationId: string) => void,
  ) => Promise<AgentSurfaceState>;
  readonly persist: (viewState: AgentSurfaceState) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}) {
  const [view, setView] = useState(() => initialState(instance));
  const viewRef = useRef(view);
  const [items, setItems] = useState<readonly StreamItem[]>([]);
  const [turns, setTurns] = useState<readonly AgentTurnSummary[]>([]);
  const [liveStatus, setLiveStatus] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const activeTurn = turns.find((turn) =>
    statusIsLive(liveStatus.get(turn.turn_id) ?? turn.status)) ?? null;
  const liveTurnId = activeTurn?.turn_id ?? null;
  useEffect(() => {
    if (liveTurnId == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [liveTurnId]);

  const activationVersionRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const mutationRef = useRef<symbol | null>(null);
  const refreshScheduledRef = useRef(false);

  useLayoutEffect(() => {
    const version = activationVersionRef.current + 1;
    activationVersionRef.current = version;
    mutationRef.current = null;
    refreshScheduledRef.current = false;
    refreshGenerationRef.current += 1;
    viewRef.current = initialState(instance);
    setView(viewRef.current);
    setItems([]);
    setTurns([]);
    setLiveStatus(new Map());
    setBusy(false);
    setLoading(true);
    setRefreshError(null);
    return () => {
      if (activationVersionRef.current === version) activationVersionRef.current = version + 1;
      refreshGenerationRef.current += 1;
      mutationRef.current = null;
    };
  }, [instance.activation_generation, instance.instance_id, instance.project_id]);

  const activationIsCurrent = useCallback(
    (version: number) => activationVersionRef.current === version,
    [],
  );

  const refresh = useCallback(async (activationVersion: number) => {
    if (!activationIsCurrent(activationVersion)) return;
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const isCurrent = () => activationIsCurrent(activationVersion)
      && refreshGenerationRef.current === generation;
    refreshScheduledRef.current = false;
    setLoading(true);
    try {
      const conversations = await transport.listAgentConversations(TURN_STREAM_LIMIT * 2);
      if (!isCurrent()) return;
      const preferred = viewRef.current.conversation_id;
      const available = conversations.some(
        (conversation) => conversation.conversation_id === preferred,
      );
      const selected = available ? preferred : null;
      if (selected !== preferred) {
        const next = { ...viewRef.current, conversation_id: selected };
        viewRef.current = next;
        setView(next);
      }
      const nextTurns = selected == null
        ? []
        : await transport.listAgentTurns(selected, TURN_STREAM_LIMIT);
      if (!isCurrent()) return;
      const loaded = await Promise.all(nextTurns.map(async (turn) => [
        turn.turn_id,
        await transport.getAgentTurnDetail(turn.turn_id),
      ] as const));
      if (!isCurrent()) return;
      const nextDetails = new Map(loaded.flatMap(([turnId, detail]) =>
        detail == null ? [] : [[turnId, detail] as const]
      ));
      setTurns(nextTurns);
      setLiveStatus(new Map());
      setItems(seedStream(nextTurns, nextDetails));
      setRefreshError(null);
    } catch (error: unknown) {
      if (isCurrent()) setRefreshError(refreshFailureMessage(error));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [activationIsCurrent, transport]);

  const scheduleRefresh = useCallback(() => {
    if (refreshScheduledRef.current) return;
    refreshScheduledRef.current = true;
    const activationVersion = activationVersionRef.current;
    queueMicrotask(() => {
      if (!activationIsCurrent(activationVersion)) return;
      void refresh(activationVersion);
    });
  }, [activationIsCurrent, refresh]);

  useEffect(() => {
    const activationVersion = activationVersionRef.current;
    void refresh(activationVersion);
    return transport.subscribeAgentInvalidated(() => {
      if (activationIsCurrent(activationVersion)) scheduleRefresh();
    });
  }, [activationIsCurrent, refresh, scheduleRefresh, transport]);

  useEffect(() => transport.subscribeAgentTurnEvents((frame: AgentTurnEventFrame) => {
    const activationVersion = activationVersionRef.current;
    if (!activationIsCurrent(activationVersion)) return;
    if (frame.event != null) {
      const event = frame.event;
      setItems((previous) => previous.some((item) => item.key === `${frame.turn_id}:event:${event.id}`)
        ? previous
        : [...previous, eventItem(frame.turn_id, event)]);
    }
    const update = frame.turn_update;
    if (update != null) {
      const status = update.status;
      setLiveStatus((previous) => new Map(previous).set(frame.turn_id, status));
      // The frame is a notification layer: durable turn state is authoritative,
      // so a terminal or truncated frame reloads instead of patching further.
      if (frame.payload_truncated || !statusIsLive(status)) scheduleRefresh();
    } else if (frame.payload_truncated) {
      scheduleRefresh();
    }
  }), [activationIsCurrent, scheduleRefresh, transport]);

  const beginMutation = (label: string) => {
    if (mutationRef.current != null) return null;
    const token = Symbol(label);
    mutationRef.current = token;
    setBusy(true);
    return token;
  };
  const endMutation = (token: symbol) => {
    if (mutationRef.current !== token) return;
    mutationRef.current = null;
    setBusy(false);
  };

  const commitComposer = (composer: string) => {
    if (busy || mutationRef.current != null) return;
    const next = { ...viewRef.current, composer };
    viewRef.current = next;
    setView(next);
    void persist(next).catch(reportError);
  };

  const composerBlockedReason = health == null || health.state !== "ready"
    ? health?.label ?? "The Agent runtime is not ready."
    : null;
  const prompt = view.composer.trim();
  const sendBlocked = busy || activeTurn != null || prompt === "" || composerBlockedReason != null;

  const submit = async () => {
    if (sendBlocked) return;
    const activationVersion = activationVersionRef.current;
    const current = viewRef.current;
    const mutation = beginMutation("agent-turn");
    if (mutation == null) return;
    refreshGenerationRef.current += 1;
    const cleared = { ...current, composer: "" };
    viewRef.current = cleared;
    setView(cleared);
    setItems((previous) => [...previous, {
      key: `local:${previous.length}`,
      turn_id: cleared.conversation_id,
      kind: "prompt",
      text: prompt,
      body: null,
      code: null,
    }]);
    const request: RunAgentRequest = {
      prompt,
      conversation_id: cleared.conversation_id,
    };
    try {
      const next = await runConversation(cleared, request, (conversationId) => {
        if (!activationIsCurrent(activationVersion)) return;
        refreshGenerationRef.current += 1;
        const accepted = { ...viewRef.current, conversation_id: conversationId };
        viewRef.current = accepted;
        setView(accepted);
      });
      if (!activationIsCurrent(activationVersion)) return;
      viewRef.current = next;
      setView(next);
      await refresh(activationVersion);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) {
        reportError(error);
        await refresh(activationVersion);
      }
    } finally {
      endMutation(mutation);
    }
  };

  const stop = async () => {
    if (activeTurn == null || busy) return;
    const activationVersion = activationVersionRef.current;
    const mutation = beginMutation("agent-turn-cancel");
    if (mutation == null) return;
    try {
      await transport.cancelAgentTurn(activeTurn.turn_id);
      if (activationIsCurrent(activationVersion)) await refresh(activationVersion);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      endMutation(mutation);
    }
  };

  return (
    <section className="rho-agent-surface" data-conversation-id={view.conversation_id ?? undefined}>
      {composerBlockedReason != null && (
        <div className="rho-agent-degraded" role="status">
          <div className="rho-agent-degraded-row">
            <div>
              <strong>{health?.label ?? "Agent unavailable"}</strong>
              <p>{health?.detail ?? composerBlockedReason}</p>
            </div>
            <button type="button" disabled={busy} onClick={() => void transport.retryAgentRuntime()
              .then(scheduleRefresh)
              .catch(reportError)}>Retry</button>
          </div>
        </div>
      )}
      {activeTurn != null && (
        <div className="rho-agent-running" role="status">
          <span className="rho-agent-running-label">
            Agent {turnStatusLabel(liveStatus.get(activeTurn.turn_id) ?? activeTurn.status).toLowerCase()}
          </span>
          <span>{elapsedLabel(activeTurn.started_at, now)}</span>
          <button type="button" disabled={busy} onClick={() => void stop()}>Stop</button>
        </div>
      )}

      <div className="rho-agent-timeline">
        {loading && <p className="rho-agent-empty" role="status">Loading conversation…</p>}
        {!loading && refreshError != null && (
          <div className="rho-agent-empty" role="alert">
            <strong>Refresh failed</strong>
            <span>{refreshError}</span>
          </div>
        )}
        {!loading && refreshError == null && items.length === 0 && (
          <div className="rho-agent-empty" role="status">
            <strong>Start a conversation</strong>
            <span>Everything the Agent reads and changes appears here as it happens.</span>
          </div>
        )}
        {items.map((item) => <StreamItemView item={item} key={item.key} />)}
      </div>

      <footer className="rho-agent-composer">
        <textarea
          aria-label={`Agent prompt ${instance.instance_id}`}
          value={view.composer}
          onChange={(event) => commitComposer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="What should I do?"
          rows={3}
        />
        <div className="rho-agent-composer-actions">
          {composerBlockedReason == null && activeTurn == null && (
            <small className="rho-agent-composer-hint">Observe → plan → request effect → re-observe</small>
          )}
          <button
            type="button"
            className="rho-primary-action"
            disabled={sendBlocked}
            onClick={() => void submit()}
          >Send</button>
        </div>
      </footer>
    </section>
  );
}

const STREAM_KIND_LABELS: Readonly<Record<StreamKind, string>> = {
  prompt: "Prompt",
  event: "Step",
  tool: "Tool",
  answer: "Answer",
  failure: "Failed",
};

function StreamItemView({ item }: { readonly item: StreamItem }) {
  return (
    <article className={`rho-agent-stream-item rho-agent-stream-${item.kind}`} data-turn-id={item.turn_id ?? undefined}>
      <header><span className="rho-agent-stream-kind">{STREAM_KIND_LABELS[item.kind]}</span></header>
      <p>{item.text}</p>
      {item.body != null && item.body.trim() !== "" && <p>{item.body}</p>}
      {item.code != null && item.code.trim() !== "" && <pre>{item.code}</pre>}
    </article>
  );
}
