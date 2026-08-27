import { useEffect, useId, useRef, useState } from "react";

import type { WorkspacePreparationIssue } from "../../transport";
import type { StartupFocusTarget } from "./startup-controller";
import type { StartupLedger, StartupLedgerStepState } from "./startup-ledger";

export const STARTUP_LONG_RUNNING_MS = 8_000;

export type StartupRecoveryAction =
  | { readonly kind: "choose_project"; readonly onChoose: () => void }
  | { readonly kind: "choose_rscript"; readonly onChoose: () => void };

export interface StartupLedgerViewProps {
  readonly ledger: StartupLedger;
  readonly issue: WorkspacePreparationIssue | null;
  readonly recoveryAction: StartupRecoveryAction | null;
  readonly onRetry: () => void;
  readonly startedAtMs?: number;
  readonly now?: () => number;
  readonly admissionPending?: boolean;
  readonly focusRequest?: number;
  readonly focusTarget?: StartupFocusTarget | null;
}

const stateLabels: Readonly<Record<StartupLedgerStepState, string>> = {
  waiting: "Waiting",
  active: "In progress",
  complete: "Complete",
  attention: "Needs attention",
};

const stateMarkers: Readonly<Record<StartupLedgerStepState, string>> = {
  waiting: "○",
  active: "◐",
  complete: "✓",
  attention: "!",
};

function wallClockNow(): number {
  return Date.now();
}

export function formatStartupElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds} ${totalSeconds === 1 ? "second" : "seconds"} elapsed`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0
    ? `${minutes} ${minutes === 1 ? "minute" : "minutes"} elapsed`
    : `${minutes} ${minutes === 1 ? "minute" : "minutes"} ${seconds} ${seconds === 1 ? "second" : "seconds"} elapsed`;
}

function useStartupElapsed(
  startedAtMs: number,
  running: boolean,
  now: () => number,
): number {
  const [sample, setSample] = useState(() => ({
    startedAtMs,
    elapsedMs: Math.max(0, now() - startedAtMs),
  }));
  const elapsedMs = sample.startedAtMs === startedAtMs
    ? sample.elapsedMs
    : Math.max(0, now() - startedAtMs);

  useEffect(() => {
    if (!running) return;
    let intervalId: number | undefined;
    const update = () => setSample({
      startedAtMs,
      elapsedMs: Math.max(0, now() - startedAtMs),
    });
    const remaining = Math.max(0, STARTUP_LONG_RUNNING_MS - (now() - startedAtMs));
    const timeoutId = window.setTimeout(() => {
      update();
      intervalId = window.setInterval(update, 1_000);
    }, remaining);
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId != null) window.clearInterval(intervalId);
    };
  }, [now, running, startedAtMs]);

  return elapsedMs;
}

export function StartupLedgerView({
  ledger,
  issue,
  recoveryAction,
  onRetry,
  startedAtMs,
  now = wallClockNow,
  admissionPending = false,
  focusRequest,
  focusTarget,
}: StartupLedgerViewProps) {
  const fallbackStartedAt = useRef<number | null>(null);
  if (fallbackStartedAt.current == null) fallbackStartedAt.current = now();
  const resolvedStartedAt = startedAtMs ?? fallbackStartedAt.current;
  const issueTitleId = useId();
  const issueHeadingRef = useRef<HTMLHeadingElement>(null);
  const recoveryActionRef = useRef<HTMLButtonElement>(null);
  const attentionWasVisible = useRef(false);
  const handledFocusRequest = useRef<number | null>(null);
  const hasAttention = ledger.steps.some((step) => step.state === "attention");
  const attentionIsVisible = hasAttention && issue != null;
  const isActive = ledger.steps.some((step) => step.state === "active");
  const isRunning = !hasAttention && (admissionPending || isActive);
  const isPending = !hasAttention && (
    admissionPending || ledger.steps.some((step) => step.state !== "complete")
  );
  const elapsedMs = useStartupElapsed(resolvedStartedAt, isRunning, now);
  const showElapsed = isRunning && elapsedMs >= STARTUP_LONG_RUNNING_MS;
  const recoveryLabel = recoveryAction?.kind === "choose_project"
    ? "Choose project"
    : "Choose Rscript";

  useEffect(() => {
    if (!attentionIsVisible) {
      attentionWasVisible.current = false;
      return;
    }
    if (focusRequest != null && focusTarget != null) {
      if (handledFocusRequest.current !== focusRequest) {
        if (focusTarget === "recovery_action") recoveryActionRef.current?.focus();
        else issueHeadingRef.current?.focus();
        handledFocusRequest.current = focusRequest;
      }
    } else if (focusRequest == null && !attentionWasVisible.current) {
      issueHeadingRef.current?.focus();
    }
    attentionWasVisible.current = true;
  }, [attentionIsVisible, focusRequest, focusTarget]);

  return (
    <main className="rho-startup-shell">
      <section className="rho-startup-panel" aria-labelledby="rho-startup-title">
        <header className="rho-startup-header">
          <div className="rho-startup-wordmark" aria-label="Rho">Rho</div>
          <div className="rho-startup-intro">
            <h1 id="rho-startup-title">Opening your workspace</h1>
            <p
              className="rho-startup-summary"
              role={hasAttention ? undefined : "status"}
              aria-live={hasAttention ? undefined : "polite"}
              aria-atomic={hasAttention ? undefined : "true"}
            >
              {ledger.summary}
            </p>
          </div>
        </header>

        <ol
          className="rho-startup-ledger"
          aria-label="Startup progress"
          aria-busy={isPending ? "true" : undefined}
        >
          {ledger.steps.map((step) => (
            <li
              className="rho-startup-step"
              data-state={step.state}
              aria-current={step.state === "active" ? "step" : undefined}
              key={step.stage}
            >
              <span className="rho-startup-step-marker" aria-hidden="true">
                {stateMarkers[step.state]}
              </span>
              <div className="rho-startup-step-copy">
                <span className="rho-startup-step-label">{step.label}</span>
                {step.detail != null && <p className="rho-startup-step-detail">{step.detail}</p>}
              </div>
              <span className="rho-startup-step-state">{stateLabels[step.state]}</span>
            </li>
          ))}
        </ol>

        {attentionIsVisible && (
          <section
            className="rho-startup-attention"
            role="alert"
            aria-labelledby={issueTitleId}
          >
            <h2 id={issueTitleId} ref={issueHeadingRef} tabIndex={-1}>{issue.title}</h2>
            <p>{issue.message}</p>
            <div className="rho-startup-actions">
              {recoveryAction != null && (
                <button
                  className="rho-primary-action"
                  type="button"
                  onClick={recoveryAction.onChoose}
                  ref={recoveryActionRef}
                >
                  {recoveryLabel}
                </button>
              )}
              <button
                className={recoveryAction == null ? "rho-primary-action" : undefined}
                type="button"
                onClick={onRetry}
              >
                Retry
              </button>
            </div>
            {(issue.code.length > 0 || issue.technical_detail != null) && (
              <details className="rho-startup-technical">
                <summary>Technical details</summary>
                {issue.code.length > 0 && (
                  <dl>
                    <div>
                      <dt>Code</dt>
                      <dd><code>{issue.code}</code></dd>
                    </div>
                  </dl>
                )}
                {issue.technical_detail != null && (
                  <pre className="rho-startup-technical-detail">{issue.technical_detail}</pre>
                )}
              </details>
            )}
          </section>
        )}

        {showElapsed && (
          <footer className="rho-startup-footer">
            <span className="rho-startup-still">Still working</span>
            <span className="rho-startup-elapsed">{formatStartupElapsed(elapsedMs)}</span>
          </footer>
        )}
      </section>
    </main>
  );
}
