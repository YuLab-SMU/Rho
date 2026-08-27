import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AgentConversationSummary,
  AgentContextPlanPreview,
  AgentFileMutationResponse,
  AgentLlmSettingsView,
  AgentRuntimeDiagnostics,
  AgentTurnDetail,
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
  const [details, setDetails] = useState<ReadonlyMap<string, AgentTurnDetail>>(() => new Map());
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
    setConversations(nextConversations);
    setTurns(nextTurns);
    setDetails(new Map(loadedDetails.flatMap(([turnId, detail]) =>
      detail == null ? [] : [[turnId, detail] as const]
    )));
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
