import { useEffect, useState } from "react";

import type { AgentTurnSummary } from "../../transport";

import { AGENT_MODE_HINTS, formatContextTokens } from "./view-state";
import type { AgentSurfaceVm } from "./useAgentSurface";

export function AgentRunningRow({ status, startedAt, onStop }: {
  readonly status: AgentTurnSummary["status"];
  readonly startedAt: string;
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
      <button type="button" onClick={onStop}>Stop</button>
    </div>
  );
}

function ModeMenu({ vm }: { readonly vm: AgentSurfaceVm }) {
  const { view, commitView } = vm;
  return (
    <details className="rho-agent-mode-menu">
      <summary aria-label={`Agent mode: ${view.mode}`}>
        <span>{view.mode}</span>
      </summary>
      <div role="menu" aria-label="Agent mode choices">
        <div className="rho-agent-mode" role="group" aria-label="Agent mode">
          {(["ask", "plan", "act"] as const).map((mode) => (
            <div className="rho-agent-mode-option" key={mode}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={view.mode === mode}
                aria-pressed={view.mode === mode}
                onClick={(event) => {
                  event.currentTarget.closest("details")!.open = false;
                  commitView({
                    ...view,
                    mode,
                    auto_approve: mode === "act" ? view.auto_approve : false,
                  });
                }}
              >{mode}</button>
              <small>{AGENT_MODE_HINTS[mode]}</small>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

const POSTURE_OPTIONS = [{
  id: "ask",
  label: "Ask every time",
  hint: "Every tool action waits for your approval.",
}, {
  id: "auto",
  label: "Auto-approve project tools for this conversation",
  hint: "Applies in Act mode. The broker still evaluates each action; approvals appear when required.",
}] as const;

function PostureMenu({ vm }: { readonly vm: AgentSurfaceVm }) {
  const { view, commitView } = vm;
  const postureLabel = view.auto_approve ? "Auto-approve tools" : "Ask every time";
  return (
    <details className="rho-agent-posture-menu">
      <summary aria-label={`Permission posture: ${postureLabel}`}>
        <span>{postureLabel}</span>
      </summary>
      <div role="menu" aria-label="Permission posture choices">
        {view.mode !== "act" ? (<>
          <div className="rho-agent-mode-option">
            <button
              type="button"
              role="menuitemradio"
              aria-checked="true"
              onClick={(event) => {
                event.currentTarget.closest("details")!.open = false;
              }}
            >Ask every time</button>
            <small>Every tool action waits for your approval.</small>
          </div>
          <p className="rho-agent-posture-note">Auto-approve is available in Act mode.</p>
        </>) : POSTURE_OPTIONS.map((option) => {
          const active = (option.id === "auto") === view.auto_approve;
          return (
            <div className="rho-agent-mode-option" key={option.id}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={option.id === "auto" ? "rho-agent-auto-approve" : undefined}
                onClick={(event) => {
                  event.currentTarget.closest("details")!.open = false;
                  commitView({ ...view, auto_approve: option.id === "auto" });
                }}
              >{option.label}</button>
              <small>{option.hint}</small>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function ModelMenu({ vm }: { readonly vm: AgentSurfaceVm }) {
  const {
    chatModelLabel, modelSwitchBusy, modelQuery, setModelQuery,
    switchableModels, filteredModels, modelGroups, activeChatModelId, selectChatModel,
  } = vm;
  return (
    <details className="rho-agent-model-menu">
      <summary aria-label={`Chat model: ${chatModelLabel}`} aria-busy={modelSwitchBusy} onClick={(event) => {
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
            onChange={(event) => setModelQuery(event.target.value)}
          />
        )}
        {switchableModels.length === 0 && <span className="rho-agent-model-empty">No language model is available.</span>}
        {switchableModels.length > 0 && filteredModels.length === 0 && (
          <span className="rho-agent-model-empty">No model matches the search.</span>
        )}
        {modelGroups.map(([provider, models]) => (
          <div className="rho-agent-model-group" key={provider}>
            <div className="rho-agent-model-group-label">{provider}</div>
            {models.map((model) => {
              const active = model.id === activeChatModelId;
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  disabled={modelSwitchBusy}
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
  );
}

export function AgentComposer({ vm }: { readonly vm: AgentSurfaceVm }) {
  const {
    instance, view, commitView, persist, reportError,
    busy, health, contextReviewBusy, reviewContext, submit,
    activeTurn, stopActiveTurn, runtimeOutputContext, clearRuntimeOutputContext,
    contextPreview, contextPlanKey,
    queue, cancelQueued, moveQueuedUp,
  } = vm;
  return (
    <div className="rho-agent-composer">
      {activeTurn != null && stopActiveTurn != null && (
        <AgentRunningRow status={activeTurn.status} startedAt={activeTurn.started_at} onStop={stopActiveTurn} />
      )}
      {queue.length > 0 && (
        <ol className="rho-agent-queue" aria-label="Queued follow-ups">
          {queue.map((item, index) => (
            <li className="rho-agent-queue-item" key={item.id}>
              <span className="rho-agent-queue-label">Queued</span>
              <span className="rho-agent-queue-prompt" title={item.prompt}>{item.prompt}</span>
              <span className="rho-agent-queue-actions">
                {index > 0 && <button type="button" aria-label="Move queued message up" onClick={() => moveQueuedUp(item.id)}>↑</button>}
                <button type="button" aria-label="Cancel queued message" onClick={() => cancelQueued(item.id)}>×</button>
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
        <button type="button" aria-label="Remove Runtime output from Agent context" onClick={clearRuntimeOutputContext}>×</button>
      </div>}
      <textarea
        aria-label={`Agent prompt ${instance.instance_id}`}
        value={view.composer}
        disabled={busy}
        onChange={(event) => commitView({ ...view, composer: event.target.value }, false)}
        onBlur={() => void persist(view).catch(reportError)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Ask Rho about this project…"
      />
      <div className="rho-agent-context-controls">
        <button type="button" className="rho-agent-icon-action" aria-label="Review context" title="Review context" aria-busy={contextReviewBusy} disabled={busy || contextReviewBusy || health?.state !== "ready" || !view.composer.trim()} onClick={() => void reviewContext()}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></svg><span className="rho-sr-only">Review context</span>
        </button>
        <ModeMenu vm={vm} />
        <PostureMenu vm={vm} />
        <small className="rho-agent-mode-hint">{AGENT_MODE_HINTS[view.mode]}</small>
        <ModelMenu vm={vm} />
        <button type="button" className="rho-primary-action" disabled={busy || contextReviewBusy || health?.state !== "ready" || !view.composer.trim()} onClick={() => void submit()}>
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
  );
}
