import { forwardRef } from "react";
import type { ReactNode } from "react";

import type {
  ExplorationConversationView,
  ExplorationTurnView,
} from "./exploration-model";

export interface VibeAgentRecordSelection {
  readonly conversationId: string | null;
  readonly turnId: string | null;
}

export interface VibeAgentRecordHostProps {
  readonly id: string;
  readonly headingId: string;
  readonly selection: VibeAgentRecordSelection;
  readonly conversation: ExplorationConversationView | null;
  readonly selectedTurn: ExplorationTurnView | null;
  readonly exact: boolean;
  readonly turnNavigation: ReactNode;
  readonly onClose: () => void;
  readonly onCompose: (selection: VibeAgentRecordSelection) => void;
  readonly onOpenAgent: (selection: VibeAgentRecordSelection) => void;
}

/**
 * A Vibe-owned projection of durable public Agent truth. This deliberately
 * does not mount the trusted Studio Agent Surface or expose mutation controls.
 */
export const VibeAgentRecordHost = forwardRef<
  HTMLHeadingElement,
  VibeAgentRecordHostProps
>(function VibeAgentRecordHost({
  id,
  headingId,
  selection,
  conversation,
  selectedTurn,
  exact,
  turnNavigation,
  onClose,
  onCompose,
  onOpenAgent,
}, headingRef) {
  const unresolvedSelection = conversation == null
    && (selection.conversationId != null || selection.turnId != null);
  const unresolvedTurn = conversation != null
    && selectedTurn == null
    && selection.turnId != null;

  return (
    <section
      id={id}
      className="rho-vibe-agent-record-host"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="rho-vibe-agent-record-host-header">
        <button
          type="button"
          className="rho-vibe-agent-record-back"
          onClick={onClose}
        >返回探索记录</button>
        <div>
          <span className="rho-eyebrow">Vibe 内 Agent 记录</span>
          <h3 ref={headingRef} id={headingId} tabIndex={-1}>
            {conversation?.title ?? "准备新的探索"}
          </h3>
        </div>
        {conversation != null && (
          <span data-status={selectedTurn?.status.kind ?? conversation.status.kind}>
            {selectedTurn?.needsAttention === true && selectedTurn.status.kind === "waiting"
              ? "等待你处理"
              : selectedTurn?.status.label ?? conversation.status.label}
          </span>
        )}
      </header>

      <p className="rho-vibe-agent-record-boundary">
        这里展示同一 Agent 会话的只读公开记录；执行、授权、文件变更与设置仍只在 Studio 中进行。
      </p>

      {conversation == null ? (
        <div className="rho-vibe-agent-record-empty" role="status">
          {unresolvedSelection ? (
            <>
              <strong>这项 Agent 记录已不可用</strong>
              <p>当前项目没有返回所选 Conversation 或 Turn；Vibe 不会用其他最近记录替代它。</p>
            </>
          ) : (
            <>
              <strong>还没有 Agent 记录</strong>
              <p>你可以留在 Vibe 继续整理手稿；需要发起任务时，再明确进入 Studio。</p>
            </>
          )}
        </div>
      ) : (
        <div className="rho-vibe-agent-record-body">
          <p className={exact
            ? "rho-vibe-exploration-link rho-vibe-exploration-link-exact"
            : "rho-vibe-exploration-link rho-vibe-exploration-link-unlinked"}
          >
            {exact
              ? "这项 Agent 工作来自手稿中的精确引用。"
              : "显示项目最近的 Agent 工作；尚未与当前手稿内容建立精确对应。"}
          </p>

          {turnNavigation}

          {selectedTurn == null ? (
            <div className="rho-vibe-agent-record-empty" role="status">
              {unresolvedTurn ? (
                <>
                  <strong>所选 Turn 已不可用</strong>
                  <p>当前会话没有返回这个精确 Turn；Vibe 不会用其他记录替代它。</p>
                </>
              ) : (
                <>
                  <strong>会话已建立，尚无可展示的 Turn</strong>
                  <p>Vibe 保留这个精确会话身份，不会推测尚未发生的探索。</p>
                </>
              )}
            </div>
          ) : (
            <>
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
                  <span>这里仅报告等待状态；具体请求与可信操作在 Studio 中处理。</span>
                </div>
              )}

              <section className="rho-vibe-agent-record-activity" aria-label="Agent 公开执行记录">
                <header>
                  <span className="rho-eyebrow">公开活动</span>
                  <strong>{selectedTurn.activities.length} 项</strong>
                </header>
                {selectedTurn.activities.length === 0 ? (
                  <p>当前 Turn 没有可公开展示的活动记录。</p>
                ) : (
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
                )}
              </section>

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
            </>
          )}
        </div>
      )}

      <footer className="rho-vibe-agent-record-actions">
        <p>进入 Studio 前会先确认手稿已保存，并保留返回当前 Vibe 位置的路径。</p>
        {conversation == null ? (
          !unresolvedSelection && (
            <button type="button" onClick={() => onCompose(selection)}>
              在 Studio 中发起探索
            </button>
          )
        ) : unresolvedTurn ? null : conversation.legacyReadOnly ? (
          <button type="button" onClick={() => onCompose(selection)}>
            在 Studio 中发起新的探索
          </button>
        ) : selectedTurn == null ? (
          <button type="button" onClick={() => onCompose(selection)}>
            在 Studio 中提出任务
          </button>
        ) : (
          <div>
            <button type="button" onClick={() => onCompose(selection)}>
              在 Studio 中继续探索
            </button>
            <button type="button" onClick={() => onOpenAgent(selection)}>
              在 Studio 中深入检查
            </button>
          </div>
        )}
      </footer>
    </section>
  );
});
