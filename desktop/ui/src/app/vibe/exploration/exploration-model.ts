import type {
  AgentConversationSummary,
  AgentTurnDetail,
  AgentTurnEvent,
  AgentTurnSummary,
} from "../../../transport";
import { vibeFailureMessage } from "../core/vibe-failure";

export type ExplorationDisplayStatus =
  | "empty"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export type ExplorationActivityKind = "agent" | "execution" | "attention";

export interface ExplorationStatusView {
  readonly kind: ExplorationDisplayStatus;
  readonly label: string;
  readonly active: boolean;
  readonly retryable: boolean;
}

export interface ExplorationConversationView {
  readonly conversationId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly status: ExplorationStatusView;
  readonly needsAttention: boolean;
  readonly latestTurnId: string | null;
  readonly latestTask: string | null;
  readonly legacyReadOnly: boolean;
}

export interface ExplorationActivityView {
  readonly key: string;
  readonly kind: ExplorationActivityKind;
  readonly title: string;
  readonly body: string | null;
  readonly timestamp: string;
  readonly status: string;
  readonly code: string | null;
}

export interface ExplorationTurnView {
  readonly turnId: string;
  readonly conversationId: string;
  readonly status: ExplorationStatusView;
  readonly task: string;
  readonly finalMessage: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly retryOfTurnId: string | null;
  readonly needsAttention: boolean;
  readonly detailAvailable: boolean;
  readonly activities: readonly ExplorationActivityView[];
}

const PUBLIC_AGENT_EVENT_TYPES = new Set([
  "agent.run_started",
  "tool.call_started",
  "tool.call_completed",
  "tool.call_failed",
  "chat.message_completed",
  "desktop.agent_completed",
  "desktop.agent_failed",
  "agent.cancelled",
  "agent.interrupted",
]);

const STATUS_LABELS: Readonly<Record<ExplorationDisplayStatus, string>> = {
  empty: "尚未开始",
  running: "探索中",
  waiting: "等待中",
  completed: "已结束",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  unknown: "状态未知",
};

function boundedPublicText(value: string | null | undefined, limit = 1_200): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function publicActivityBody(event: AgentTurnEvent): string | null {
  const fileProposalFact = "Agent 记录了一项文件修改建议；修改内容和应用操作仅在 Studio 中检查。";
  if (event.tool === "propose_file_edit") return fileProposalFact;
  const rawBody = event.body?.trim();
  if (rawBody == null || rawBody.length === 0) return null;
  if (!rawBody.startsWith("{")) return boundedPublicText(rawBody);
  if (rawBody.length > 64_000) {
    return "结构化活动详情过长；请在 Studio 中检查原始记录。";
  }
  try {
    const payload = JSON.parse(rawBody) as { readonly kind?: unknown };
    if (payload.kind === "rho.file_edit_proposal") {
      return fileProposalFact;
    }
  } catch {
    return "结构化活动详情格式不可用；请在 Studio 中检查原始记录。";
  }
  return boundedPublicText(rawBody);
}

function isFailureActivity(event: AgentTurnEvent): boolean {
  return event.event_type === "tool.call_failed" ||
    event.event_type === "desktop.agent_failed" ||
    event.event_type === "agent.interrupted" ||
    event.event_type === "agent.cancelled";
}

function publicFailureActivityText(
  value: string | null | undefined,
  fallback: string,
  limit: number,
): string | null {
  const bounded = boundedPublicText(value, limit);
  return bounded == null ? null : vibeFailureMessage(bounded, fallback);
}

export function projectExplorationStatus(
  status: string,
  terminalReason: string | null,
): ExplorationStatusView {
  const normalized = status.trim().toLowerCase();
  let kind: ExplorationDisplayStatus;
  if (normalized === "interrupted" && terminalReason === "user_cancelled") {
    kind = "cancelled";
  } else if (normalized === "cancelled") {
    // Browser/mock compatibility only. Durable Agent truth uses
    // interrupted + terminal_reason=user_cancelled.
    kind = "cancelled";
  } else if (
    normalized === "empty" || normalized === "running" || normalized === "waiting" ||
    normalized === "completed" || normalized === "failed" || normalized === "interrupted"
  ) {
    kind = normalized;
  } else {
    kind = "unknown";
  }
  return {
    kind,
    label: STATUS_LABELS[kind],
    active: kind === "running" || kind === "waiting",
    retryable: kind === "failed" || kind === "cancelled" || kind === "interrupted",
  };
}

export function projectExplorationConversation(
  conversation: AgentConversationSummary,
): ExplorationConversationView {
  return {
    conversationId: conversation.conversation_id,
    title: boundedPublicText(conversation.title, 240) ?? "未命名探索",
    updatedAt: conversation.updated_at,
    turnCount: Math.max(0, conversation.turn_count),
    status: projectExplorationStatus(conversation.status, conversation.terminal_reason),
    needsAttention: conversation.pending_request_id != null,
    latestTurnId: conversation.latest_turn_id,
    latestTask: boundedPublicText(conversation.latest_prompt_preview, 320),
    legacyReadOnly: conversation.legacy_unthreaded,
  };
}

function activityKind(event: AgentTurnEvent): ExplorationActivityKind {
  if (
    event.event_type === "tool.call_started" || event.event_type === "tool.call_completed" ||
    event.event_type === "tool.call_failed"
  ) return event.event_type === "tool.call_failed" ? "attention" : "execution";
  if (
    event.event_type === "desktop.agent_failed" || event.event_type === "agent.cancelled" ||
    event.event_type === "agent.interrupted"
  ) return "attention";
  return "agent";
}

export function projectExplorationActivities(
  events: readonly AgentTurnEvent[],
): readonly ExplorationActivityView[] {
  return [...events]
    .sort((left, right) => left.id - right.id)
    .flatMap((event) => {
      if (!PUBLIC_AGENT_EVENT_TYPES.has(event.event_type)) return [];
      const failureActivity = isFailureActivity(event);
      const body = publicActivityBody(event);
      return [{
        key: `${event.turn_id}:${event.id}`,
        kind: activityKind(event),
        title: failureActivity
          ? publicFailureActivityText(event.title, "Agent 活动失败。", 240) ?? "Agent 活动失败。"
          : boundedPublicText(event.title, 240) ?? "Agent 活动",
        body: failureActivity
          ? publicFailureActivityText(body, "Agent 失败详情暂时不可用。", 1_200)
          : body,
        timestamp: event.timestamp,
        status: failureActivity
          ? publicFailureActivityText(event.status, "failed", 120) ?? "failed"
          : event.status,
        // Vibe may disclose explicitly public code for successful activity, but
        // failure records can contain the rejected implementation payload.
        // Keep that payload in the trusted Studio surface instead of trying to
        // infer which fragments are safe to reveal here.
        code: failureActivity ? null : boundedPublicText(event.code, 16_000),
      } satisfies ExplorationActivityView];
    });
}

function fullTask(detail: AgentTurnDetail | null, fallback: string): string {
  const prompt = detail?.events.find((event) => event.event_type === "agent.user_prompt")?.body;
  return boundedPublicText(prompt, 8_000) ?? boundedPublicText(fallback, 1_200) ?? "未记录任务";
}

export function projectExplorationTurn(
  turn: AgentTurnSummary,
  detail: AgentTurnDetail | null,
): ExplorationTurnView {
  const matchingDetail = detail?.turn.turn_id === turn.turn_id ? detail : null;
  const waitingApproval = matchingDetail?.approvals.some((approval) => approval.status === "waiting") === true;
  const errorMessage = boundedPublicText(turn.error_message, 4_000);
  return {
    turnId: turn.turn_id,
    conversationId: turn.conversation_id,
    status: projectExplorationStatus(turn.status, turn.terminal_reason),
    task: fullTask(matchingDetail, turn.prompt_preview),
    finalMessage: boundedPublicText(turn.final_message, 16_000),
    errorMessage: errorMessage == null
      ? null
      : vibeFailureMessage(errorMessage, "Agent 失败详情暂时不可用。"),
    startedAt: turn.started_at,
    finishedAt: turn.finished_at,
    retryOfTurnId: turn.retry_of_turn_id,
    needsAttention: turn.pending_request_id != null || waitingApproval,
    detailAvailable: matchingDetail != null,
    activities: projectExplorationActivities(matchingDetail?.events ?? []),
  };
}

export function conversationHasExactReference(
  conversationId: string,
  turns: readonly ExplorationTurnView[],
  exactConversationIds: readonly string[],
  exactTaskIds: readonly string[],
): boolean {
  return exactConversationIds.includes(conversationId) || turns.some(
    (turn) => turn.conversationId === conversationId && exactTaskIds.includes(turn.turnId),
  );
}
