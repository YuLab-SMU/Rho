import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type {
  AgentConversationSummary,
  AgentTurnDetail,
  AgentTurnSummary,
} from "../../../transport";
import { vibeFailureMessage } from "../core/vibe-failure";
import {
  conversationHasExactReference,
  projectExplorationConversation,
  projectExplorationTurn,
} from "./exploration-model";
import type {
  ExplorationConversationView,
  ExplorationTurnView,
} from "./exploration-model";
import { VibeAgentRecordHost } from "./VibeAgentRecordHost";

const CONVERSATION_LIMIT = 50;
const TURN_LIMIT = 50;
const DETAIL_LIMIT = 20;

export interface VibeExplorationTransport {
  listAgentConversations(limit?: number): Promise<readonly AgentConversationSummary[]>;
  listAgentTurns(
    conversationId: string | null,
    limit?: number,
  ): Promise<readonly AgentTurnSummary[]>;
  getAgentTurnDetail(turnId: string): Promise<AgentTurnDetail | null>;
  subscribeAgentInvalidated(listener: () => void): () => void;
}

export interface VibeExplorationSelection {
  readonly conversationId: string | null;
  readonly turnId: string | null;
}

export interface VibeExplorationExactRefs {
  readonly conversationIds: readonly string[];
  readonly taskIds: readonly string[];
}

export interface VibeExplorationPanelProps {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly pageId: string;
  readonly presentation: "overview" | "focused";
  readonly selection: VibeExplorationSelection;
  readonly exactRefs: VibeExplorationExactRefs;
  readonly transport: VibeExplorationTransport;
  readonly onSelectionChange: (selection: VibeExplorationSelection) => void;
  readonly onOpenHost: () => void;
  readonly onCompose: (selection: VibeExplorationSelection) => void;
  readonly onOpenAgent: (selection: VibeExplorationSelection) => void;
  readonly onError: (error: unknown) => void;
}

interface AgentRecordHostState {
  readonly selection: VibeExplorationSelection;
  readonly trigger: "start" | "record";
}

interface ExplorationData {
  readonly conversations: readonly ExplorationConversationView[];
  readonly turns: readonly ExplorationTurnView[];
  readonly selectedConversationId: string | null;
  readonly selectedTurnId: string | null;
  readonly detailFailures: number;
}

type PanelState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly data: ExplorationData;
      readonly refreshing: boolean;
      readonly stale: boolean;
      readonly refreshMessage: string | null;
    };

const INITIAL_STATE: PanelState = Object.freeze({ kind: "loading" });

class ExplorationProjectMismatchError extends Error {
  constructor() {
    super("Agent records changed project while autonomous exploration was loading.");
    this.name = "ExplorationProjectMismatchError";
  }
}

function boundedErrorMessage(error: unknown): string {
  return vibeFailureMessage(error, "自主探索记录暂时不可用。");
}

function boundedExplorationError(error: unknown): Error {
  return new Error(boundedErrorMessage(error));
}

function sameSelection(left: VibeExplorationSelection, right: VibeExplorationSelection): boolean {
  return left.conversationId === right.conversationId && left.turnId === right.turnId;
}

function selectConversationId(
  conversations: readonly AgentConversationSummary[],
  preferred: VibeExplorationSelection,
  hintedDetail: AgentTurnDetail | null,
  exactConversationIds: readonly string[],
): string | null {
  const ids = new Set(conversations.map((conversation) => conversation.conversation_id));
  // Explicit identities stay selected even when they are missing. Replacing an
  // unresolved exact reference with a recent record would fabricate continuity.
  if (preferred.conversationId != null) return preferred.conversationId;
  if (preferred.turnId != null) return hintedDetail?.turn.conversation_id ?? null;
  const exact = exactConversationIds.find((conversationId) => ids.has(conversationId));
  return exact ?? conversations[0]?.conversation_id ?? null;
}

function projectedSelection(data: ExplorationData): VibeExplorationSelection {
  return {
    conversationId: data.selectedConversationId,
    turnId: data.selectedTurnId,
  };
}

function keyboardListNavigation(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  selector: string,
): void {
  const directions: Readonly<Record<string, number>> = {
    ArrowDown: 1,
    ArrowRight: 1,
    ArrowUp: -1,
    ArrowLeft: -1,
  };
  const direction = directions[event.key];
  if (direction == null && event.key !== "Home" && event.key !== "End") return;
  const list = event.currentTarget.closest("ul, ol");
  const buttons = list == null
    ? []
    : [...list.querySelectorAll<HTMLButtonElement>(selector)];
  const current = buttons.indexOf(event.currentTarget);
  if (current < 0 || buttons.length === 0) return;
  event.preventDefault();
  const offset = direction ?? 0;
  const target = event.key === "Home"
    ? 0
    : event.key === "End"
      ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, current + offset));
  buttons[target]?.focus();
}

export function VibeExplorationPanel({
  projectId,
  projectRoot,
  pageId,
  presentation,
  selection,
  exactRefs,
  transport,
  onSelectionChange,
  onOpenHost,
  onCompose,
  onOpenAgent,
  onError,
}: VibeExplorationPanelProps) {
  const headingId = useId();
  const hostId = useId();
  const hostHeadingId = useId();
  const [state, setState] = useState<PanelState>(INITIAL_STATE);
  const [recordHost, setRecordHost] = useState<AgentRecordHostState | null>(null);
  const stateRef = useRef(state);
  const selectionRef = useRef(selection);
  const exactRefsRef = useRef(exactRefs);
  const callbacksRef = useRef({ onSelectionChange, onError });
  const projectEpochRef = useRef(0);
  const projectRootRef = useRef(projectRoot);
  const requestGenerationRef = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const hostHeadingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusTriggerRef = useRef<AgentRecordHostState["trigger"] | null>(null);
  const restoreHostFocusRef = useRef(false);
  const explorationListScrollRef = useRef(0);
  const hostObservedSelectionRef = useRef(selection);
  const hostWasOpenRef = useRef(false);

  stateRef.current = state;
  selectionRef.current = selection;
  exactRefsRef.current = exactRefs;
  projectRootRef.current = projectRoot;
  callbacksRef.current = { onSelectionChange, onError };

  const openRecordHost = useCallback((
    trigger: AgentRecordHostState["trigger"],
    nextSelection: VibeExplorationSelection,
  ) => {
    const list = panelRef.current?.querySelector<HTMLElement>(".rho-vibe-exploration-list");
    explorationListScrollRef.current = list?.scrollTop ?? 0;
    returnFocusTriggerRef.current = trigger;
    restoreHostFocusRef.current = false;
    hostObservedSelectionRef.current = selectionRef.current;
    setRecordHost({ trigger, selection: nextSelection });
    onOpenHost();
  }, [onOpenHost]);

  const closeRecordHost = useCallback((restoreFocus: boolean) => {
    restoreHostFocusRef.current = restoreFocus;
    setRecordHost(null);
  }, []);

  useEffect(() => {
    const wasOpen = hostWasOpenRef.current;
    hostWasOpenRef.current = recordHost != null;
    if (recordHost != null) {
      if (!wasOpen) hostHeadingRef.current?.focus();
      return;
    }
    const list = panelRef.current?.querySelector<HTMLElement>(".rho-vibe-exploration-list");
    if (list != null) list.scrollTop = explorationListScrollRef.current;
    if (!restoreHostFocusRef.current) return;
    restoreHostFocusRef.current = false;
    const trigger = returnFocusTriggerRef.current;
    returnFocusTriggerRef.current = null;
    const target = trigger == null
      ? null
      : panelRef.current?.querySelector<HTMLButtonElement>(
          `button[data-agent-record-trigger="${trigger}"]`,
        ) ?? null;
    const fallback = panelRef.current?.querySelector<HTMLButtonElement>(
      "button[data-exploration-conversation][aria-current='true']",
    ) ?? panelRef.current?.querySelector<HTMLButtonElement>(
      "button[data-exploration-conversation]",
    ) ?? panelRef.current?.querySelector<HTMLElement>("h2") ?? null;
    (target ?? fallback)?.focus();
  }, [recordHost]);

  useEffect(() => {
    setRecordHost(null);
    restoreHostFocusRef.current = false;
    returnFocusTriggerRef.current = null;
  }, [pageId, projectId, projectRoot]);

  useEffect(() => {
    if (recordHost == null || sameSelection(hostObservedSelectionRef.current, selection)) return;
    hostObservedSelectionRef.current = selection;
    if (sameSelection(recordHost.selection, selection)) return;
    returnFocusTriggerRef.current = null;
    closeRecordHost(true);
  }, [closeRecordHost, recordHost, selection.conversationId, selection.turnId]);

  const publish = useCallback((next: PanelState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const refresh = useCallback(async (
    preferred: VibeExplorationSelection = selectionRef.current,
    epoch = projectEpochRef.current,
    expectedProjectRoot = projectRootRef.current,
  ) => {
    const requestGeneration = ++requestGenerationRef.current;
    const current = stateRef.current;
    if (current.kind === "ready") {
      publish({ ...current, refreshing: true, refreshMessage: null });
    }
    try {
      let hintedDetail: AgentTurnDetail | null = null;
      const hintedDetailPromise = preferred.conversationId == null && preferred.turnId != null
        ? transport.getAgentTurnDetail(preferred.turnId).catch((error: unknown) => {
            if (
              epoch === projectEpochRef.current &&
              requestGeneration === requestGenerationRef.current
            ) callbacksRef.current.onError(boundedExplorationError(error));
            return null;
          })
        : Promise.resolve(null);
      const [loadedConversationRecords, resolvedHint] = await Promise.all([
        transport.listAgentConversations(CONVERSATION_LIMIT),
        hintedDetailPromise,
      ]);
      hintedDetail = resolvedHint;
      if (
        epoch !== projectEpochRef.current ||
        requestGeneration !== requestGenerationRef.current
      ) return;
      if (
        projectRootRef.current !== expectedProjectRoot
        || loadedConversationRecords.some(
          (conversation) => conversation.project_root !== expectedProjectRoot,
        )
        || (hintedDetail != null && hintedDetail.turn.project_root !== expectedProjectRoot)
      ) throw new ExplorationProjectMismatchError();
      const conversationRecords = loadedConversationRecords.slice(0, CONVERSATION_LIMIT);

      const selectedConversationId = selectConversationId(
        conversationRecords,
        preferred,
        hintedDetail,
        exactRefsRef.current.conversationIds,
      );
      const selectedConversationIsLoaded = selectedConversationId != null && conversationRecords.some(
        (conversation) => conversation.conversation_id === selectedConversationId,
      );
      const loadedTurnRecords = !selectedConversationIsLoaded
        ? []
        : await transport.listAgentTurns(selectedConversationId, TURN_LIMIT);
      if (
        epoch !== projectEpochRef.current ||
        requestGeneration !== requestGenerationRef.current
      ) return;
      if (
        projectRootRef.current !== expectedProjectRoot
        || loadedTurnRecords.some((turn) => turn.project_root !== expectedProjectRoot)
      ) throw new ExplorationProjectMismatchError();
      const turnRecords = loadedTurnRecords.slice(0, TURN_LIMIT);

      let detailFailures = 0;
      const hintedTurn = hintedDetail == null
        ? null
        : turnRecords.find((turn) => turn.turn_id === hintedDetail?.turn.turn_id) ?? null;
      const detailCandidates = [
        ...(hintedTurn == null ? [] : [hintedTurn]),
        ...turnRecords.filter((turn) => turn.turn_id !== hintedTurn?.turn_id),
      ].slice(0, DETAIL_LIMIT);
      const loadedDetails = await Promise.all(detailCandidates.map(async (turn) => {
        if (hintedDetail?.turn.turn_id === turn.turn_id) return hintedDetail;
        try {
          const detail = await transport.getAgentTurnDetail(turn.turn_id);
          if (detail != null && detail.turn.project_root !== expectedProjectRoot) {
            throw new ExplorationProjectMismatchError();
          }
          return detail;
        } catch (error: unknown) {
          if (error instanceof ExplorationProjectMismatchError) throw error;
          detailFailures += 1;
          if (
            epoch === projectEpochRef.current &&
            requestGeneration === requestGenerationRef.current
          ) callbacksRef.current.onError(boundedExplorationError(error));
          return null;
        }
      }));
      if (
        epoch !== projectEpochRef.current ||
        requestGeneration !== requestGenerationRef.current
      ) return;
      if (projectRootRef.current !== expectedProjectRoot) {
        throw new ExplorationProjectMismatchError();
      }

      const details = new Map(detailCandidates.map(
        (turn, index) => [turn.turn_id, loadedDetails[index] ?? null] as const,
      ));
      const conversations = conversationRecords.map(projectExplorationConversation);
      const turns = turnRecords.map((turn) => projectExplorationTurn(turn, details.get(turn.turn_id) ?? null));
      const selectedTurnId = preferred.turnId ?? turns[0]?.turnId ?? null;
      const data: ExplorationData = {
        conversations,
        turns,
        selectedConversationId,
        selectedTurnId,
        detailFailures,
      };
      publish({
        kind: "ready",
        data,
        refreshing: false,
        stale: false,
        refreshMessage: null,
      });
      const installedSelection = projectedSelection(data);
      if (!sameSelection(installedSelection, selectionRef.current)) {
        callbacksRef.current.onSelectionChange(installedSelection);
      }
    } catch (error: unknown) {
      if (
        epoch !== projectEpochRef.current ||
        requestGeneration !== requestGenerationRef.current
      ) return;
      const message = boundedErrorMessage(error);
      callbacksRef.current.onError(new Error(message));
      const latest = stateRef.current;
      if (latest.kind === "ready") {
        publish({
          ...latest,
          refreshing: false,
          stale: true,
          refreshMessage: message,
        });
      } else {
        publish({ kind: "failed", message });
      }
    }
  }, [publish, transport]);

  useEffect(() => {
    const epoch = ++projectEpochRef.current;
    requestGenerationRef.current = 0;
    publish(INITIAL_STATE);
    void refresh(selectionRef.current, epoch);
    const unsubscribe = transport.subscribeAgentInvalidated(() => {
      void refresh(selectionRef.current, epoch);
    });
    return () => {
      unsubscribe();
      if (projectEpochRef.current === epoch) projectEpochRef.current += 1;
    };
  }, [projectId, projectRoot, publish, refresh, transport]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.kind !== "ready") return;
    if (!sameSelection(selection, projectedSelection(current.data))) {
      void refresh(selection);
    }
  }, [refresh, selection.conversationId, selection.turnId]);

  const selectConversation = (conversationId: string) => {
    const next = { conversationId, turnId: null };
    onSelectionChange(next);
    void refresh(next);
  };

  const selectTurn = (turnId: string) => {
    const current = stateRef.current;
    if (current.kind !== "ready" || current.data.selectedConversationId == null) return;
    const next = {
      conversationId: current.data.selectedConversationId,
      turnId,
    };
    publish({
      ...current,
      data: { ...current.data, selectedTurnId: turnId },
    });
    setRecordHost((host) => host == null ? null : { ...host, selection: next });
    onSelectionChange(next);
  };

  const ready = state.kind === "ready" ? state : null;
  const selectedConversation = ready?.data.conversations.find(
    (conversation) => conversation.conversationId === ready.data.selectedConversationId,
  ) ?? null;
  const selectedTurn = ready?.data.turns.find(
    (turn) => turn.turnId === ready.data.selectedTurnId,
  ) ?? null;
  const conversationTabStopId = selectedConversation?.conversationId
    ?? ready?.data.conversations[0]?.conversationId
    ?? null;
  const turnTabStopId = selectedTurn?.turnId ?? ready?.data.turns[0]?.turnId ?? null;
  const turnNavigation = ready != null
    && presentation === "focused"
    && ready.data.turns.length > 0
    && (ready.data.turns.length > 1 || selectedTurn == null)
    ? (
        <nav className="rho-vibe-exploration-turns" aria-label="最近 Turn 记录">
          <ol>
            {ready.data.turns.map((turn) => (
              <li key={turn.turnId}>
                <button
                  type="button"
                  data-exploration-turn
                  aria-current={turn.turnId === selectedTurn?.turnId ? "true" : undefined}
                  tabIndex={turn.turnId === turnTabStopId ? 0 : -1}
                  onKeyDown={(event) => keyboardListNavigation(
                    event,
                    "button[data-exploration-turn]",
                  )}
                  onClick={() => selectTurn(turn.turnId)}
                >
                  <span>{turn.task}</span>
                  <small>{turn.status.label}{turn.retryOfTurnId == null ? "" : " · 重试记录"}</small>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )
    : null;
  const currentSelection = ready == null
    ? selection
    : projectedSelection(ready.data);
  const exact = selectedConversation != null && ready != null && conversationHasExactReference(
    selectedConversation.conversationId,
    ready.data.turns,
    exactRefs.conversationIds,
    exactRefs.taskIds,
  );
  const latestActivity = selectedTurn?.activities.at(-1) ?? null;
  const activeCount = ready?.data.conversations.filter(
    (conversation) => conversation.status.active,
  ).length ?? 0;
  const attentionCount = ready?.data.conversations.filter(
    (conversation) => conversation.needsAttention,
  ).length ?? 0;

  return (
    <section
      ref={panelRef}
      className="rho-vibe-exploration"
      data-presentation={presentation}
      data-agent-host-open={recordHost == null ? undefined : "true"}
      aria-labelledby={headingId}
      aria-busy={state.kind === "loading" || ready?.refreshing === true}
    >
      <header className="rho-vibe-exploration-header">
        <div>
          <span className="rho-eyebrow">Agent 工作</span>
          <h2 id={headingId} tabIndex={-1}>自主探索</h2>
        </div>
        {ready != null && ready.data.conversations.length > 0 && (
          <p aria-live="polite">
            最近 {ready.data.conversations.length} 项
            {activeCount > 0 ? ` · ${activeCount} 项进行中` : ""}
            {attentionCount > 0 ? ` · ${attentionCount} 项等待你` : ""}
          </p>
        )}
      </header>

      {state.kind === "loading" && (
        <div className="rho-vibe-exploration-state" role="status">正在读取最近的 Agent 工作…</div>
      )}

      {state.kind === "failed" && (
        <div className="rho-vibe-exploration-state rho-vibe-exploration-state-error" role="alert">
          <strong>自主探索记录暂时不可用</strong>
          <p>{state.message}</p>
          <button type="button" onClick={() => void refresh()}>重新加载</button>
        </div>
      )}

      {ready != null && (
        <>
          {ready.stale && (
            <div className="rho-vibe-exploration-stale" role="status">
              <strong>记录可能不是最新</strong>
              {ready.refreshMessage != null && <span>{ready.refreshMessage}</span>}
              <button type="button" disabled={ready.refreshing} onClick={() => void refresh()}>
                {ready.refreshing ? "正在更新…" : "重新加载"}
              </button>
            </div>
          )}
          {ready.data.detailFailures > 0 && !ready.stale && (
            <p className="rho-vibe-exploration-detail-warning" role="status">
              {ready.data.detailFailures} 项详细记录暂时不可用；会话状态仍来自当前摘要。
            </p>
          )}

          {recordHost != null ? (
            <VibeAgentRecordHost
              ref={hostHeadingRef}
              id={hostId}
              headingId={hostHeadingId}
              selection={recordHost.selection}
              conversation={selectedConversation}
              selectedTurn={selectedTurn}
              exact={exact}
              turnNavigation={turnNavigation}
              onClose={() => closeRecordHost(true)}
              onCompose={onCompose}
              onOpenAgent={onOpenAgent}
            />
          ) : ready.data.conversations.length === 0 ? (
            <div className="rho-vibe-exploration-state rho-vibe-exploration-state-empty" role="status">
              <strong>尚无自主探索</strong>
              <p>可以从当前手稿提出一个问题；这里不会创建聊天标签页。</p>
              <button
                type="button"
                data-agent-record-trigger="start"
                aria-expanded={false}
                aria-controls={hostId}
                onClick={() => openRecordHost("start", currentSelection)}
              >开始探索</button>
            </div>
          ) : (
            <div className="rho-vibe-exploration-body">
              <nav className="rho-vibe-exploration-list" aria-label="最近探索会话">
                <ul>
                  {ready.data.conversations.map((conversation) => {
                    const selected = conversation.conversationId === ready.data.selectedConversationId;
                    const linked = conversationHasExactReference(
                      conversation.conversationId,
                      ready.data.turns,
                      exactRefs.conversationIds,
                      exactRefs.taskIds,
                    );
                    return (
                      <li key={conversation.conversationId}>
                        <button
                          type="button"
                          data-exploration-conversation
                          data-status={conversation.status.kind}
                          aria-current={selected ? "true" : undefined}
                          tabIndex={conversation.conversationId === conversationTabStopId ? 0 : -1}
                          title={conversation.title}
                          onKeyDown={(event) => keyboardListNavigation(
                            event,
                            "button[data-exploration-conversation]",
                          )}
                          onClick={() => selectConversation(conversation.conversationId)}
                        >
                          <span>{conversation.title}</span>
                          <small>
                            {conversation.status.label} · {conversation.turnCount} 次记录
                            {conversation.needsAttention ? " · 等待你" : ""}
                            {linked ? " · 手稿已引用" : ""}
                          </small>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </nav>

              <article className="rho-vibe-exploration-detail">
                {selectedConversation == null ? (
                  <div className="rho-vibe-exploration-state" role="status">选中的探索记录已不可用。</div>
                ) : (
                  <>
                    <header>
                      <div>
                        <h3>{selectedConversation.title}</h3>
                        <span data-status={selectedTurn?.status.kind ?? selectedConversation.status.kind}>
                          {selectedTurn?.needsAttention === true && selectedTurn.status.kind === "waiting"
                            ? "等待你处理"
                            : selectedTurn?.status.label ?? selectedConversation.status.label}
                        </span>
                      </div>
                      <p className={exact
                        ? "rho-vibe-exploration-link rho-vibe-exploration-link-exact"
                        : "rho-vibe-exploration-link rho-vibe-exploration-link-unlinked"}
                      >
                        {exact
                          ? "这项 Agent 工作来自手稿中的精确引用。"
                          : "显示项目最近的 Agent 工作；尚未与当前手稿内容建立精确对应。"}
                      </p>
                    </header>

                    {ready.data.turns.length === 0 ? (
                      <div className="rho-vibe-exploration-state rho-vibe-exploration-state-empty" role="status">
                        <strong>会话已建立，尚未开始探索</strong>
                        <button
                          type="button"
                          data-agent-record-trigger="record"
                          aria-expanded={false}
                          aria-controls={hostId}
                          onClick={() => openRecordHost("record", currentSelection)}
                        >查看 Agent 工作区</button>
                      </div>
                    ) : selectedTurn == null ? (
                      <>
                        {turnNavigation}
                        <div className="rho-vibe-exploration-state" role="status">选中的探索记录已不可用。</div>
                      </>
                    ) : (
                      <>
                        {turnNavigation}

                        <section className="rho-vibe-exploration-task" aria-label="Agent 收到的任务">
                          <span className="rho-eyebrow">任务</span>
                          <p>{selectedTurn.task}</p>
                        </section>

                        {selectedTurn.retryOfTurnId != null && (
                          <p className="rho-vibe-exploration-retry-lineage">这是一次精确记录的重试；原记录未被改写。</p>
                        )}

                        {selectedTurn.needsAttention && selectedTurn.status.kind === "waiting" && (
                          <div className="rho-vibe-exploration-attention" role="status">
                            <strong>Agent 正在等待你处理现有请求</strong>
                            <span>授权与敏感操作仍在完整 Agent 界面中处理。</span>
                          </div>
                        )}

                        {latestActivity != null && (
                          <section className="rho-vibe-exploration-activity" aria-label="最新公开活动">
                            <span className="rho-eyebrow">最新活动</span>
                            <strong>{latestActivity.title}</strong>
                            {latestActivity.body != null && <p>{latestActivity.body}</p>}
                          </section>
                        )}

                        {selectedTurn.finalMessage != null && (
                          <section className="rho-vibe-exploration-outcome" aria-label="Agent 最终回复">
                            <span className="rho-eyebrow">Agent 回复</span>
                            <p>{selectedTurn.finalMessage}</p>
                          </section>
                        )}

                        {selectedTurn.errorMessage != null && (
                          <div className="rho-vibe-exploration-turn-error" role={selectedTurn.status.kind === "failed" ? "alert" : "status"}>
                            <strong>{selectedTurn.status.kind === "cancelled" ? "探索已取消" : "运行记录"}</strong>
                            <p>{selectedTurn.errorMessage}</p>
                          </div>
                        )}

                        {!selectedTurn.detailAvailable && (
                          <p className="rho-vibe-exploration-detail-warning" role="status">
                            详细执行记录暂时不可用；这里保留当前 Turn 摘要。
                          </p>
                        )}

                        {presentation === "focused" && selectedTurn.activities.length > 0 && (
                          <details className="rho-vibe-exploration-activity-log">
                            <summary>公开执行记录 · {selectedTurn.activities.length}</summary>
                            <ol>
                              {selectedTurn.activities.map((activity) => (
                                <li data-activity-kind={activity.kind} key={activity.key}>
                                  <strong>{activity.title}</strong>
                                  {activity.body != null && <p>{activity.body}</p>}
                                  {activity.code != null && (
                                    <details>
                                      <summary>查看执行代码</summary>
                                      <pre>{activity.code}</pre>
                                    </details>
                                  )}
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}

                        <footer className="rho-vibe-exploration-actions">
                          <button
                            type="button"
                            data-agent-record-trigger="record"
                            aria-expanded={false}
                            aria-controls={hostId}
                            onClick={() => openRecordHost("record", currentSelection)}
                          >在 Vibe 中查看 Agent 记录</button>
                        </footer>
                      </>
                    )}
                  </>
                )}
              </article>
            </div>
          )}
        </>
      )}
    </section>
  );
}
