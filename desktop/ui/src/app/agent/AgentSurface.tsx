import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type {
  AgentConversationSummary,
  AgentContextPlanPreview,
  AgentMode,
  AgentRuntimeDiagnostics,
  AgentTurnDetail,
  AgentTurnEventFrame,
  AgentTurnSummary,
  RuntimeOutputReference,
  RunAgentRequest,
  SurfaceInstance,
} from "../../transport";
import { AgentEvidencePanel } from "./AgentEvidencePanel";
import { AgentEnvironmentPanel } from "./AgentEnvironmentPanel";
import { AgentFinalAnswer } from "./AgentFinalAnswer";
import { AgentActivity } from "./AgentActivity";
import { AgentApprovalPanel } from "./AgentApprovalPanel";
import { AgentCurrentWork, AgentRunningRow } from "./AgentCurrentWork";
import { AgentGoal } from "./AgentGoal";
import type { AgentEvidencePorts } from "../workbench/evidenceGraphPorts";
import type { AgentCorePorts, AgentEnvironmentPort } from "../workbench/agentPorts";
import {
  agentStudioPresentationKey,
  parseAgentStudioPresentation,
  type AgentStudioPresentation,
} from "./studio-presentation";

import "../../styles/agent-surface.css";

export interface AgentSurfaceState {
  readonly conversation_id: string | null;
  readonly mode: AgentMode;
  readonly composer: string;
  readonly studio_presentations?: Readonly<Record<
    string,
    "presenting" | "presented" | "failed"
  >>;
}

interface AgentQueueItem {
  readonly id: string;
  readonly conversation_id: string;
  readonly prompt: string;
  readonly request: RunAgentRequest;
  readonly queued_at: string;
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

function initialAgentSurfaceState(instance: SurfaceInstance): AgentSurfaceState {
  const candidate = typeof instance.view_state === "object" && instance.view_state != null
    ? instance.view_state as Record<string, unknown>
    : {};
  return {
    conversation_id: typeof candidate.conversation_id === "string"
      ? candidate.conversation_id
      : null,
    // Autonomous goal loop: one loop replaces the former user-selected Ask/Plan/Act modes.
    // The legacy transport still calls this value `act` until its wire contract is retired.
    mode: "act",
    composer: typeof candidate.composer === "string" ? candidate.composer : "",
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

export function AgentSurface({
  instance,
  transport,
  evidencePorts,
  environmentPort,
  health,
  createConversation,
  runConversation,
  persist,
  pinTask,
  presentInStudio,
  reportError,
  runtimeOutputContext,
  setRuntimeOutputContext,
}: {
  readonly instance: SurfaceInstance;
  readonly transport: AgentCorePorts;
  readonly evidencePorts: AgentEvidencePorts;
  readonly environmentPort: AgentEnvironmentPort;
  readonly health: { readonly state: string; readonly label: string; readonly detail: string | null } | null;
  readonly createConversation: (
    current: AgentSurfaceState,
  ) => Promise<AgentSurfaceState>;
  readonly runConversation: (
    current: AgentSurfaceState,
    request: RunAgentRequest,
    onAccepted?: (conversationId: string) => void,
  ) => Promise<AgentSurfaceState>;
  readonly persist: (viewState: AgentSurfaceState) => Promise<void>;
  readonly pinTask: (turn: AgentTurnSummary) => Promise<void>;
  readonly presentInStudio: (
    turn: AgentTurnSummary,
    presentation: AgentStudioPresentation,
  ) => Promise<void>;
  readonly reportError: (error: unknown) => void;
  readonly runtimeOutputContext: RuntimeOutputReference | null;
  readonly setRuntimeOutputContext: (reference: RuntimeOutputReference | null) => void;
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
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<AgentRuntimeDiagnostics | null>(null);
  const [contextPreview, setContextPreview] = useState<{
    readonly key: string;
    readonly plan: AgentContextPlanPreview;
  } | null>(null);
  const [contextReviewBusy, setContextReviewBusy] = useState(false);
  const [queue, setQueue] = useState<readonly AgentQueueItem[]>([]);
  const queueRef = useRef<readonly AgentQueueItem[]>([]);
  const queueSequenceRef = useRef(0);
  const dispatchingRef = useRef(false);
  const dispatchHaltedRef = useRef(false);
  const dispatchReconcileRef = useRef(false);
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
    presentationInFlightRef.current = new Set();
    frameRefreshScheduledRef.current = false;
    lastFrameEventIdRef.current = null;
    setConversations([]);
    setTurns([]);
    setDetails(new Map());
    setQueue([]);
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
    state: AgentSurfaceState,
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

  useEffect(() => {
    let active = true;
    void transport.getAgentRuntimeDiagnostics()
      .then((diagnostics) => { if (active) setRuntimeDiagnostics(diagnostics); })
      .catch((error: unknown) => { if (active) reportError(error); });
    return () => { active = false; };
  }, [health?.state, reportError, transport]);

  const viewStateWriteBlocked = busy || contextReviewBusy;
  const commitView = (
    update: (current: AgentSurfaceState) => AgentSurfaceState,
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
  const conversationRequestIsAvailable = (state: AgentSurfaceState) => {
    const validation = conversationValidationRef.current;
    return validation.status === "available"
      && validation.conversationId === state.conversation_id;
  };
  const turnMutationIsAvailable = (turn: AgentTurnSummary) => {
    const current = viewRef.current;
    return current.conversation_id === turn.conversation_id
      && conversationRequestIsAvailable(current);
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
      const next: AgentSurfaceState = {
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
      auto_approve: false,
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
  const agentLabel = runtimeDiagnostics?.active_agent_label ?? "External ACP Agent";
  const modeReady = runtimeDiagnostics?.available === true;
  const activeTurn = turns.find((turn) => turn.status === "running" || turn.status === "waiting");
  const currentQueue = view.conversation_id == null
    ? []
    : queue.filter((item) => item.conversation_id === view.conversation_id);
  const validationMatchesView = conversationValidation.conversationId === view.conversation_id;
  const conversationValidationPending = !validationMatchesView || conversationValidation.status === "pending";
  const selectedConversationUnavailable = validationMatchesView
    && conversationValidation.status === "unavailable";
  const selectedConversationListed = view.conversation_id == null || conversations.some(
    (conversation) => conversation.conversation_id === view.conversation_id,
  );
  const showSyntheticConversation = view.conversation_id != null && !selectedConversationListed;
  const conversationRequestBlocked = conversationValidationPending || selectedConversationUnavailable;
  // Review context and Send share one gate. The setup banner above reports the
  // chat route, but sending is gated on the act route, so a disabled composer
  // has to name the requirement that is actually unmet instead of going quiet.
  const composerBlockedReason = health?.state !== "ready"
    ? "Agent runtime is not ready."
    : conversationValidationPending
      ? "Checking the selected conversation…"
      : selectedConversationUnavailable
        ? "Select No conversation or a listed conversation before sending."
        : !modeReady
          ? "No external ACP Agent is available."
          : null;
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
  const diagnosticsText = runtimeDiagnostics == null ? "ACP Agent discovery is loading." : [
    "External ACP Agent",
    `  label:      ${runtimeDiagnostics.active_agent_label ?? "not resolved"}`,
    `  id:         ${runtimeDiagnostics.active_agent_id ?? "not resolved"}`,
    `  protocol:   ${runtimeDiagnostics.protocol ?? "unknown"}`,
    `  executable: ${runtimeDiagnostics.executable ?? "not resolved"}`,
    `  status:     ${runtimeDiagnostics.status}`,
    "",
    "Rho is an ACP client. Provider permission requests are denied unless an exact Rho Broker capability admits the effect.",
  ].join("\n");
  const idleConversation = !loading
    && refreshError == null
    && turns.length === 0
    && activeTurn == null;

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
              {conversation.status === "waiting" ? " · Needs attention" : ""}
            </option>
          ))}
        </select>
        <button type="button" className="rho-agent-toolbar-action" disabled={busy} onClick={() => void newConversation()}>New</button>
      </header>
      {!idleConversation && <section className="rho-agent-overview" aria-label="Agent status and policy">
        <div>
          <span className="rho-agent-section-label">Autonomous Agent</span>
          <strong>Goal-driven scientific work</strong>
          <p>The external Agent plans and works through ACP. Rho supplies bounded context, governs effects, and re-observes authoritative results.</p>
        </div>
        <dl>
          <div><dt>Agent</dt><dd>{agentLabel}</dd></div>
          <div><dt>Authority</dt><dd>Rho Broker</dd></div>
          <div><dt>State</dt><dd>{activeTurn == null ? "Ready" : agentTurnStatusLabel(activeTurn.status)}</dd></div>
        </dl>
      </section>}
      <AgentEnvironmentPanel port={environmentPort} reportError={reportError} />
      {displayMode === "activity" && activeTurn != null && stopActiveTurn != null && (
        <AgentRunningRow
          status={activeTurn.status}
          startedAt={activeTurn.started_at}
          disabled={turnMutationRenderBlocked(activeTurn)}
          onStop={stopActiveTurn}
        />
      )}
      {displayMode !== "composer" && (
        <div className={`rho-agent-timeline${idleConversation ? " rho-agent-timeline-idle" : ""}`} aria-busy={loading}>
          {!idleConversation && <AgentCurrentWork prompt={activeTurn?.prompt_preview ?? null} turnCount={turns.length} />}
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
              : "Start with a scientific goal"}</strong>
            <span>{selectedConversationUnavailable
              ? "Choose No conversation or a listed conversation before reviewing context or sending."
              : "Write below; Rho reviews project context before it plans or requests governed effects."}</span>
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
            const presentations = (detail?.events.flatMap((event) => {
              const parsed = parseAgentStudioPresentation(event);
              return parsed == null ? [] : [parsed];
            }) ?? []).slice(-1);
            const waitingApprovals = detail?.approvals.filter((approval) => approval.status === "waiting") ?? [];
            const presentationEventIds = new Set(presentations.map(({ event }) => event.id));
            const activityEvents = detail?.events.filter((event) =>
              (event.tool != null || event.code != null)
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
                <AgentGoal prompt={turn.prompt_preview} />
                {turn.final_message != null && <>
                  <AgentFinalAnswer answer={turn.final_message} />
                  <AgentEvidencePanel
                    turnId={turn.turn_id}
                    finalAnswer={turn.final_message}
                    ports={evidencePorts}
                    reportError={reportError}
                  />
                </>}
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
                <AgentApprovalPanel
                  approvals={waitingApprovals}
                  disabled={turnMutationRenderBlocked(turn)}
                  onDecision={(approval, decision) => void runAndRefresh(turn, () => transport.respondAgentApproval({
                    request_id: approval.request_id,
                    decision,
                    reason: decision === "reject" ? "Rejected in Agent Surface" : null,
                  }))}
                />
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
                      <span className="rho-agent-studio-outcome" role={status === "presenting" ? "status" : undefined}>
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
                <AgentActivity events={activityEvents} contextItems={contextItems} />
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
        <div className={`rho-agent-composer ${idleConversation ? "rho-agent-composer-idle" : ""}`}>
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
            <div className="rho-agent-autonomous-badge" role="status" title="Observe, plan, request governed effects, then re-observe">
              Governed agent
            </div>
            <div className="rho-agent-external-provider" title="Agent implementation and model selection belong to the external ACP process">
              {agentLabel} · {runtimeDiagnostics?.protocol ?? "ACP"}
            </div>
            {!idleConversation && <small className="rho-agent-mode-hint">Observe → plan → request effect → re-observe</small>}
            {composerBlockedReason != null && view.composer.trim() !== "" && (
              <small className="rho-agent-submit-block" role="status" title={composerBlockedReason}>{composerBlockedReason}</small>
            )}
            <button type="button" className="rho-agent-review-context" disabled={busy || contextReviewBusy || conversationRequestBlocked || health?.state !== "ready" || !modeReady || !view.composer.trim()} onClick={() => void reviewContext()}>
              {contextReviewBusy ? "Reviewing…" : "Review context"}
            </button>
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
