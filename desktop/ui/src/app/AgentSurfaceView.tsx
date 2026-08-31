import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  AgentConversationSummary,
  AgentContextPlanPreview,
  AgentFileMutationResponse,
  AgentLlmSettingsView,
  AgentMode,
  AgentRuntimeDiagnostics,
  AgentTurnDetail,
  AgentTurnEventFrame,
  AgentTurnSummary,
  RuntimeOutputReference,
  RunAgentRequest,
  SurfaceInstance,
  UiKernelTransport,
} from "../transport";
import { computeLineDiff } from "./agent/diff";
import { announceAgentSettingsChanged, subscribeAgentSettingsChanged } from "./agent/settings-events";
import {
  agentStudioPresentationKey,
  parseAgentStudioPresentation,
  type AgentStudioPresentation,
} from "./agent/studio-presentation";

import "../styles/agent-surface.css";

export interface AgentSurfaceViewState {
  readonly conversation_id: string | null;
  readonly mode: AgentMode;
  readonly composer: string;
  readonly auto_approve: boolean;
  readonly file_decisions: Readonly<Record<string, "rejected">>;
  readonly studio_presentations?: Readonly<Record<
    string,
    "presenting" | "presented" | "failed"
  >>;
}

export interface AgentFileProposal {
  readonly path: string;
  readonly operation: "replace_selection" | "insert_at_cursor" | "append" | "create";
  readonly content: string;
}

export interface AgentFileUndoState {
  readonly turn_id: string;
  readonly proposal_event_id: number;
  readonly path: string;
  readonly expected_after_sha256: string;
  readonly before_content: string;
  readonly created: boolean;
}

export interface AgentFileProposalReview {
  readonly before_content: string;
  readonly expected_disk_sha256: string | null;
}

interface AgentQueueItem {
  readonly id: string;
  readonly conversation_id: string;
  readonly prompt: string;
  readonly request: RunAgentRequest;
  readonly queued_at: string;
}

type AgentProposalDiffState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly before: string;
      readonly expected_disk_sha256: string | null;
    };

interface AgentRefreshToken {
  readonly activationVersion: number;
  readonly generation: number;
}

interface AgentRefreshOperation {
  readonly token: AgentRefreshToken;
  readonly promise: Promise<void>;
}

interface AgentConversationValidation {
  readonly conversationId: string | null;
  readonly status: "pending" | "available" | "unavailable";
}

function parseAgentFileProposal(event: AgentTurnDetail["events"][number]): AgentFileProposal | null {
  if (event.event_type !== "tool.call_completed" || event.tool !== "propose_file_edit") return null;
  const parse = (value: string | null) => {
    if (value == null) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed != null ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  };
  let proposal = parse(event.body);
  if (proposal?.kind !== "rho.file_edit_proposal") {
    const details = parse(event.details_json);
    const argumentsValue = details?.success === true && typeof details.arguments === "object" && details.arguments != null
      ? details.arguments as Record<string, unknown>
      : null;
    proposal = argumentsValue == null ? null : { kind: "rho.file_edit_proposal", ...argumentsValue };
  }
  const operation = proposal?.operation;
  if (
    typeof proposal?.path !== "string" || typeof proposal.content !== "string" ||
    (operation !== "replace_selection" && operation !== "insert_at_cursor" && operation !== "append" && operation !== "create")
  ) return null;
  return { path: proposal.path, operation, content: proposal.content };
}

function agentFileProposalOutcome(detail: AgentTurnDetail, proposalEventId: number) {
  for (const event of detail.events) {
    if (!event.event_type.startsWith("file_edit.")) continue;
    try {
      const envelope = JSON.parse(event.details_json) as Record<string, unknown>;
      if (Number(envelope.proposal_event_id) !== proposalEventId) continue;
      if (event.event_type === "file_edit.applied") return "applied";
      if (event.event_type === "file_edit.undone") return "undone";
      if (event.event_type.includes("stale")) return "stale";
      if (event.event_type.includes("failed") || event.event_type.includes("cancelled")) return "not applied";
    } catch { /* malformed diagnostics stay visible as raw events */ }
  }
  return null;
}

function studioPresentationStates(value: unknown): Readonly<Record<
  string,
  "presenting" | "presented" | "failed"
>> {
  const candidate = typeof value === "object" && value != null
    ? value as Readonly<Record<string, unknown>>
    : {};
  return Object.fromEntries(Object.entries(candidate).flatMap(([key, status]) => {
    if (status === "presented" || status === "failed") return [[key, status] as const];
    // No in-flight UI operation survives a renderer activation. A persisted
    // presenting marker therefore becomes explicit retryable recovery.
    if (status === "presenting") return [[key, "failed" as const]];
    return [];
  }));
}

function initialAgentSurfaceState(instance: SurfaceInstance): AgentSurfaceViewState {
  const candidate = typeof instance.view_state === "object" && instance.view_state != null
    ? instance.view_state as Record<string, unknown>
    : {};
  return {
    conversation_id: typeof candidate.conversation_id === "string"
      ? candidate.conversation_id
      : null,
    // One autonomous goal loop replaces the former user-selected Ask/Plan/Act modes.
    // The legacy transport still calls this value `act` until its wire contract is retired.
    mode: "act",
    composer: typeof candidate.composer === "string" ? candidate.composer : "",
    auto_approve: candidate.auto_approve === true,
    file_decisions: typeof candidate.file_decisions === "object" && candidate.file_decisions != null
      ? candidate.file_decisions as Readonly<Record<string, "rejected">>
      : {},
    studio_presentations: studioPresentationStates(candidate.studio_presentations),
  };
}

function agentTurnStatusLabel(status: AgentTurnSummary["status"]): string {
  switch (status) {
    case "running": return "Running";
    case "waiting": return "Waiting";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function modelReadinessLabel(model: AgentLlmSettingsView["models"][number]): string {
  if (model.act_enabled) return "Tools ready";
  if (model.model_type.value === "unknown") return "Capabilities unverified";
  return model.selector_status.replaceAll("_", " ");
}

function agentErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The conversation list could not be refreshed.";
}

const AGENT_SUGGESTIONS: readonly string[] = [
  "Summarize this project's structure",
  "Check the runtime health and report issues",
  "Draft a reproducible analysis plan",
];

function AgentRunningRow({ status, startedAt, disabled, onStop }: {
  readonly status: AgentTurnSummary["status"];
  readonly startedAt: string;
  readonly disabled: boolean;
  readonly onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const started = Date.parse(startedAt);
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const label = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div className="rho-agent-running" role="status">
      <span className="rho-status-dot rho-status-degraded" aria-hidden="true" />
      <span className="rho-agent-running-label">
        {status === "waiting" ? "Waiting for a decision or response" : "Agent running"} · {label}
      </span>
      <button type="button" disabled={disabled} onClick={onStop}>Stop</button>
    </div>
  );
}

function AgentLineDiff({ before, after }: {
  readonly before: string;
  readonly after: string;
}) {
  const diff = useMemo(() => computeLineDiff(before, after), [before, after]);
  if (diff == null) return (<>
    <p className="rho-agent-diff-note">This file is too large to diff here; showing the proposed content.</p>
    <pre>{after}</pre>
  </>);
  if (diff.hunks.length === 0) return <p className="rho-agent-diff-note">No line changes.</p>;
  return (
    <div className="rho-agent-diff" role="group" aria-label="Proposed diff">
      <div className="rho-agent-diff-summary">+{diff.additions} −{diff.removals}</div>
      {diff.hunks.map((hunk, hunkIndex) => (
        <div className="rho-agent-diff-hunk" key={hunkIndex}>
          {hunkIndex > 0 && <div className="rho-agent-diff-gap" aria-hidden="true">⋮</div>}
          <div className="rho-agent-diff-hunk-header">@@ -{hunk.beforeStart} +{hunk.afterStart} @@</div>
          <div className="rho-agent-diff-lines">{hunk.lines.map((line, lineIndex) => (
            <div className={`rho-agent-diff-line rho-agent-diff-${line.kind}`} key={lineIndex}>
              <span className="rho-agent-diff-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
              <span className="rho-agent-diff-text">{line.text}</span>
            </div>
          ))}</div>
        </div>
      ))}
    </div>
  );
}

function AgentProposalDiff({ proposal, state }: {
  readonly proposal: AgentFileProposal;
  readonly state: AgentProposalDiffState | undefined;
}) {
  if (proposal.operation !== "append" && proposal.operation !== "create") return (<>
    <p className="rho-agent-diff-note">This edit depends on the current editor selection, so only the proposed content can be shown.</p>
    <pre>{proposal.content}</pre>
  </>);
  if (state == null) return <pre>{proposal.content}</pre>;
  if (state.status === "loading") return <p className="rho-agent-diff-note">Loading current content…</p>;
  if (state.status === "unavailable") return (<>
    <p className="rho-agent-diff-note">Current content is unavailable; showing the proposed content.</p>
    <pre>{proposal.content}</pre>
  </>);
  const after = proposal.operation === "append" ? state.before + proposal.content : proposal.content;
  return <AgentLineDiff before={state.before} after={after} />;
}

const POSTURE_OPTIONS = [{
  id: "ask",
  label: "Ask every time",
  hint: "Every tool action waits for your approval.",
}, {
  id: "auto",
  label: "Auto-approve project tools for this conversation",
  hint: "The Broker still evaluates every effect and asks whenever policy requires it.",
}] as const;
export function AgentSurfaceView({
  instance,
  transport,
  health,
  createConversation,
  runConversation,
  persist,
  pinTask,
  presentInStudio,
  applyFileProposal,
  undoFileProposal,
  reportError,
  runtimeOutputContext,
  setRuntimeOutputContext,
  openModelSettings,
}: {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly health: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
  readonly createConversation: (
    current: AgentSurfaceViewState,
  ) => Promise<AgentSurfaceViewState>;
  readonly runConversation: (
    current: AgentSurfaceViewState,
    request: RunAgentRequest,
    onAccepted?: (conversationId: string) => void,
  ) => Promise<AgentSurfaceViewState>;
  readonly persist: (viewState: AgentSurfaceViewState) => Promise<void>;
  readonly pinTask: (turn: AgentTurnSummary) => Promise<void>;
  readonly presentInStudio: (
    turn: AgentTurnSummary,
    presentation: AgentStudioPresentation,
  ) => Promise<void>;
  readonly applyFileProposal: (
    turn: AgentTurnSummary,
    eventId: number,
    proposal: AgentFileProposal,
    review?: AgentFileProposalReview,
  ) => Promise<{ readonly response: AgentFileMutationResponse; readonly beforeContent: string }>;
  readonly undoFileProposal: (request: AgentFileUndoState) => Promise<void>;
  readonly reportError: (error: unknown) => void;
  readonly runtimeOutputContext: RuntimeOutputReference | null;
  readonly setRuntimeOutputContext: (reference: RuntimeOutputReference | null) => void;
  readonly openModelSettings: (providerId: string | null, modelId: string | null) => void;
}) {
  const [view, setView] = useState(() => initialAgentSurfaceState(instance));
  const viewRef = useRef(view);
  const [conversations, setConversations] = useState<readonly AgentConversationSummary[]>([]);
  const conversationsRef = useRef<readonly AgentConversationSummary[]>([]);
  const [turns, setTurns] = useState<readonly AgentTurnSummary[]>([]);
  const turnsRef = useRef<readonly AgentTurnSummary[]>([]);
  const [details, setDetails] = useState<ReadonlyMap<string, AgentTurnDetail>>(() => new Map());
  const detailsRef = useRef<ReadonlyMap<string, AgentTurnDetail>>(new Map());
  const [busy, setBusy] = useState(false);
  const [fileUndo, setFileUndo] = useState<AgentFileUndoState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<AgentRuntimeDiagnostics | null>(null);
  const [contextPreview, setContextPreview] = useState<{
    readonly key: string;
    readonly plan: AgentContextPlanPreview;
  } | null>(null);
  const [contextReviewBusy, setContextReviewBusy] = useState(false);
  const [llmSettings, setLlmSettings] = useState<AgentLlmSettingsView | null>(null);
  const llmSettingsGenerationRef = useRef(0);
  const [modelSwitchBusy, setModelSwitchBusy] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [queue, setQueue] = useState<readonly AgentQueueItem[]>([]);
  const queueRef = useRef<readonly AgentQueueItem[]>([]);
  const queueSequenceRef = useRef(0);
  const dispatchingRef = useRef(false);
  const dispatchHaltedRef = useRef(false);
  const dispatchReconcileRef = useRef(false);
  const [proposalDiffs, setProposalDiffs] = useState<ReadonlyMap<string, AgentProposalDiffState>>(
    () => new Map(),
  );
  const proposalDiffsRef = useRef<ReadonlyMap<string, AgentProposalDiffState>>(new Map());
  const presentationInFlightRef = useRef<Set<string>>(new Set());
  const frameRefreshScheduledRef = useRef(false);
  const lastFrameEventIdRef = useRef<number | null>(null);
  const activationVersionRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const mutationRef = useRef<symbol | null>(null);
  const runtimeOutputContextRef = useRef(runtimeOutputContext);
  runtimeOutputContextRef.current = runtimeOutputContext;
  const conversationValidationRef = useRef<AgentConversationValidation>({
    conversationId: view.conversation_id,
    status: "pending",
  });
  const [conversationValidation, setConversationValidation] = useState<AgentConversationValidation>(
    conversationValidationRef.current,
  );
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
  useLayoutEffect(() => {
    const version = activationVersionRef.current + 1;
    activationVersionRef.current = version;
    mutationRef.current = null;
    conversationsRef.current = [];
    turnsRef.current = [];
    detailsRef.current = new Map();
    queueRef.current = [];
    dispatchingRef.current = false;
    dispatchHaltedRef.current = false;
    dispatchReconcileRef.current = false;
    proposalDiffsRef.current = new Map();
    presentationInFlightRef.current = new Set();
    frameRefreshScheduledRef.current = false;
    lastFrameEventIdRef.current = null;
    setConversations([]);
    setTurns([]);
    setDetails(new Map());
    setQueue([]);
    setProposalDiffs(new Map());
    setBusy(false);
    setContextReviewBusy(false);
    return () => {
      if (activationVersionRef.current === version) activationVersionRef.current = version + 1;
      refreshGenerationRef.current += 1;
      mutationRef.current = null;
    };
  }, [
    instance.activation_generation,
    instance.instance_id,
    instance.project_id,
  ]);
  const activationIsCurrent = useCallback(
    (version: number) => activationVersionRef.current === version,
    [],
  );
  const refreshIsCurrent = useCallback(
    (token: AgentRefreshToken) => activationIsCurrent(token.activationVersion)
      && refreshGenerationRef.current === token.generation,
    [activationIsCurrent],
  );

  const buildContextPlanKey = (
    state: AgentSurfaceViewState,
    runtimeSnapshot: RuntimeOutputReference | null,
  ) => JSON.stringify([
    state.composer.trim(),
    state.mode,
    state.conversation_id,
    runtimeSnapshot?.execution_id ?? null,
    runtimeSnapshot?.start_sequence ?? null,
    runtimeSnapshot?.end_sequence ?? null,
    runtimeSnapshot?.range_sha256 ?? null,
  ]);
  const contextPlanKey = buildContextPlanKey(view, runtimeOutputContextRef.current);

  const refresh = useCallback((
    activationVersion: number,
    preferredConversationId = viewRef.current.conversation_id,
  ): AgentRefreshOperation => {
    if (!activationIsCurrent(activationVersion)) {
      return {
        token: { activationVersion, generation: refreshGenerationRef.current },
        promise: Promise.resolve(),
      };
    }
    const refreshGeneration = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = refreshGeneration;
    const token = { activationVersion, generation: refreshGeneration };
    const pendingValidation: AgentConversationValidation = {
      conversationId: preferredConversationId,
      status: "pending",
    };
    conversationValidationRef.current = pendingValidation;
    setConversationValidation(pendingValidation);
    setLoading(true);
    setRefreshError(null);
    const promise = (async () => {
      try {
        const nextConversations = await transport.listAgentConversations(50);
        if (!refreshIsCurrent(token)) return;
        const preferredIsAvailable = nextConversations.some(
          (conversation) => conversation.conversation_id === preferredConversationId,
        );
        const selected = preferredIsAvailable ? preferredConversationId : null;
        const nextTurns = selected == null ? [] : await transport.listAgentTurns(selected, 50);
        if (!refreshIsCurrent(token)) return;
        const loadedDetails = await Promise.all(nextTurns.slice(0, 20).map(async (turn) => [
          turn.turn_id,
          await transport.getAgentTurnDetail(turn.turn_id),
        ] as const));
        if (!refreshIsCurrent(token)) return;
        const nextDetails = new Map(loadedDetails.flatMap(([turnId, detail]) =>
          detail == null ? [] : [[turnId, detail] as const]
        ));
        conversationsRef.current = nextConversations;
        turnsRef.current = nextTurns;
        detailsRef.current = nextDetails;
        setConversations(nextConversations);
        setTurns(nextTurns);
        setDetails(nextDetails);
        const settledValidation: AgentConversationValidation = {
          conversationId: preferredConversationId,
          status: preferredConversationId == null || preferredIsAvailable ? "available" : "unavailable",
        };
        conversationValidationRef.current = settledValidation;
        setConversationValidation(settledValidation);
        dispatchReconcileRef.current = false;
        setLoading(false);
      } catch (error: unknown) {
        if (refreshIsCurrent(token)) {
          setLoading(false);
          setRefreshError(agentErrorMessage(error));
        }
        throw error;
      }
    })();
    return { token, promise };
  }, [activationIsCurrent, refreshIsCurrent, transport]);
  const refreshCurrent = useCallback(async (
    activationVersion: number,
    preferredConversationId = viewRef.current.conversation_id,
  ) => {
    const operation = refresh(activationVersion, preferredConversationId);
    try {
      await operation.promise;
    } catch (error: unknown) {
      if (refreshIsCurrent(operation.token)) throw error;
    }
  }, [refresh, refreshIsCurrent]);

  useEffect(() => {
    const next = initialAgentSurfaceState(instance);
    viewRef.current = next;
    setView(next);
    const pendingValidation: AgentConversationValidation = {
      conversationId: next.conversation_id,
      status: "pending",
    };
    conversationValidationRef.current = pendingValidation;
    setConversationValidation(pendingValidation);
  }, [
    instance.activation_generation,
    instance.instance_id,
    instance.project_id,
    instance.surface_revision,
  ]);

  useEffect(() => {
    let active = true;
    const activationVersion = activationVersionRef.current;
    const load = async () => {
      const operation = refresh(activationVersion, viewRef.current.conversation_id);
      try {
        await operation.promise;
      } catch (error: unknown) {
        if (active && refreshIsCurrent(operation.token)) reportError(error);
      }
    };
    void load();
    const unsubscribe = transport.subscribeAgentInvalidated(() => void load());
    return () => {
      active = false;
      refreshGenerationRef.current += 1;
      unsubscribe();
    };
  }, [
    instance.activation_generation,
    instance.instance_id,
    instance.project_id,
    instance.surface_revision,
    refresh,
    refreshIsCurrent,
    reportError,
    transport,
  ]);

  const requestFrameRefresh = useCallback((activationVersion: number) => {
    if (!activationIsCurrent(activationVersion) || frameRefreshScheduledRef.current) return;
    frameRefreshScheduledRef.current = true;
    queueMicrotask(() => {
      frameRefreshScheduledRef.current = false;
      if (!activationIsCurrent(activationVersion)) return;
      void refreshCurrent(activationVersion, viewRef.current.conversation_id).catch((error: unknown) => {
        if (activationIsCurrent(activationVersion)) reportError(error);
      });
    });
  }, [activationIsCurrent, refreshCurrent, reportError]);

  useEffect(() => {
    const activationVersion = activationVersionRef.current;
    const applyFrame = (frame: AgentTurnEventFrame) => {
      if (!activationIsCurrent(activationVersion)) return;
      const incoming = frame.event;
      if (incoming != null) {
        const previousEventId = lastFrameEventIdRef.current;
        if (previousEventId != null && incoming.id > previousEventId + 1) {
          requestFrameRefresh(activationVersion);
        }
        lastFrameEventIdRef.current = Math.max(previousEventId ?? incoming.id, incoming.id);
      }
      const requestsDecision = incoming?.event_type === "approval.requested"
        || incoming?.event_type === "environment.requested";

      const projectedTurn = turnsRef.current.find((turn) => turn.turn_id === frame.turn_id);
      const selectedRoot = conversationsRef.current.find(
        (conversation) => conversation.conversation_id === viewRef.current.conversation_id,
      )?.project_root;
      const belongsToLoadedProject = selectedRoot === frame.project_root
        || conversationsRef.current.some((conversation) => conversation.project_root === frame.project_root);
      const projectMembershipUnknown = conversationsRef.current.length === 0;
      if (projectedTurn == null || projectedTurn.project_root !== frame.project_root) {
        if ((belongsToLoadedProject || projectMembershipUnknown)
            && (frame.payload_truncated || requestsDecision)) {
          requestFrameRefresh(activationVersion);
        }
        return;
      }
      if (frame.payload_truncated) {
        requestFrameRefresh(activationVersion);
        return;
      }

      // Approval requests mutate canonical detail outside the event row itself.
      // Always refetch so the waiting status and decision surface arrive before
      // the backend blocks waiting for the user's response.
      let reconcile = requestsDecision;
      const update = frame.turn_update;
      if (update != null) {
        const nextTurns = turnsRef.current.map((turn) => turn.turn_id === frame.turn_id ? {
          ...turn,
          status: update.status as AgentTurnSummary["status"],
          final_message: update.final_message ?? turn.final_message,
          error_message: update.error_message,
          terminal_reason: update.terminal_reason,
        } : turn);
        turnsRef.current = nextTurns;
        setTurns(nextTurns);
        const detail = detailsRef.current.get(frame.turn_id);
        if (detail == null) {
          reconcile = true;
        } else {
          const nextDetails = new Map(detailsRef.current);
          nextDetails.set(frame.turn_id, {
            ...detail,
            turn: {
              ...detail.turn,
              status: update.status as AgentTurnSummary["status"],
              final_message: update.final_message ?? detail.turn.final_message,
              error_message: update.error_message,
              terminal_reason: update.terminal_reason,
            },
          });
          detailsRef.current = nextDetails;
          setDetails(nextDetails);
        }
        if (update.status !== "running" && update.status !== "waiting") reconcile = true;
      }

      if (incoming != null) {
        const detail = detailsRef.current.get(frame.turn_id);
        if (detail == null) {
          reconcile = true;
        } else if (!detail.events.some((event) => event.id === incoming.id)) {
          const maxId = detail.events.reduce((maximum, event) => Math.max(maximum, event.id), 0);
          if (incoming.id <= maxId) {
            reconcile = true;
          } else {
            const nextDetails = new Map(detailsRef.current);
            nextDetails.set(frame.turn_id, { ...detail, events: [...detail.events, incoming] });
            detailsRef.current = nextDetails;
            setDetails(nextDetails);
          }
        }
      }
      if (reconcile) requestFrameRefresh(activationVersion);
    };
    return transport.subscribeAgentTurnEvents(applyFrame);
  }, [
    activationIsCurrent,
    instance.activation_generation,
    instance.instance_id,
    instance.project_id,
    requestFrameRefresh,
    transport,
  ]);

  useEffect(() => transport.subscribeResourcesInvalidated(() => {
    proposalDiffsRef.current = new Map();
    setProposalDiffs(new Map());
  }), [
    instance.activation_generation,
    instance.instance_id,
    instance.project_id,
    transport,
  ]);

  useEffect(() => {
    let active = true;
    void transport.getAgentRuntimeDiagnostics()
      .then((diagnostics) => { if (active) setRuntimeDiagnostics(diagnostics); })
      .catch((error: unknown) => { if (active) reportError(error); });
    return () => { active = false; };
  }, [health?.state, reportError, transport]);

  const reloadLlmSettings = useCallback(() => {
    const generation = llmSettingsGenerationRef.current + 1;
    llmSettingsGenerationRef.current = generation;
    void transport.loadAgentLlmSettings()
      .then((settings) => {
        if (llmSettingsGenerationRef.current === generation) setLlmSettings(settings);
      })
      .catch((error: unknown) => {
        if (llmSettingsGenerationRef.current === generation) reportError(error);
      });
  }, [reportError, transport]);
  useEffect(() => {
    reloadLlmSettings();
    return () => { llmSettingsGenerationRef.current += 1; };
  }, [reloadLlmSettings]);
  useEffect(() => subscribeAgentSettingsChanged((source) => {
    if (source !== "agent") reloadLlmSettings();
  }), [reloadLlmSettings]);

  const viewStateWriteBlocked = busy || contextReviewBusy;
  const commitView = (
    update: (current: AgentSurfaceViewState) => AgentSurfaceViewState,
    durable = true,
  ) => {
    if (viewStateWriteBlocked || mutationRef.current != null) return;
    const current = viewRef.current;
    const next = update(current);
    if (next.composer !== current.composer || next.mode !== current.mode ||
        next.conversation_id !== current.conversation_id) setContextPreview(null);
    viewRef.current = next;
    setView(next);
    if (durable) void persist(next).catch(reportError);
  };
  const selectChatModel = async (modelId: string) => {
    if (llmSettings == null || modelSwitchBusy) return;
    const activationVersion = activationVersionRef.current;
    const mutation = beginMutation("agent-chat-model-select");
    if (mutation == null) return;
    setModelSwitchBusy(true);
    try {
      const settings = await transport.selectAgentChatModel({
        modelId,
        expectedRevision: llmSettings.revision,
        expectedConfigSnapshotId: llmSettings.config_store.config_snapshot_id,
      });
      if (!activationIsCurrent(activationVersion)) return;
      setLlmSettings(settings);
      announceAgentSettingsChanged("agent");
      setContextPreview(null);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      if (activationIsCurrent(activationVersion)) setModelSwitchBusy(false);
      endMutation(mutation);
    }
  };
  const selectConversation = async (
    conversationId: string,
    activationVersion = activationVersionRef.current,
  ) => {
    const mutation = beginMutation("agent-conversation-selection");
    if (mutation == null) return;
    refreshGenerationRef.current += 1;
    const selectedConversationId = conversationId === "" ? null : conversationId;
    const next = { ...viewRef.current, conversation_id: selectedConversationId };
    try {
      await persist(next);
      if (!activationIsCurrent(activationVersion)) return;
      viewRef.current = next;
      setView(next);
      await refreshCurrent(activationVersion, selectedConversationId);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      endMutation(mutation);
    }
  };
  const newConversation = async () => {
    const activationVersion = activationVersionRef.current;
    const mutation = beginMutation("agent-conversation-workflow");
    if (mutation == null) return;
    refreshGenerationRef.current += 1;
    try {
      const next = await createConversation(viewRef.current);
      if (!activationIsCurrent(activationVersion)) return;
      refreshGenerationRef.current += 1;
      viewRef.current = next;
      setView(next);
      await refreshCurrent(activationVersion, next.conversation_id);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) {
        reportError(error);
        refreshGenerationRef.current += 1;
        try {
          await refreshCurrent(activationVersion, viewRef.current.conversation_id);
        } catch (refreshError: unknown) {
          if (activationIsCurrent(activationVersion)) reportError(refreshError);
        }
      }
    } finally {
      endMutation(mutation);
    }
  };
  const conversationRequestIsAvailable = (state: AgentSurfaceViewState) => {
    const validation = conversationValidationRef.current;
    return validation.status === "available"
      && validation.conversationId === state.conversation_id;
  };
  const turnMutationIsAvailable = (turn: AgentTurnSummary) => {
    const current = viewRef.current;
    return current.conversation_id === turn.conversation_id
      && conversationRequestIsAvailable(current);
  };
  const rejectFileProposal = async (turn: AgentTurnSummary, key: string) => {
    if (!turnMutationIsAvailable(turn) || viewRef.current.file_decisions[key] === "rejected") return;
    const activationVersion = activationVersionRef.current;
    const mutation = beginMutation("agent-file-reject");
    if (mutation == null) return;
    try {
      if (!turnMutationIsAvailable(turn) || viewRef.current.file_decisions[key] === "rejected") return;
      const current = viewRef.current;
      const next = {
        ...current,
        file_decisions: { ...current.file_decisions, [key]: "rejected" as const },
      };
      await persist(next);
      if (!activationIsCurrent(activationVersion)) return;
      const latest = viewRef.current;
      const adopted = {
        ...latest,
        file_decisions: { ...latest.file_decisions, [key]: "rejected" as const },
      };
      viewRef.current = adopted;
      setView(adopted);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      endMutation(mutation);
    }
  };
  const storeProposalDiff = (key: string, state: AgentProposalDiffState | undefined) => {
    const next = new Map(proposalDiffsRef.current);
    if (state == null) next.delete(key);
    else next.set(key, state);
    proposalDiffsRef.current = next;
    setProposalDiffs(next);
  };
  const loadProposalDiff = async (
    turn: AgentTurnSummary,
    eventId: number,
    proposal: AgentFileProposal,
  ) => {
    const key = `${turn.turn_id}:${eventId}`;
    if (proposalDiffsRef.current.has(key) || !turnMutationIsAvailable(turn)) return;
    const activationVersion = activationVersionRef.current;
    storeProposalDiff(key, { status: "loading" });
    try {
      if (proposal.operation === "create") {
        if (activationIsCurrent(activationVersion) && turnMutationIsAvailable(turn)) {
          storeProposalDiff(key, {
            status: "ready",
            before: "",
            expected_disk_sha256: null,
          });
        }
        return;
      }
      const registry = await transport.loadResources();
      const matches = (candidate: {
        readonly resource_provider_id: string;
        readonly resource_kind: string;
        readonly resource_id: string;
      }) => candidate.resource_provider_id === "rho.project-files"
        && candidate.resource_kind === "project_file"
        && candidate.resource_id === proposal.path;
      let descriptor = registry.resources.find(matches);
      if (descriptor == null) {
        const resolved = await transport.resolveResource({
          project_id: registry.project_id,
          resource_provider_id: "rho.project-files",
          resource_kind: "project_file",
          resource_id: proposal.path,
          expected_project_revision: registry.project_revision,
          expected_snapshot_revision: registry.snapshot_revision,
        });
        descriptor = resolved.resources.find(matches);
      }
      if (descriptor == null || descriptor.status !== "ready" || descriptor.content_sha256 == null) {
        if (activationIsCurrent(activationVersion)) storeProposalDiff(key, { status: "unavailable" });
        return;
      }
      const content = await transport.readResource({
        target: {
          project_id: registry.project_id,
          resource_provider_id: descriptor.resource_provider_id,
          resource_kind: descriptor.resource_kind,
          resource_id: descriptor.resource_id,
          expected_project_revision: registry.project_revision,
          expected_resource_revision: descriptor.resource_revision,
        },
        consistency: "shared_document",
      });
      if (activationIsCurrent(activationVersion) && turnMutationIsAvailable(turn)) {
        storeProposalDiff(key, {
          status: "ready",
          before: content.content,
          expected_disk_sha256: descriptor.content_sha256,
        });
      }
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) {
        reportError(error);
        storeProposalDiff(key, { status: "unavailable" });
      }
    }
  };
  const pinTurn = async (turn: AgentTurnSummary) => {
    if (!turnMutationIsAvailable(turn)) return;
    const activationVersion = activationVersionRef.current;
    const mutation = beginMutation("agent-pin-vibe");
    if (mutation == null) return;
    try {
      if (!turnMutationIsAvailable(turn)) return;
      await pinTask(turn);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      endMutation(mutation);
    }
  };
  const presentStudio = useCallback(async (
    turn: AgentTurnSummary,
    eventId: number,
    presentation: AgentStudioPresentation,
  ) => {
    const key = agentStudioPresentationKey(turn.turn_id, eventId);
    if (presentationInFlightRef.current.has(key)) return;
    const currentStatus = viewRef.current.studio_presentations?.[key];
    if (currentStatus === "presented" || currentStatus === "presenting") return;
    const activationVersion = activationVersionRef.current;
    presentationInFlightRef.current.add(key);
    const storeStatus = async (status: "presenting" | "presented" | "failed") => {
      const current = viewRef.current;
      const next: AgentSurfaceViewState = {
        ...current,
        studio_presentations: {
          ...(current.studio_presentations ?? {}),
          [key]: status,
        },
      };
      if (activationIsCurrent(activationVersion)) {
        viewRef.current = next;
        setView(next);
      }
      await persist(next);
    };
    try {
      await storeStatus("presenting");
      if (!activationIsCurrent(activationVersion)) return;
      await presentInStudio(turn, presentation);
      await storeStatus("presented");
    } catch (error: unknown) {
      try {
        await storeStatus("failed");
      } catch { /* the original presentation failure remains authoritative */ }
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      presentationInFlightRef.current.delete(key);
    }
  }, [activationIsCurrent, persist, presentInStudio, reportError]);
  const reviewContext = async () => {
    const activationVersion = activationVersionRef.current;
    const current = viewRef.current;
    const runtimeSnapshot = runtimeOutputContextRef.current;
    const prompt = current.composer.trim();
    if (!prompt || contextReviewBusy || busy || health?.state !== "ready" || !modeReady ||
        !conversationRequestIsAvailable(current)) return;
    const mutation = beginMutation("agent-context-review");
    if (mutation == null) return;
    setContextReviewBusy(true);
    try {
      const plan = await transport.previewAgentContext({
        prompt,
        mode: current.mode,
        task_kind: "agent_turn",
        model_id: null,
        editor_context: null,
        conversation_id: current.conversation_id,
        runtime_output_context: runtimeSnapshot,
      });
      if (!activationIsCurrent(activationVersion)) return;
      setContextPreview({ key: buildContextPlanKey(current, runtimeSnapshot), plan });
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      if (activationIsCurrent(activationVersion)) setContextReviewBusy(false);
      endMutation(mutation);
    }
  };
  const submit = async () => {
    const activationVersion = activationVersionRef.current;
    const current = viewRef.current;
    const runtimeSnapshot = runtimeOutputContextRef.current;
    const prompt = current.composer.trim();
    if (!prompt || busy || health?.state !== "ready" || !modeReady || !conversationRequestIsAvailable(current)) return;
    const currentContextPlanKey = buildContextPlanKey(current, runtimeSnapshot);
    const reviewedPlan = contextPreview?.key === currentContextPlanKey ? contextPreview.plan : null;
    if (runtimeSnapshot != null && reviewedPlan == null) {
      await reviewContext();
      return;
    }
    const request: RunAgentRequest = {
      prompt,
      mode: current.mode,
      task_kind: "agent_turn",
      model_id: null,
      auto_approve: current.auto_approve,
      editor_context: null,
      conversation_id: current.conversation_id,
      runtime_output_context: runtimeSnapshot,
      context_plan_digest: reviewedPlan?.plan_digest ?? null,
    };
    const turnActive = turnsRef.current.some((turn) =>
      turn.conversation_id === current.conversation_id
      && (turn.status === "running" || turn.status === "waiting"));
    const conversationQueued = current.conversation_id != null && queueRef.current.some(
      (item) => item.conversation_id === current.conversation_id,
    );
    if (current.conversation_id != null && (turnActive || conversationQueued || dispatchingRef.current)) {
      queueSequenceRef.current += 1;
      const item: AgentQueueItem = {
        id: `queue-${queueSequenceRef.current}`,
        conversation_id: current.conversation_id,
        prompt,
        request,
        queued_at: new Date().toISOString(),
      };
      const nextQueue = [...queueRef.current, item];
      queueRef.current = nextQueue;
      setQueue(nextQueue);
      dispatchHaltedRef.current = false;
      const next = { ...current, composer: "" };
      viewRef.current = next;
      setView(next);
      void persist(next).catch(reportError);
      runtimeOutputContextRef.current = null;
      setRuntimeOutputContext(null);
      setContextPreview(null);
      return;
    }
    const mutation = beginMutation("agent-turn-workflow");
    if (mutation == null) return;
    refreshGenerationRef.current += 1;
    let acceptedConversationId: string | null = null;
    const adoptAcceptedConversation = (conversationId: string) => {
      acceptedConversationId = conversationId;
      if (!activationIsCurrent(activationVersion)) return;
      refreshGenerationRef.current += 1;
      const accepted = { ...viewRef.current, conversation_id: conversationId, composer: "" };
      viewRef.current = accepted;
      setView(accepted);
      const pendingValidation: AgentConversationValidation = {
        conversationId,
        status: "pending",
      };
      conversationValidationRef.current = pendingValidation;
      setConversationValidation(pendingValidation);
      runtimeOutputContextRef.current = null;
      setRuntimeOutputContext(null);
      setContextPreview(null);
    };
    try {
      const next = await runConversation(current, request, adoptAcceptedConversation);
      if (!activationIsCurrent(activationVersion)) return;
      refreshGenerationRef.current += 1;
      viewRef.current = next;
      setView(next);
      runtimeOutputContextRef.current = null;
      setRuntimeOutputContext(null);
      setContextPreview(null);
      await refreshCurrent(activationVersion, next.conversation_id);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) {
        reportError(error);
        refreshGenerationRef.current += 1;
        try {
          await refreshCurrent(
            activationVersion,
            acceptedConversationId ?? viewRef.current.conversation_id,
          );
        } catch (refreshError: unknown) {
          if (activationIsCurrent(activationVersion)) reportError(refreshError);
        }
      }
    } finally {
      endMutation(mutation);
    }
  };
  const cancelQueued = (id: string) => {
    const next = queueRef.current.filter((item) => item.id !== id);
    queueRef.current = next;
    setQueue(next);
    dispatchHaltedRef.current = false;
  };
  const moveQueuedUp = (id: string) => {
    const index = queueRef.current.findIndex((item) => item.id === id);
    if (index < 0) return;
    const conversationId = queueRef.current[index]!.conversation_id;
    let previous = index - 1;
    while (previous >= 0 && queueRef.current[previous]!.conversation_id !== conversationId) previous -= 1;
    if (previous < 0) return;
    const next = [...queueRef.current];
    [next[previous], next[index]] = [next[index]!, next[previous]!];
    queueRef.current = next;
    setQueue(next);
    dispatchHaltedRef.current = false;
  };

  useEffect(() => {
    const activationVersion = activationVersionRef.current;
    const current = viewRef.current;
    if (dispatchingRef.current || dispatchHaltedRef.current || dispatchReconcileRef.current) return;
    if (mutationRef.current != null || health?.state !== "ready" || !conversationRequestIsAvailable(current)) return;
    if (current.conversation_id == null) return;
    if (turnsRef.current.some((turn) => turn.conversation_id === current.conversation_id
      && (turn.status === "running" || turn.status === "waiting"))) return;
    const headIndex = queueRef.current.findIndex(
      (item) => item.conversation_id === current.conversation_id,
    );
    if (headIndex < 0) return;
    const head = queueRef.current[headIndex]!;
    const mutation = beginMutation("agent-queue-dispatch");
    if (mutation == null) return;
    refreshGenerationRef.current += 1;
    dispatchingRef.current = true;
    const remaining = [...queueRef.current];
    remaining.splice(headIndex, 1);
    queueRef.current = remaining;
    setQueue(remaining);
    let accepted = false;
    void (async () => {
      try {
        const currentAtDispatch = viewRef.current;
        const preservedComposer = currentAtDispatch.composer;
        const next = await runConversation(currentAtDispatch, head.request, () => {
          accepted = true;
        });
        accepted = true;
        if (!activationIsCurrent(activationVersion)) return;
        const adopted = { ...next, composer: preservedComposer };
        viewRef.current = adopted;
        setView(adopted);
        setContextPreview(null);
        if (preservedComposer !== next.composer) {
          try {
            await persist(adopted);
          } catch (error: unknown) {
            if (activationIsCurrent(activationVersion)) reportError(error);
          }
        }
        try {
          await refreshCurrent(activationVersion, head.conversation_id);
        } catch (error: unknown) {
          if (activationIsCurrent(activationVersion)) {
            dispatchReconcileRef.current = true;
            reportError(error);
          }
        }
      } catch (error: unknown) {
        if (!activationIsCurrent(activationVersion)) return;
        if (!accepted) {
          const restored = [...queueRef.current];
          restored.splice(Math.min(headIndex, restored.length), 0, head);
          queueRef.current = restored;
          setQueue(restored);
          dispatchHaltedRef.current = true;
        } else {
          dispatchReconcileRef.current = true;
          requestFrameRefresh(activationVersion);
        }
        reportError(error);
      } finally {
        dispatchingRef.current = false;
        endMutation(mutation);
      }
    })();
  }, [
    activationIsCurrent,
    busy,
    conversationValidation.conversationId,
    conversationValidation.status,
    health?.state,
    persist,
    queue,
    refreshCurrent,
    reportError,
    requestFrameRefresh,
    runConversation,
    turns,
    view.conversation_id,
  ]);
  useEffect(() => {
    for (const turn of turns) {
      if (turn.status !== "completed") continue;
      const detail = details.get(turn.turn_id);
      let candidate: ReturnType<typeof parseAgentStudioPresentation> = null;
      for (let index = (detail?.events.length ?? 0) - 1; index >= 0; index -= 1) {
        candidate = parseAgentStudioPresentation(detail!.events[index]!);
        if (candidate != null) break;
      }
      if (candidate == null) continue;
      const key = agentStudioPresentationKey(turn.turn_id, candidate.event.id);
      if (view.studio_presentations?.[key] != null || presentationInFlightRef.current.has(key)) {
        continue;
      }
      void presentStudio(turn, candidate.event.id, candidate.presentation);
      break;
    }
  }, [details, presentStudio, turns, view.studio_presentations]);
  const displayMode = instance.mode_id ?? "conversation";
  const chatRoute = llmSettings?.capability_routes.find((route) => route.capability === "agent.chat");
  const actRoute = llmSettings?.capability_routes.find((route) => route.capability === "agent.act");
  const chatModelLabel = chatRoute?.model_display_name
    ?? llmSettings?.selected_model?.display_name
    ?? (llmSettings == null ? "Loading model…" : "Set up a model");
  const activeChatModelId = chatRoute?.model_id ?? llmSettings?.selected_model_id ?? null;
  const activeChatModel = llmSettings?.models.find((model) => model.id === activeChatModelId) ?? null;
  const activeProviderId = activeChatModel?.provider_id ?? null;
  const chatReady = chatRoute?.consumer_status === "ready";
  const actReady = actRoute?.consumer_status === "ready";
  const modeReady = actReady;
  const switchableModels = (llmSettings?.models ?? [])
    .filter((model) => model.enabled && ["language", "unknown"].includes(model.model_type.value));
  const normalizedModelQuery = modelQuery.trim().toLowerCase();
  const filteredModels = normalizedModelQuery === "" ? switchableModels : switchableModels.filter((model) =>
    model.display_name.toLowerCase().includes(normalizedModelQuery) ||
    model.model_id.toLowerCase().includes(normalizedModelQuery) ||
    model.provider_display_name.toLowerCase().includes(normalizedModelQuery));
  const modelGroups = new Map<string, Array<(typeof switchableModels)[number]>>();
  for (const model of filteredModels) {
    const group = modelGroups.get(model.provider_display_name);
    if (group == null) modelGroups.set(model.provider_display_name, [model]);
    else group.push(model);
  }
  const setupIssue = llmSettings == null ? null
    : llmSettings.models.length === 0 ? "Connect a model service to start using Agent."
      : chatRoute?.consumer_status === "needs_credential" ? "Add the Provider API key to use this model."
        : !chatReady ? "Choose a usable chat model in Provider Settings."
          : !actReady ? "Autonomous work needs a model with verified tool calling."
            : null;
  const activeTurn = turns.find((turn) => turn.status === "running" || turn.status === "waiting");
  const currentQueue = view.conversation_id == null
    ? []
    : queue.filter((item) => item.conversation_id === view.conversation_id);
  const postureLabel = view.auto_approve ? "Auto-approve tools" : "Ask every time";
  const validationMatchesView = conversationValidation.conversationId === view.conversation_id;
  const conversationValidationPending = !validationMatchesView || conversationValidation.status === "pending";
  const selectedConversationUnavailable = validationMatchesView
    && conversationValidation.status === "unavailable";
  const selectedConversationListed = view.conversation_id == null || conversations.some(
    (conversation) => conversation.conversation_id === view.conversation_id,
  );
  const showSyntheticConversation = view.conversation_id != null && !selectedConversationListed;
  const conversationRequestBlocked = conversationValidationPending || selectedConversationUnavailable;
  const turnMutationRenderBlocked = (turn: AgentTurnSummary) => busy
    || conversationRequestBlocked
    || view.conversation_id !== turn.conversation_id;
  const stopActiveTurn = activeTurn == null ? null : () => {
    if (!turnMutationIsAvailable(activeTurn)) return;
    const activationVersion = activationVersionRef.current;
    const mutation = beginMutation("agent-turn-cancel");
    if (mutation == null) return;
    if (!turnMutationIsAvailable(activeTurn)) {
      endMutation(mutation);
      return;
    }
    void (async () => {
      try {
        await transport.cancelAgentTurn(activeTurn.turn_id);
        await refreshCurrent(activationVersion);
      } catch (error: unknown) {
        if (activationIsCurrent(activationVersion)) reportError(error);
      } finally {
        endMutation(mutation);
      }
    })();
  };
  const runAndRefresh = async (
    turn: AgentTurnSummary,
    operation: () => Promise<unknown>,
  ) => {
    if (!turnMutationIsAvailable(turn)) return;
    const activationVersion = activationVersionRef.current;
    const mutation = beginMutation("agent-turn-follow-up");
    if (mutation == null) return;
    try {
      if (!turnMutationIsAvailable(turn)) return;
      await operation();
      if (activationIsCurrent(activationVersion)) await refreshCurrent(activationVersion);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      endMutation(mutation);
    }
  };
  const retryRefresh = async () => {
    if (mutationRef.current != null || loading) return;
    const activationVersion = activationVersionRef.current;
    try {
      await refreshCurrent(activationVersion, viewRef.current.conversation_id);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    }
  };
  const diagnosticsText = runtimeDiagnostics == null ? "Agent runtime diagnostics are loading." : [
    "R",
    `  executable: ${runtimeDiagnostics.rscript ?? "not resolved"}`,
    `  version:    ${runtimeDiagnostics.r_version ?? "unknown"}`,
    "",
    "Agent runtime",
    ...runtimeDiagnostics.dependencies.flatMap((dependency) => [
      `  ${dependency.package}:`,
      `    installed: ${dependency.installed_version ?? "missing"}`,
      `    required:  >= ${dependency.required_version}`,
      `    status:    ${dependency.status}`,
      `    path:      ${dependency.resolved_path ?? "not resolved"}`,
      ...(dependency.detail == null ? [] : [`    detail:    ${dependency.detail}`]),
      ...(dependency.remediation == null ? [] : [`    fix:       ${dependency.remediation}`]),
    ]),
    "",
    `Provider adapters: ${runtimeDiagnostics.provider_adapters_available ? "ready" : "unavailable"}`,
    `Provider health:   ${runtimeDiagnostics.provider_health}`,
    "Workspace R remains independent and available when healthy.",
  ].join("\n");

  return (
    <section className={`rho-agent-surface rho-agent-${displayMode}`}>
      {health?.state !== "ready" && (
        <div className="rho-agent-degraded" role="status">
          <div className="rho-agent-degraded-row">
            <div>
              <strong>{health?.label ?? "Agent runtime unavailable"}</strong>
              {health?.detail != null && <p>{health.detail}</p>}
            </div>
            <button type="button" disabled={busy} onClick={() => {
              const activationVersion = activationVersionRef.current;
              const mutation = beginMutation("agent-runtime-retry");
              if (mutation == null) return;
              void (async () => {
                try {
                  const diagnostics = await transport.retryAgentRuntime();
                  if (!activationIsCurrent(activationVersion)) return;
                  setRuntimeDiagnostics(diagnostics);
                  await refreshCurrent(activationVersion);
                } catch (error: unknown) {
                  if (activationIsCurrent(activationVersion)) reportError(error);
                } finally {
                  endMutation(mutation);
                }
              })();
            }}>Retry Agent runtime</button>
          </div>
          <details className="rho-agent-runtime-diagnostics">
            <summary>Dependency details</summary>
            <pre>{diagnosticsText}</pre>
            <button type="button" onClick={() => {
              void navigator.clipboard.writeText(diagnosticsText).catch(reportError);
            }}>Copy diagnostics</button>
          </details>
        </div>
      )}
      {setupIssue != null && <div className="rho-agent-model-setup" role="status">
        <div><strong>Model setup needs attention</strong><span>{setupIssue}</span></div>
        <button type="button" onClick={() => openModelSettings(activeProviderId, activeChatModelId)}>Open Provider Settings</button>
      </div>}
      <header className="rho-agent-toolbar">
        <select
          aria-label={`Conversation for ${instance.instance_id}`}
          value={view.conversation_id ?? ""}
          disabled={busy}
          onChange={(event) => void selectConversation(event.target.value)}
        >
          <option value="">No conversation</option>
          {showSyntheticConversation && <option value={view.conversation_id!} disabled>
            {conversationValidationPending
              ? "Checking selected conversation…"
              : "Selected conversation unavailable"}
          </option>}
          {conversations.map((conversation) => (
            <option value={conversation.conversation_id} key={conversation.conversation_id}>
              {conversation.title} · {conversation.turn_count}
              {conversation.status === "waiting" ? " · Needs attention" : ""}
            </option>
          ))}
        </select>
        <button type="button" className="rho-agent-toolbar-action" disabled={busy} onClick={() => void newConversation()}>New</button>
        <button type="button" className="rho-agent-toolbar-action" disabled={busy} onClick={() => {
          openModelSettings(activeProviderId, activeChatModelId);
        }}>Models</button>
      </header>
      <section className="rho-agent-overview" aria-label="Agent status and policy">
        <div>
          <span className="rho-agent-section-label">Autonomous Agent</span>
          <strong>Goal-driven scientific work</strong>
          <p>Rho observes current context, plans internally, requests governed effects, and re-observes committed results.</p>
        </div>
        <dl>
          <div><dt>Provider</dt><dd>{chatModelLabel}</dd></div>
          <div><dt>Permission</dt><dd>{postureLabel}</dd></div>
          <div><dt>State</dt><dd>{activeTurn == null ? "Ready" : agentTurnStatusLabel(activeTurn.status)}</dd></div>
        </dl>
      </section>
      {displayMode === "activity" && activeTurn != null && stopActiveTurn != null && (
        <AgentRunningRow
          status={activeTurn.status}
          startedAt={activeTurn.started_at}
          disabled={turnMutationRenderBlocked(activeTurn)}
          onStop={stopActiveTurn}
        />
      )}
      {displayMode !== "composer" && (
        <div className="rho-agent-timeline" aria-busy={loading}>
          <header className="rho-agent-current-work-header">
            <div><span className="rho-agent-section-label">Current Work</span><strong>{activeTurn == null ? "Conversation" : activeTurn.prompt_preview}</strong></div>
            <span>{turns.length} {turns.length === 1 ? "turn" : "turns"}</span>
          </header>
          {loading && <p className="rho-agent-loading">Loading conversation…</p>}
          {!loading && refreshError != null && <div className="rho-agent-empty" role="alert">
            <strong>Conversation refresh failed</strong>
            <span>{refreshError}</span>
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void retryRefresh()}
            >Retry refresh</button>
          </div>}
          {!loading && refreshError == null && turns.length === 0 && <div className="rho-agent-empty" role="status">
            <strong>{selectedConversationUnavailable
              ? "Selected conversation unavailable"
              : view.conversation_id == null ? "No conversation yet" : "Ready for the first turn"}</strong>
            <span>{selectedConversationUnavailable
              ? "Choose No conversation or a listed conversation before reviewing context or sending."
              : view.conversation_id == null
                ? "Write below and send; Rho opens a conversation and keeps the thread, run state, and decisions here."
                : "Describe the goal below; Rho will observe, plan, request effects, and re-observe as needed."}</span>
            <div className="rho-agent-suggestions">
              {AGENT_SUGGESTIONS.map((suggestion) => (
                <button
                  type="button"
                  disabled={viewStateWriteBlocked}
                  key={suggestion}
                  onClick={() => commitView((current) => ({ ...current, composer: suggestion }), false)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>}
          {turns.map((turn) => {
            const detail = details.get(turn.turn_id);
            const proposals = detail?.events.flatMap((event) => {
              const proposal = parseAgentFileProposal(event);
              return proposal == null ? [] : [{ event, proposal }];
            }) ?? [];
            const presentations = (detail?.events.flatMap((event) => {
              const parsed = parseAgentStudioPresentation(event);
              return parsed == null ? [] : [parsed];
            }) ?? []).slice(-1);
            const waitingApprovals = detail?.approvals.filter((approval) => approval.status === "waiting") ?? [];
            const proposalEventIds = new Set(proposals.map(({ event }) => event.id));
            const presentationEventIds = new Set(presentations.map(({ event }) => event.id));
            const activityEvents = detail?.events.filter((event) =>
              (event.tool != null || event.code != null)
              && !proposalEventIds.has(event.id)
              && !presentationEventIds.has(event.id)) ?? [];
            const contextItems = detail?.context_items ?? [];
            return (
              <article className={`rho-agent-turn rho-agent-turn-${turn.status}`} data-turn-id={turn.turn_id} key={turn.turn_id}>
                <header>
                  <strong>Agent turn</strong>
                  {turn.status !== "completed" && <span className={`rho-agent-turn-status rho-agent-turn-status-${turn.status}`}>{agentTurnStatusLabel(turn.status)}</span>}
                  <details className="rho-agent-turn-meta">
                    <summary aria-label="Details for Agent turn">Details</summary>
                    <div><span>Status</span><strong>{turn.status}</strong><span>Model</span><code>{turn.model}</code></div>
                  </details>
                </header>
                <div className="rho-agent-goal">
                  <span className="rho-agent-section-label">Goal</span>
                  <p className="rho-agent-prompt">{turn.prompt_preview}</p>
                </div>
                {turn.final_message != null && <p className="rho-agent-answer">{turn.final_message}</p>}
                {turn.error_message != null && (
                  <div className="rho-agent-turn-failure" role="alert">
                    <strong>{turn.status === "cancelled"
                      ? "Turn cancelled"
                      : turn.status === "failed" ? "Turn failed" : "Turn ended with an error"}</strong>
                    <p className="rho-agent-turn-error">{turn.error_message}</p>
                  </div>
                )}
                {turn.status === "cancelled" && turn.error_message == null && (
                  <p className="rho-agent-turn-cancelled">This turn was cancelled before completion. Retry runs it again.</p>
                )}
                {waitingApprovals.map((approval) => (
                  <section className="rho-agent-approval" key={approval.request_id}>
                    <header className="rho-agent-decision-header">
                      <span className="rho-agent-decision-kind">Approval required</span>
                      <strong>{approval.tool}</strong>
                    </header>
                    <pre>{approval.code ?? approval.arguments_json}</pre>
                    <div className="rho-agent-decision-actions">
                      <button type="button" disabled={turnMutationRenderBlocked(turn)} onClick={() => void runAndRefresh(turn, () => transport.respondAgentApproval({ request_id: approval.request_id, decision: "approve", reason: null }))}>Approve</button>
                      <button type="button" disabled={turnMutationRenderBlocked(turn)} onClick={() => void runAndRefresh(turn, () => transport.respondAgentApproval({ request_id: approval.request_id, decision: "reject", reason: "Rejected in Agent Surface" }))}>Reject</button>
                    </div>
                  </section>
                ))}
                {presentations.map(({ event, presentation }) => {
                  const key = agentStudioPresentationKey(turn.turn_id, event.id);
                  const status = view.studio_presentations?.[key];
                  return (
                    <section className="rho-agent-studio-presentation" data-presentation-key={key} key={key}>
                      <div>
                        <span className="rho-agent-decision-kind">Studio result scene</span>
                        <strong>{presentation.title}</strong>
                        <small>{[
                          presentation.code_paths.length > 0
                            ? `${presentation.code_paths.length} code ${presentation.code_paths.length === 1 ? "file" : "files"}`
                            : null,
                          presentation.execution_id == null ? null : "exact run",
                          presentation.show_plots ? "Plots" : null,
                          presentation.show_environment ? "Environment" : null,
                        ].filter((item) => item != null).join(" · ")}</small>
                      </div>
                      <span className="rho-agent-file-outcome" role={status === "presenting" ? "status" : undefined}>
                        {status === "presented" ? "ready in Studio"
                          : status === "failed" ? "arrangement failed"
                            : "arranging Studio…"}
                      </span>
                      {status === "failed" && (
                        <button
                          type="button"
                          disabled={turnMutationRenderBlocked(turn)}
                          onClick={() => void presentStudio(turn, event.id, presentation)}
                        >Retry in Studio</button>
                      )}
                    </section>
                  );
                })}
                {proposals.map(({ event, proposal }) => {
                  const key = `${turn.turn_id}:${event.id}`;
                  const outcome = detail == null ? null : agentFileProposalOutcome(detail, event.id);
                  const rejected = view.file_decisions[key] === "rejected";
                  const diffState = proposalDiffs.get(key);
                  return (
                    <section className="rho-agent-file-proposal" data-proposal-key={key} key={key}>
                      <header>
                        <span className="rho-agent-decision-kind">File change</span>
                        <strong>{proposal.operation.replaceAll("_", " ")}</strong>
                        <code>{proposal.path}</code>
                        {outcome != null && <span className="rho-agent-file-outcome">{outcome}</span>}
                        {rejected && outcome == null && <span className="rho-agent-file-outcome">rejected in this view</span>}
                        {outcome == null && !rejected && (
                          <div className="rho-agent-decision-actions">
                            <button type="button" disabled={turnMutationRenderBlocked(turn) || turn.status === "running" || turn.status === "waiting"} onClick={() => {
                              if (!turnMutationIsAvailable(turn) || viewRef.current.file_decisions[key] === "rejected") return;
                              const activationVersion = activationVersionRef.current;
                              const mutation = beginMutation("agent-file-apply");
                              if (mutation == null) return;
                              if (!turnMutationIsAvailable(turn) || viewRef.current.file_decisions[key] === "rejected") {
                                endMutation(mutation);
                                return;
                              }
                              void (async () => {
                                try {
                                  const review = diffState?.status === "ready"
                                    && (proposal.operation === "append" || proposal.operation === "create")
                                    ? {
                                        before_content: diffState.before,
                                        expected_disk_sha256: diffState.expected_disk_sha256,
                                      }
                                    : undefined;
                                  const { response, beforeContent } = await applyFileProposal(
                                    turn,
                                    event.id,
                                    proposal,
                                    review,
                                  );
                                  if (!activationIsCurrent(activationVersion)) return;
                                  if (response.after_sha256 != null) {
                                    setFileUndo({
                                      turn_id: turn.turn_id,
                                      proposal_event_id: event.id,
                                      path: proposal.path,
                                      expected_after_sha256: response.after_sha256,
                                      before_content: beforeContent,
                                      created: proposal.operation === "create",
                                    });
                                  }
                                  storeProposalDiff(key, undefined);
                                  await refreshCurrent(activationVersion);
                                } catch (error: unknown) {
                                  if (activationIsCurrent(activationVersion)) {
                                    storeProposalDiff(key, undefined);
                                    reportError(error);
                                  }
                                } finally {
                                  endMutation(mutation);
                                }
                              })();
                            }}>Apply</button>
                            <button
                              type="button"
                              disabled={turnMutationRenderBlocked(turn)}
                              onClick={() => void rejectFileProposal(turn, key)}
                            >Reject</button>
                          </div>
                        )}
                        {fileUndo?.turn_id === turn.turn_id && fileUndo.proposal_event_id === event.id && (
                          <button type="button" disabled={turnMutationRenderBlocked(turn)} onClick={() => {
                            if (!turnMutationIsAvailable(turn)) return;
                            const activationVersion = activationVersionRef.current;
                            const mutation = beginMutation("agent-file-undo");
                            if (mutation == null) return;
                            if (!turnMutationIsAvailable(turn)) {
                              endMutation(mutation);
                              return;
                            }
                            void (async () => {
                              try {
                                await undoFileProposal(fileUndo);
                                if (!activationIsCurrent(activationVersion)) return;
                                setFileUndo(null);
                                await refreshCurrent(activationVersion);
                              } catch (error: unknown) {
                                if (activationIsCurrent(activationVersion)) reportError(error);
                              } finally {
                                endMutation(mutation);
                              }
                            })();
                          }}>Undo applied edit</button>
                        )}
                      </header>
                      <details className="rho-agent-file-content" onToggle={(toggleEvent) => {
                        if (toggleEvent.currentTarget.open) {
                          void loadProposalDiff(turn, event.id, proposal);
                        }
                      }}>
                        <summary onClick={() => void loadProposalDiff(turn, event.id, proposal)}>Diff</summary>
                        <AgentProposalDiff proposal={proposal} state={diffState} />
                      </details>
                    </section>
                  );
                })}
                {(activityEvents.length > 0 || contextItems.length > 0) && (
                  <div className="rho-agent-activity">
                    {activityEvents.map((event) => event.code != null ? (
                      <details className="rho-agent-code-review" key={event.id}>
                        <summary>{event.title}</summary><pre>{event.code}</pre>
                      </details>
                    ) : (
                      <div className="rho-agent-activity-row" key={event.id}>{event.title}</div>
                    ))}
                    {contextItems.length > 0 && <details className="rho-agent-context-used">
                      <summary>Context used · {contextItems.length} {contextItems.length === 1 ? "source" : "sources"}</summary>
                      <ol>{contextItems.map((item) => <li key={`${item.ordinal}:${item.source_kind}:${item.source_id ?? "current"}`}>
                        <div><strong>{item.source_kind.replaceAll("_", " ")}</strong><span>{item.disposition}</span></div>
                        {item.source_id != null && <code>{item.source_id}</code>}
                        <small>{item.included_bytes.toLocaleString()} of {item.original_bytes.toLocaleString()} bytes · {item.trust_class}</small>
                      </li>)}</ol>
                    </details>}
                  </div>
                )}
                <footer>
                  <button type="button" disabled={turnMutationRenderBlocked(turn)} onClick={() => void pinTurn(turn)}>Pin to Vibe</button>
                  {(turn.status === "failed" || turn.status === "cancelled") && <button type="button" disabled={turnMutationRenderBlocked(turn)} onClick={() => void runAndRefresh(turn, () => transport.retryAgentTurn(turn.turn_id))}>Retry</button>}
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {displayMode !== "activity" && (
        <div className="rho-agent-composer">
          {activeTurn != null && stopActiveTurn != null && (
            <AgentRunningRow
              status={activeTurn.status}
              startedAt={activeTurn.started_at}
              disabled={turnMutationRenderBlocked(activeTurn)}
              onStop={stopActiveTurn}
            />
          )}
          {currentQueue.length > 0 && (
            <ol className="rho-agent-queue" aria-label="Queued follow-ups">
              {currentQueue.map((item, index) => (
                <li className="rho-agent-queue-item" key={item.id}>
                  <span className="rho-agent-queue-label">Queued</span>
                  <span className="rho-agent-queue-prompt" title={item.prompt}>{item.prompt}</span>
                  <span className="rho-agent-queue-actions">
                    {index > 0 && (
                      <button
                        type="button"
                        aria-label="Move queued message up"
                        disabled={busy}
                        onClick={() => moveQueuedUp(item.id)}
                      >↑</button>
                    )}
                    <button
                      type="button"
                      aria-label="Cancel queued message"
                      disabled={busy}
                      onClick={() => cancelQueued(item.id)}
                    >×</button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {runtimeOutputContext != null && <div className="rho-agent-context-chip" role="status">
            <div>
              <strong>Runtime output</strong>
              <span>Chunks {runtimeOutputContext.start_sequence}–{runtimeOutputContext.end_sequence}</span>
              <small>{runtimeOutputContext.payload_bytes.toLocaleString()} bytes · {runtimeOutputContext.range_sha256.slice(0, 10)}</small>
            </div>
            <button type="button" aria-label="Remove Runtime output from Agent context" onClick={() => {
              runtimeOutputContextRef.current = null;
              setRuntimeOutputContext(null);
              setContextPreview(null);
            }}>×</button>
          </div>}
          <textarea
            aria-label={`Agent prompt ${instance.instance_id}`}
            value={view.composer}
            disabled={viewStateWriteBlocked}
            onChange={(event) => commitView((current) => ({ ...current, composer: event.target.value }), false)}
            onBlur={() => {
              if (viewStateWriteBlocked || mutationRef.current != null) return;
              void persist(viewRef.current).catch(reportError);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Describe the scientific goal…"
          />
          <div className="rho-agent-context-controls">
            <button type="button" disabled={busy || contextReviewBusy || conversationRequestBlocked || health?.state !== "ready" || !modeReady || !view.composer.trim()} onClick={() => void reviewContext()}>
              {contextReviewBusy ? "Reviewing…" : "Review context"}
            </button>
            <div className="rho-agent-autonomous-badge" role="status">
              Autonomous goal loop
            </div>
            <details className="rho-agent-posture-menu">
              <summary
                aria-label={`Permission posture: ${postureLabel}`}
                aria-disabled={viewStateWriteBlocked}
                onClick={(event) => {
                  if (viewStateWriteBlocked) event.preventDefault();
                }}
              ><span>{postureLabel}</span></summary>
              <div role="menu" aria-label="Permission posture choices">
                {POSTURE_OPTIONS.map((option) => {
                  const active = (option.id === "auto") === view.auto_approve;
                  return (
                    <div className="rho-agent-posture-option" key={option.id}>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        className={option.id === "auto" ? "rho-agent-auto-approve" : undefined}
                        disabled={viewStateWriteBlocked}
                        onClick={(event) => {
                          event.currentTarget.closest("details")!.open = false;
                          commitView((current) => ({ ...current, auto_approve: option.id === "auto" }));
                        }}
                      >{option.label}</button>
                      <small>{option.hint}</small>
                    </div>
                  );
                })}
              </div>
            </details>
            <small className="rho-agent-mode-hint">Observe → plan → request effect → re-observe</small>
            <details className="rho-agent-model-menu">
              <summary aria-label={`Chat model: ${chatModelLabel}`} aria-busy={modelSwitchBusy} aria-disabled={busy || modelSwitchBusy} onClick={(event) => {
                if (mutationRef.current != null || busy || modelSwitchBusy) {
                  event.preventDefault();
                  return;
                }
                const menu = event.currentTarget.closest("details");
                if (menu != null && !menu.open) setModelQuery("");
              }}>
                <span>{chatModelLabel}</span>
              </summary>
              <div role="menu" aria-label="Chat model choices">
                {switchableModels.length > 6 && (
                  <input
                    className="rho-agent-model-search"
                    type="search"
                    aria-label="Search chat models"
                    placeholder="Search models…"
                    value={modelQuery}
                    disabled={busy || modelSwitchBusy}
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                )}
                {switchableModels.length === 0 && <span className="rho-agent-model-empty">No chat model is configured.</span>}
                {switchableModels.length > 0 && filteredModels.length === 0 && (
                  <span className="rho-agent-model-empty">No model matches the search.</span>
                )}
                {[...modelGroups].map(([provider, models]) => (
                  <div className="rho-agent-model-group" key={provider}>
                    <div className="rho-agent-model-group-label">{provider}</div>
                    {models.map((model) => {
                      const active = model.id === activeChatModelId;
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          disabled={busy || modelSwitchBusy}
                          key={model.id}
                          onClick={(event) => {
                            event.currentTarget.closest("details")!.open = false;
                            void selectChatModel(model.id);
                          }}
                        >
                          <span className="rho-agent-model-row">
                            <span className="rho-agent-model-check" aria-hidden="true">{active ? "✓" : ""}</span>
                            <span className="rho-agent-model-name">{model.display_name}</span>
                            <code className="rho-agent-model-id">{model.model_id}</code>
                          </span>
                          <small>{formatContextTokens(model.context_window_tokens)} context · {modelReadinessLabel(model)}</small>
                        </button>
                      );
                    })}
                  </div>
                ))}
                <button type="button" className="rho-agent-manage-models" onClick={(event) => {
                  event.currentTarget.closest("details")!.open = false;
                  openModelSettings(activeProviderId, activeChatModelId);
                }}>Manage models…</button>
              </div>
            </details>
            <button type="button" className="rho-primary-action" disabled={busy || contextReviewBusy || conversationRequestBlocked || health?.state !== "ready" || !modeReady || !view.composer.trim()} onClick={() => void submit()}>
              {busy ? "Working…" : runtimeOutputContext != null && contextPreview?.key !== contextPlanKey ? "Review before send" : "Send"}
            </button>
          </div>
          {contextPreview?.key === contextPlanKey && <section className="rho-agent-context-preview" aria-label="Agent context preview">
            <header>
              <div><strong>Context plan</strong><small>{contextPreview.plan.model_display_name} · settings r{contextPreview.plan.settings_revision}</small></div>
              <span>{contextPreview.plan.estimated_input_tokens.toLocaleString()} / {(contextPreview.plan.context_window_tokens - contextPreview.plan.reserved_output_tokens).toLocaleString()} tokens</span>
            </header>
            <ol>{contextPreview.plan.items.map((item) => <li key={`${item.ordinal}:${item.source_kind}:${item.source_id ?? "current"}`}>
              <div><strong>{item.source_kind.replaceAll("_", " ")}</strong><span className={`rho-agent-context-disposition rho-agent-context-disposition-${item.disposition}`}>{item.disposition}</span></div>
              {item.source_id != null && <code>{item.source_id}</code>}
              <small>{item.included_bytes.toLocaleString()} / {item.original_bytes.toLocaleString()} bytes · {item.trust_class}{item.reason_code == null ? "" : ` · ${item.reason_code}`}</small>
            </li>)}</ol>
            <footer>Plan {contextPreview.plan.plan_digest.slice(0, 12)} · {contextPreview.plan.capacity_source}</footer>
          </section>}
        </div>
      )}
    </section>
  );
}
