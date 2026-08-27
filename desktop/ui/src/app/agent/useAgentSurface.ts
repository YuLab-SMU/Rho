import { useCallback, useEffect, useRef, useState } from "react";

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
  SurfaceInstance,
  UiKernelTransport,
} from "../../transport";

import {
  agentFileProposalOutcome,
  parseAgentFileProposal,
  proposalKey,
  type AgentFileProposal,
  type AgentFileUndoState,
  type AgentProposalRef,
} from "./proposals";
import {
  initialAgentSurfaceState,
  type AgentSurfaceViewState,
} from "./view-state";

export interface AgentQueueItem {
  readonly id: string;
  readonly prompt: string;
  readonly mode: AgentMode;
  readonly auto_approve: boolean;
  readonly queued_at: string;
}

export type AgentProposalDiffState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly before: string };

export interface AgentSurfaceViewProps {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly health: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
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
}

export function useAgentSurface({
  instance,
  transport,
  health,
  persist,
  pinTask,
  applyFileProposal,
  undoFileProposal,
  reportError,
  runtimeOutputContext,
  setRuntimeOutputContext,
}: AgentSurfaceViewProps) {
  const [view, setView] = useState(() => initialAgentSurfaceState(instance));
  const viewRef = useRef(view);
  const [conversations, setConversations] = useState<readonly AgentConversationSummary[]>([]);
  const [turns, setTurns] = useState<readonly AgentTurnSummary[]>([]);
  const turnsRef = useRef<readonly AgentTurnSummary[]>(turns);
  const [details, setDetails] = useState<ReadonlyMap<string, AgentTurnDetail>>(() => new Map());
  const detailsRef = useRef<ReadonlyMap<string, AgentTurnDetail>>(details);
  const [busy, setBusy] = useState(false);
  const [fileUndo, setFileUndo] = useState<AgentFileUndoState | null>(null);
  const [loading, setLoading] = useState(true);
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
  const [filesReviewOpen, setFilesReviewOpen] = useState(false);
  const [proposalDiffs, setProposalDiffs] = useState<ReadonlyMap<string, AgentProposalDiffState>>(() => new Map());
  const proposalDiffsRef = useRef(proposalDiffs);
  const [queue, setQueue] = useState<readonly AgentQueueItem[]>([]);
  const queueRef = useRef<readonly AgentQueueItem[]>(queue);
  const queueSequenceRef = useRef(0);
  const dispatchingRef = useRef(false);
  const dispatchHaltedRef = useRef(false);

  const contextPlanKey = JSON.stringify([
    view.composer.trim(),
    view.mode,
    view.conversation_id,
    runtimeOutputContext?.execution_id ?? null,
    runtimeOutputContext?.start_sequence ?? null,
    runtimeOutputContext?.end_sequence ?? null,
    runtimeOutputContext?.range_sha256 ?? null,
  ]);

  const refresh = useCallback(async (preferredConversationId = viewRef.current.conversation_id) => {
    const nextConversations = await transport.listAgentConversations(50);
    const selected = nextConversations.some(
      (conversation) => conversation.conversation_id === preferredConversationId,
    ) ? preferredConversationId : nextConversations[0]?.conversation_id ?? null;
    const nextTurns = selected == null ? [] : await transport.listAgentTurns(selected, 50);
    const loadedDetails = await Promise.all(nextTurns.slice(0, 20).map(async (turn) => [
      turn.turn_id,
      await transport.getAgentTurnDetail(turn.turn_id),
    ] as const));
    const nextDetails = new Map(loadedDetails.flatMap(([turnId, detail]) =>
      detail == null ? [] : [[turnId, detail] as const]
    ));
    turnsRef.current = nextTurns;
    detailsRef.current = nextDetails;
    setConversations(nextConversations);
    setTurns(nextTurns);
    setDetails(nextDetails);
    if (selected !== viewRef.current.conversation_id) {
      const next = { ...viewRef.current, conversation_id: selected };
      viewRef.current = next;
      setView(next);
      if (selected != null) await persist(next);
    }
    setLoading(false);
  }, [persist, transport]);

  useEffect(() => {
    const next = initialAgentSurfaceState(instance);
    viewRef.current = next;
    setView(next);
  }, [instance.instance_id]);

  useEffect(() => { setFilesReviewOpen(false); }, [view.conversation_id]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        await refresh();
      } catch (error: unknown) {
        if (active) reportError(error);
      }
    };
    void load();
    const unsubscribe = transport.subscribeAgentInvalidated(() => void load());
    return () => { active = false; unsubscribe(); };
  }, [refresh, reportError, transport]);

  // Live turn frames: apply projections incrementally; the store stays the
  // source of truth, so gaps, unknown turns, and terminal updates reconcile
  // through the existing refresh path (throttled).
  const frameRefreshThrottleRef = useRef(0);
  const requestFrameRefresh = useCallback(() => {
    const now = Date.now();
    if (now - frameRefreshThrottleRef.current < 400) return;
    frameRefreshThrottleRef.current = now;
    void refresh().catch(reportError);
  }, [refresh, reportError]);

  useEffect(() => {
    const applyFrame = (frame: AgentTurnEventFrame) => {
      let refreshNeeded = false;
      const update = frame.turn_update;
      if (update != null) {
        if (update.status !== "running" && update.status !== "waiting") refreshNeeded = true;
        if (!turnsRef.current.some((turn) => turn.turn_id === frame.turn_id)) refreshNeeded = true;
        const nextTurns = turnsRef.current.map((turn) => {
          if (turn.turn_id !== frame.turn_id) return turn;
          return {
            ...turn,
            status: update.status as AgentTurnSummary["status"],
            final_message: update.final_message ?? turn.final_message,
            error_message: update.error_message,
            terminal_reason: update.terminal_reason,
          };
        });
        turnsRef.current = nextTurns;
        setTurns(nextTurns);
        const detail = detailsRef.current.get(frame.turn_id);
        if (detail != null) {
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
      }
      const incoming = frame.event;
      if (incoming != null) {
        const detail = detailsRef.current.get(frame.turn_id);
        if (detail == null) {
          refreshNeeded = true;
        } else if (!detail.events.some((event) => event.id === incoming.id)) {
          const maxId = detail.events.reduce((max, event) => Math.max(max, event.id), 0);
          if (incoming.id > maxId + 1) {
            refreshNeeded = true;
          } else {
            const nextDetails = new Map(detailsRef.current);
            nextDetails.set(frame.turn_id, { ...detail, events: [...detail.events, incoming] });
            detailsRef.current = nextDetails;
            setDetails(nextDetails);
          }
        }
      }
      if (refreshNeeded) requestFrameRefresh();
    };
    return transport.subscribeAgentTurnEvents(applyFrame);
  }, [transport, requestFrameRefresh]);

  // Sequential work queue: when no turn is active and the runtime is ready,
  // the head item starts as a normal turn through the existing runAgent
  // path. Dispatch is single-flight; a failed dispatch is restored and
  // halted until the user changes the queue (no silent retry storm).
  useEffect(() => {
    if (dispatchingRef.current || dispatchHaltedRef.current) return;
    if (health?.state !== "ready") return;
    if (turns.some((turn) => turn.status === "running" || turn.status === "waiting")) return;
    const head = queueRef.current[0];
    if (head == null) return;
    dispatchingRef.current = true;
    const remaining = queueRef.current.slice(1);
    queueRef.current = remaining;
    setQueue(remaining);
    void (async () => {
      try {
        const response = await transport.runAgent({
          prompt: head.prompt,
          mode: head.mode,
          task_kind: "agent_turn",
          model_id: null,
          auto_approve: head.auto_approve,
          editor_context: null,
          conversation_id: viewRef.current.conversation_id,
          runtime_output_context: null,
          context_plan_digest: null,
        });
        await refresh(response.conversation_id);
      } catch (error: unknown) {
        reportError(error);
        const restored = [head, ...queueRef.current];
        queueRef.current = restored;
        setQueue(restored);
        dispatchHaltedRef.current = true;
      } finally {
        dispatchingRef.current = false;
      }
    })();
  }, [health?.state, turns, queue, refresh, reportError, transport]);

  const cancelQueued = (id: string) => {
    const next = queueRef.current.filter((item) => item.id !== id);
    queueRef.current = next;
    setQueue(next);
    dispatchHaltedRef.current = false;
  };
  const moveQueuedUp = (id: string) => {
    const index = queueRef.current.findIndex((item) => item.id === id);
    if (index <= 0) return;
    const next = [...queueRef.current];
    const [item] = next.splice(index, 1);
    next.splice(index - 1, 0, item!);
    queueRef.current = next;
    setQueue(next);
    dispatchHaltedRef.current = false;
  };

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

  const commitView = (next: AgentSurfaceViewState, durable = true) => {
    if (next.composer !== viewRef.current.composer || next.mode !== viewRef.current.mode ||
        next.conversation_id !== viewRef.current.conversation_id) setContextPreview(null);
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
    setCapacityBusy(true);
    try {
      const settings = await transport.loadAgentLlmSettings();
      setLlmSettings(settings);
      const model = settings.models.find((candidate) => candidate.id === settings.selected_model_id)
        ?? settings.models[0];
      selectCapacityModel(model?.id ?? "", settings);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setCapacityBusy(false);
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
    setCapacityBusy(true);
    try {
      const settings = await transport.setAgentContextCapacity({
        model_id: capacityModelId,
        expected_revision: llmSettings.revision,
        context_window_tokens: contextWindow,
        reserved_output_tokens: reservedOutput,
      });
      setLlmSettings(settings);
      selectCapacityModel(capacityModelId, settings);
      setContextPreview(null);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setCapacityBusy(false);
    }
  };
  const toggleCapacity = () => {
    const next = !capacityOpen;
    setCapacityOpen(next);
    if (next) void loadContextCapacity();
  };
  const selectChatModel = async (modelId: string) => {
    if (llmSettings == null || modelSwitchBusy) return;
    setModelSwitchBusy(true);
    try {
      const settings = await transport.selectAgentChatModel(modelId, llmSettings.revision);
      setLlmSettings(settings);
      setContextPreview(null);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setModelSwitchBusy(false);
    }
  };
  const selectConversation = async (conversationId: string) => {
    const next = { ...view, conversation_id: conversationId };
    viewRef.current = next;
    setView(next);
    await persist(next);
    await refresh(conversationId);
  };
  const newConversation = async () => {
    setBusy(true);
    try {
      const conversation = await transport.createAgentConversation();
      await selectConversation(conversation.conversation_id);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };
  const reviewContext = async () => {
    const prompt = view.composer.trim();
    if (!prompt || contextReviewBusy || busy || health?.state !== "ready") return;
    setContextReviewBusy(true);
    try {
      const plan = await transport.previewAgentContext({
        prompt,
        mode: view.mode,
        task_kind: "agent_turn",
        model_id: null,
        editor_context: null,
        conversation_id: view.conversation_id,
        runtime_output_context: runtimeOutputContext,
      });
      setContextPreview({ key: contextPlanKey, plan });
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setContextReviewBusy(false);
    }
  };
  const submit = async () => {
    const prompt = view.composer.trim();
    if (!prompt || busy || health?.state !== "ready") return;
    // Work queue: while a turn is running or waiting, a submission joins the
    // queue instead of blocking or erroring; the composer clears immediately.
    const turnActive = turnsRef.current.some(
      (turn) => turn.status === "running" || turn.status === "waiting",
    );
    if (turnActive) {
      queueSequenceRef.current += 1;
      const item: AgentQueueItem = {
        id: `queue-${queueSequenceRef.current}`,
        prompt,
        mode: view.mode,
        auto_approve: view.mode === "act" && view.auto_approve,
        queued_at: new Date().toISOString(),
      };
      const next = [...queueRef.current, item];
      queueRef.current = next;
      setQueue(next);
      dispatchHaltedRef.current = false;
      commitView({ ...view, composer: "" });
      return;
    }
    const reviewedPlan = contextPreview?.key === contextPlanKey ? contextPreview.plan : null;
    if (runtimeOutputContext != null && reviewedPlan == null) {
      await reviewContext();
      return;
    }
    setBusy(true);
    try {
      const response = await transport.runAgent({
        prompt,
        mode: view.mode,
        task_kind: "agent_turn",
        model_id: null,
        auto_approve: view.mode === "act" && view.auto_approve,
        editor_context: null,
        conversation_id: view.conversation_id,
        runtime_output_context: runtimeOutputContext,
        context_plan_digest: reviewedPlan?.plan_digest ?? null,
      });
      const next = { ...view, conversation_id: response.conversation_id, composer: "" };
      viewRef.current = next;
      setView(next);
      await persist(next);
      setRuntimeOutputContext(null);
      setContextPreview(null);
      await refresh(response.conversation_id);
    } catch (error: unknown) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };
  const retryRuntime = () => {
    setBusy(true);
    void transport.retryAgentRuntime()
      .then((diagnostics) => { setRuntimeDiagnostics(diagnostics); return refresh(); })
      .catch(reportError)
      .finally(() => setBusy(false));
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
  const modelGroups: Array<readonly [string, typeof filteredModels]> = [];
  {
    const groups = new Map<string, typeof filteredModels>();
    for (const model of filteredModels) {
      const group = groups.get(model.provider_display_name);
      if (group == null) groups.set(model.provider_display_name, [model]);
      else group.push(model);
    }
    modelGroups.push(...groups);
  }
  const activeTurn = turns.find((turn) => turn.status === "running" || turn.status === "waiting");
  const stopActiveTurn = activeTurn == null ? null : () => {
    setBusy(true);
    void transport.cancelAgentTurn(activeTurn.turn_id)
      .then(() => refresh())
      .catch(reportError)
      .finally(() => setBusy(false));
  };
  const retryTurn = (turnId: string) => {
    void transport.retryAgentTurn(turnId).then(() => refresh()).catch(reportError);
  };
  const respondApproval = (requestId: string, decision: "approve" | "reject") => {
    void transport.respondAgentApproval({
      request_id: requestId,
      decision,
      reason: decision === "reject" ? "Rejected in Agent Surface" : null,
    }).then(() => refresh()).catch(reportError);
  };
  const allProposals: AgentProposalRef[] = turns.flatMap((turn) => {
    const detail = details.get(turn.turn_id);
    return detail?.events.flatMap((event) => {
      const proposal = parseAgentFileProposal(event);
      return proposal == null ? [] : [{ turn, event, proposal }];
    }) ?? [];
  });
  const proposalOutcomeFor = (turn: AgentTurnSummary, eventId: number) => {
    const detail = details.get(turn.turn_id);
    return detail == null ? null : agentFileProposalOutcome(detail, eventId);
  };
  const pendingProposals = allProposals.filter(({ turn, event }) =>
    turn.status !== "running" && turn.status !== "waiting" &&
    proposalOutcomeFor(turn, event.id) == null &&
    view.file_decisions[proposalKey(turn.turn_id, event.id)] !== "rejected");
  const applyProposal = (turn: AgentTurnSummary, eventId: number, proposal: AgentFileProposal) => {
    setBusy(true);
    void applyFileProposal(turn, eventId, proposal)
      .then(({ response, beforeContent }) => {
        if (response.after_sha256 != null) {
          setFileUndo({
            turn_id: turn.turn_id,
            proposal_event_id: eventId,
            path: proposal.path,
            expected_after_sha256: response.after_sha256,
            before_content: beforeContent,
            created: proposal.operation === "create",
          });
        }
        return refresh();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  };
  const applyAllProposals = async () => {
    if (busy || pendingProposals.length === 0) return;
    setBusy(true);
    let lastUndo: AgentFileUndoState | null = null;
    try {
      for (const { turn, event, proposal } of pendingProposals) {
        try {
          const { response, beforeContent } = await applyFileProposal(turn, event.id, proposal);
          if (response.after_sha256 != null) {
            lastUndo = {
              turn_id: turn.turn_id,
              proposal_event_id: event.id,
              path: proposal.path,
              expected_after_sha256: response.after_sha256,
              before_content: beforeContent,
              created: proposal.operation === "create",
            };
          }
        } catch (error: unknown) {
          reportError(error);
        }
      }
      if (lastUndo != null) setFileUndo(lastUndo);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const rejectProposal = (key: string) => {
    commitView({ ...view, file_decisions: { ...view.file_decisions, [key]: "rejected" } });
  };
  const rejectAllProposals = () => {
    if (pendingProposals.length === 0) return;
    const next: Record<string, "rejected"> = { ...view.file_decisions };
    for (const { turn, event } of pendingProposals) next[proposalKey(turn.turn_id, event.id)] = "rejected";
    commitView({ ...view, file_decisions: next });
  };
  const undoProposal = () => {
    if (fileUndo == null) return;
    setBusy(true);
    void undoFileProposal(fileUndo)
      .then(() => { setFileUndo(null); return refresh(); })
      .catch(reportError)
      .finally(() => setBusy(false));
  };
  const loadProposalDiff = async (turn: AgentTurnSummary, eventId: number, proposal: AgentFileProposal) => {
    const key = proposalKey(turn.turn_id, eventId);
    if (proposalDiffsRef.current.has(key)) return;
    const store = (state: AgentProposalDiffState) => {
      const next = new Map(proposalDiffsRef.current);
      next.set(key, state);
      proposalDiffsRef.current = next;
      setProposalDiffs(next);
    };
    store({ status: "loading" });
    try {
      let before = "";
      if (proposal.operation !== "create") {
        const registry = await transport.loadResources();
        const matches = (candidate: { readonly resource_provider_id: string; readonly resource_kind: string; readonly resource_id: string }) =>
          candidate.resource_provider_id === "rho.project-files" &&
          candidate.resource_kind === "project_file" &&
          candidate.resource_id === proposal.path;
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
        if (descriptor == null || descriptor.status !== "ready") {
          store({ status: "unavailable" });
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
        before = content.content;
      }
      store({ status: "ready", before });
    } catch (error: unknown) {
      reportError(error);
      store({ status: "unavailable" });
    }
  };
  const clearRuntimeOutputContext = () => {
    setRuntimeOutputContext(null);
    setContextPreview(null);
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
  const copyDiagnostics = () => {
    void navigator.clipboard.writeText(diagnosticsText).catch(reportError);
  };

  return {
    instance,
    transport,
    health,
    reportError,
    view,
    commitView,
    persist,
    conversations,
    turns,
    details,
    loading,
    busy,
    refresh,
    runtimeDiagnostics,
    diagnosticsText,
    retryRuntime,
    copyDiagnostics,
    contextPlanKey,
    contextPreview,
    contextReviewBusy,
    reviewContext,
    submit,
    runtimeOutputContext,
    clearRuntimeOutputContext,
    selectConversation,
    newConversation,
    capacityOpen,
    toggleCapacity,
    capacityBusy,
    llmSettings,
    capacityModelId,
    capacityDraft,
    setCapacityDraft,
    selectCapacityModel,
    loadContextCapacity,
    saveContextCapacity,
    chatModelLabel,
    switchableModels,
    filteredModels,
    modelGroups,
    activeChatModelId,
    modelQuery,
    setModelQuery,
    modelSwitchBusy,
    selectChatModel,
    activeTurn,
    stopActiveTurn,
    retryTurn,
    pinTask,
    respondApproval,
    filesReviewOpen,
    setFilesReviewOpen,
    queue,
    cancelQueued,
    moveQueuedUp,
    proposalDiffs,
    loadProposalDiff,
    allProposals,
    pendingProposals,
    proposalOutcomeFor,
    applyProposal,
    applyAllProposals,
    rejectProposal,
    rejectAllProposals,
    fileUndo,
    undoProposal,
    displayMode,
  };
}

export type AgentSurfaceVm = ReturnType<typeof useAgentSurface>;
