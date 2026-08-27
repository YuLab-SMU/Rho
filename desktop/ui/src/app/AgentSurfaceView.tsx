import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type {
  AgentConversationSummary,
  AgentContextPlanPreview,
  AgentFileMutationResponse,
  AgentLlmSettingsView,
  AgentMode,
  AgentRuntimeDiagnostics,
  AgentTurnDetail,
  AgentTurnSummary,
  RuntimeOutputReference,
  RunAgentRequest,
  SurfaceInstance,
  UiKernelTransport,
} from "../transport";

import "../styles/agent-surface.css";

export interface AgentSurfaceViewState {
  readonly conversation_id: string | null;
  readonly mode: AgentMode;
  readonly composer: string;
  readonly auto_approve: boolean;
  readonly file_decisions: Readonly<Record<string, "rejected">>;
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

function initialAgentSurfaceState(instance: SurfaceInstance): AgentSurfaceViewState {
  const candidate = typeof instance.view_state === "object" && instance.view_state != null
    ? instance.view_state as Record<string, unknown>
    : {};
  const mode = candidate.mode;
  return {
    conversation_id: typeof candidate.conversation_id === "string"
      ? candidate.conversation_id
      : null,
    mode: mode === "plan" || mode === "act" ? mode : "ask",
    composer: typeof candidate.composer === "string" ? candidate.composer : "",
    auto_approve: candidate.auto_approve === true,
    file_decisions: typeof candidate.file_decisions === "object" && candidate.file_decisions != null
      ? candidate.file_decisions as Readonly<Record<string, "rejected">>
      : {},
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

function agentErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The conversation list could not be refreshed.";
}

const AGENT_MODE_HINTS: Readonly<Record<AgentMode, string>> = {
  ask: "Ask about this project",
  plan: "Shape a reviewable approach",
  act: "Work with project tools",
};

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
export function AgentSurfaceView({
  instance,
  transport,
  health,
  createConversation,
  runConversation,
  persist,
  pinTask,
  applyFileProposal,
  undoFileProposal,
  reportError,
  runtimeOutputContext,
  setRuntimeOutputContext,
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
  ) => Promise<AgentSurfaceViewState>;
  readonly persist: (viewState: AgentSurfaceViewState) => Promise<void>;
  readonly pinTask: (turn: AgentTurnSummary) => Promise<void>;
  readonly applyFileProposal: (
    turn: AgentTurnSummary,
    eventId: number,
    proposal: AgentFileProposal,
  ) => Promise<{ readonly response: AgentFileMutationResponse; readonly beforeContent: string }>;
  readonly undoFileProposal: (request: AgentFileUndoState) => Promise<void>;
  readonly reportError: (error: unknown) => void;
  readonly runtimeOutputContext: RuntimeOutputReference | null;
  readonly setRuntimeOutputContext: (reference: RuntimeOutputReference | null) => void;
}) {
  const [view, setView] = useState(() => initialAgentSurfaceState(instance));
  const viewRef = useRef(view);
  const [conversations, setConversations] = useState<readonly AgentConversationSummary[]>([]);
  const [turns, setTurns] = useState<readonly AgentTurnSummary[]>([]);
  const [details, setDetails] = useState<ReadonlyMap<string, AgentTurnDetail>>(() => new Map());
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
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [capacityBusy, setCapacityBusy] = useState(false);
  const [llmSettings, setLlmSettings] = useState<AgentLlmSettingsView | null>(null);
  const [capacityModelId, setCapacityModelId] = useState("");
  const [capacityDraft, setCapacityDraft] = useState({ context: "", reserve: "" });
  const [modelSwitchBusy, setModelSwitchBusy] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
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
        setConversations(nextConversations);
        setTurns(nextTurns);
        setDetails(new Map(loadedDetails.flatMap(([turnId, detail]) =>
          detail == null ? [] : [[turnId, detail] as const]
        )));
        const settledValidation: AgentConversationValidation = {
          conversationId: preferredConversationId,
          status: preferredConversationId == null || preferredIsAvailable ? "available" : "unavailable",
        };
        conversationValidationRef.current = settledValidation;
        setConversationValidation(settledValidation);
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

  useEffect(() => {
    let active = true;
    void transport.getAgentRuntimeDiagnostics()
      .then((diagnostics) => { if (active) setRuntimeDiagnostics(diagnostics); })
      .catch((error: unknown) => { if (active) reportError(error); });
    return () => { active = false; };
  }, [health?.state, reportError, transport]);

  useEffect(() => {
    let active = true;
    void transport.loadAgentLlmSettings()
      .then((settings) => { if (active) setLlmSettings(settings); })
      .catch((error: unknown) => { if (active) reportError(error); });
    return () => { active = false; };
  }, [reportError, transport]);

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
  const selectCapacityModel = (modelId: string, settings = llmSettings) => {
    const model = settings?.models.find((candidate) => candidate.id === modelId);
    setCapacityModelId(modelId);
    setCapacityDraft({
      context: model == null ? "" : String(model.context_window_tokens),
      reserve: model == null ? "" : String(model.reserved_output_tokens),
    });
  };
  const loadContextCapacity = async () => {
    const activationVersion = activationVersionRef.current;
    const mutation = beginMutation("agent-context-capacity-load");
    if (mutation == null) return;
    setCapacityBusy(true);
    try {
      const settings = await transport.loadAgentLlmSettings();
      if (!activationIsCurrent(activationVersion)) return;
      setLlmSettings(settings);
      const model = settings.models.find((candidate) => candidate.id === settings.selected_model_id)
        ?? settings.models[0];
      selectCapacityModel(model?.id ?? "", settings);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      if (activationIsCurrent(activationVersion)) setCapacityBusy(false);
      endMutation(mutation);
    }
  };
  const saveContextCapacity = async () => {
    if (llmSettings == null || capacityBusy) return;
    const contextWindow = Number(capacityDraft.context);
    const reservedOutput = Number(capacityDraft.reserve);
    if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(reservedOutput)) {
      reportError(new Error("Context capacity must use whole token counts."));
      return;
    }
    const activationVersion = activationVersionRef.current;
    const mutation = beginMutation("agent-context-capacity-save");
    if (mutation == null) return;
    setCapacityBusy(true);
    try {
      const settings = await transport.setAgentContextCapacity({
        modelId: capacityModelId,
        expectedRevision: llmSettings.revision,
        expectedConfigSnapshotId: llmSettings.config_store.config_snapshot_id,
        contextWindowTokens: contextWindow,
        reservedOutputTokens: reservedOutput,
      });
      if (!activationIsCurrent(activationVersion)) return;
      setLlmSettings(settings);
      selectCapacityModel(capacityModelId, settings);
      setContextPreview(null);
    } catch (error: unknown) {
      if (activationIsCurrent(activationVersion)) reportError(error);
    } finally {
      if (activationIsCurrent(activationVersion)) setCapacityBusy(false);
      endMutation(mutation);
    }
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
  const reviewContext = async () => {
    const activationVersion = activationVersionRef.current;
    const current = viewRef.current;
    const runtimeSnapshot = runtimeOutputContextRef.current;
    const prompt = current.composer.trim();
    if (!prompt || contextReviewBusy || busy || health?.state !== "ready" ||
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
    if (!prompt || busy || health?.state !== "ready" || !conversationRequestIsAvailable(current)) return;
    const currentContextPlanKey = buildContextPlanKey(current, runtimeSnapshot);
    const reviewedPlan = contextPreview?.key === currentContextPlanKey ? contextPreview.plan : null;
    if (runtimeSnapshot != null && reviewedPlan == null) {
      await reviewContext();
      return;
    }
    const mutation = beginMutation("agent-turn-workflow");
    if (mutation == null) return;
    refreshGenerationRef.current += 1;
    try {
      const next = await runConversation(current, {
        prompt,
        mode: current.mode,
        task_kind: "agent_turn",
        model_id: null,
        auto_approve: current.mode === "act" && current.auto_approve,
        editor_context: null,
        conversation_id: current.conversation_id,
        runtime_output_context: runtimeSnapshot,
        context_plan_digest: reviewedPlan?.plan_digest ?? null,
      });
      if (!activationIsCurrent(activationVersion)) return;
      refreshGenerationRef.current += 1;
      viewRef.current = next;
      setView(next);
      setRuntimeOutputContext(null);
      setContextPreview(null);
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
  const displayMode = instance.mode_id ?? "conversation";
  const chatRoute = llmSettings?.capability_routes.find((route) => route.capability === "agent.chat");
  const chatModelLabel = chatRoute?.model_display_name
    ?? llmSettings?.selected_model?.display_name
    ?? (llmSettings == null ? "Loading model…" : "Chat model");
  const switchableModels = (llmSettings?.models ?? [])
    .filter((model) => model.enabled && model.model_type.value === "language");
  const activeChatModelId = chatRoute?.model_id ?? llmSettings?.selected_model_id ?? null;
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
  const activeTurn = turns.find((turn) => turn.status === "running" || turn.status === "waiting");
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
    if (mutationRef.current != null || conversationValidationRef.current.status === "pending") return;
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
            </option>
          ))}
        </select>
        <button type="button" className="rho-agent-toolbar-action" disabled={busy} onClick={() => void newConversation()}>New</button>
        <button type="button" className="rho-agent-toolbar-action" aria-expanded={capacityOpen} disabled={busy} onClick={() => {
          if (mutationRef.current != null) return;
          const next = !capacityOpen;
          setCapacityOpen(next);
          if (next) void loadContextCapacity();
        }}>Context</button>
      </header>
      {capacityOpen && <form className="rho-agent-capacity" aria-label="Agent model context capacity" onSubmit={(event) => {
        event.preventDefault();
        void saveContextCapacity();
      }}>
        {llmSettings == null ? <span>{capacityBusy ? "Loading model capacity…" : "Model capacity is unavailable."}</span> : <>
          <label>Model
            <select value={capacityModelId} disabled={busy || capacityBusy} onChange={(event) => {
              if (mutationRef.current == null) selectCapacityModel(event.target.value);
            }}>
              {llmSettings.models.map((model) => <option value={model.id} key={model.id}>{model.display_name}</option>)}
            </select>
          </label>
          <label>Context window
            <input aria-label="Context window tokens" type="number" min="4096" step="1" disabled={busy || capacityBusy} value={capacityDraft.context} onChange={(event) => {
              if (mutationRef.current == null) setCapacityDraft({ ...capacityDraft, context: event.target.value });
            }} />
          </label>
          <label>Reserve for reply
            <input aria-label="Reserved output tokens" type="number" min="256" step="1" disabled={busy || capacityBusy} value={capacityDraft.reserve} onChange={(event) => {
              if (mutationRef.current == null) setCapacityDraft({ ...capacityDraft, reserve: event.target.value });
            }} />
          </label>
          <div>
            <small>{llmSettings.models.find((model) => model.id === capacityModelId)?.context_capacity_source.replaceAll("_", " ")}</small>
            <small>{(() => {
              const model = llmSettings.models.find((item) => item.id === capacityModelId);
              const provider = model == null ? null : llmSettings.providers.find((item) => item.id === model.provider_id);
              if (provider == null) return null;
              const source = provider.credential_effective_source.replaceAll("_", " ");
              const status = provider.credential_status.replaceAll("_", " ");
              return `credential: ${status} · source: ${source}`;
            })()}</small>
            <button type="button" disabled={busy || capacityBusy} onClick={() => void loadContextCapacity()}>Reload</button>
            <button type="submit" className="rho-primary-action" disabled={busy || capacityBusy || !capacityModelId}>{capacityBusy ? "Saving…" : "Save"}</button>
          </div>
        </>}
      </form>}
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
          {loading && <p className="rho-agent-loading">Loading conversation…</p>}
          {!loading && refreshError != null && <div className="rho-agent-empty" role="alert">
            <strong>Conversation refresh failed</strong>
            <span>{refreshError}</span>
            <button
              type="button"
              disabled={busy || conversationValidationRef.current.status === "pending"}
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
                : "Choose Ask, Plan, or Act, then use the composer below."}</span>
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
            const waitingApprovals = detail?.approvals.filter((approval) => approval.status === "waiting") ?? [];
            const proposalEventIds = new Set(proposals.map(({ event }) => event.id));
            const activityEvents = detail?.events.filter((event) =>
              (event.tool != null || event.code != null) && !proposalEventIds.has(event.id)) ?? [];
            const contextItems = detail?.context_items ?? [];
            return (
              <article className={`rho-agent-turn rho-agent-turn-${turn.status}`} data-turn-id={turn.turn_id} key={turn.turn_id}>
                <header>
                  <strong>{turn.mode}</strong>
                  {turn.status !== "completed" && <span className={`rho-agent-turn-status rho-agent-turn-status-${turn.status}`}>{agentTurnStatusLabel(turn.status)}</span>}
                  <details className="rho-agent-turn-meta">
                    <summary aria-label={`Details for ${turn.mode} turn`}>Details</summary>
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
                {proposals.map(({ event, proposal }) => {
                  const key = `${turn.turn_id}:${event.id}`;
                  const outcome = detail == null ? null : agentFileProposalOutcome(detail, event.id);
                  const rejected = view.file_decisions[key] === "rejected";
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
                                  const { response, beforeContent } = await applyFileProposal(turn, event.id, proposal);
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
                                  await refreshCurrent(activationVersion);
                                } catch (error: unknown) {
                                  if (activationIsCurrent(activationVersion)) reportError(error);
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
                      <details className="rho-agent-file-content">
                        <summary>Proposed content</summary>
                        <pre>{proposal.content}</pre>
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
            placeholder="Ask Rho about this project…"
          />
          {view.mode === "act" && <label className="rho-agent-auto-approve">
            <input
              type="checkbox"
              checked={view.auto_approve}
              disabled={viewStateWriteBlocked}
              onChange={(event) => commitView((current) => ({ ...current, auto_approve: event.target.checked }))}
            />
            Auto-approve project tools for this conversation
          </label>}
          <div className="rho-agent-context-controls">
            <button type="button" disabled={busy || contextReviewBusy || conversationRequestBlocked || health?.state !== "ready" || !view.composer.trim()} onClick={() => void reviewContext()}>
              {contextReviewBusy ? "Reviewing…" : "Review context"}
            </button>
            <div className="rho-agent-mode" role="group" aria-label="Agent mode">
              {(["ask", "plan", "act"] as const).map((mode) => (
                <button
                  type="button"
                  aria-pressed={view.mode === mode}
                  disabled={viewStateWriteBlocked}
                  key={mode}
                  onClick={() => commitView((current) => ({
                    ...current,
                    mode,
                    auto_approve: mode === "act" ? current.auto_approve : false,
                  }))}
                >{mode}</button>
              ))}
            </div>
            <small className="rho-agent-mode-hint">{AGENT_MODE_HINTS[view.mode]}</small>
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
                {switchableModels.length === 0 && <span className="rho-agent-model-empty">No language model is available.</span>}
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
                          <small>{formatContextTokens(model.context_window_tokens)} context · {model.selector_status.replaceAll("_", " ")}</small>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </details>
            <button type="button" className="rho-primary-action" disabled={busy || contextReviewBusy || conversationRequestBlocked || health?.state !== "ready" || !view.composer.trim()} onClick={() => void submit()}>
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
