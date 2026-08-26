import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspacePreparationIssue } from "../../transport/types";
import {
  applyStartupProgress,
  createStartupLedger,
  markStartupAttention,
} from "./startup-ledger";
import {
  formatStartupElapsed,
  StartupLedgerView,
} from "./StartupLedgerView";
import type { StartupLedgerViewProps } from "./StartupLedgerView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const issue: WorkspacePreparationIssue = {
  code: "PROJECT_RESTORE_INCOMPLETE",
  title: "The saved project could not be restored",
  message: "Workspace R is available. Choose or reopen a project to continue.",
  technical_detail: "Saved project: /missing/project\nReason: directory does not exist",
};

function throughWorkspaceComplete() {
  let ledger = applyStartupProgress(createStartupLedger(), { stage: "runtime", state: "active" });
  ledger = applyStartupProgress(ledger, {
    stage: "runtime",
    state: "complete",
    r_version: "4.5.1",
  });
  ledger = applyStartupProgress(ledger, { stage: "workspace", state: "active" });
  return applyStartupProgress(ledger, {
    stage: "workspace",
    state: "complete",
    workspace_pid: 4_242,
  });
}

function projectLedger(state: "active" | "complete", root = "/projects/rho-analysis") {
  const active = applyStartupProgress(throughWorkspaceComplete(), {
    stage: "project",
    state: "active",
  });
  return state === "active" ? active : applyStartupProgress(active, {
    stage: "project",
    state: "complete",
    project_root: root,
  });
}

describe("StartupLedgerView", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderView(props: Partial<StartupLedgerViewProps> = {}) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const defaultLedger = applyStartupProgress(createStartupLedger(), {
      stage: "runtime",
      state: "active",
    });
    act(() => {
      root.render(<StartupLedgerView
        ledger={defaultLedger}
        issue={null}
        recoveryAction={null}
        onRetry={() => undefined}
        {...props}
      />);
    });
    return { container, root };
  }

  it("renders one wordmark and a semantic three-step ledger with truthful active copy", () => {
    let ledger = applyStartupProgress(createStartupLedger(), { stage: "runtime", state: "active" });
    ledger = applyStartupProgress(ledger, {
      stage: "runtime",
      state: "complete",
      r_version: "4.5.1",
    });
    ledger = applyStartupProgress(ledger, { stage: "workspace", state: "active" });
    const { container } = renderView({ ledger });

    expect(container.querySelectorAll(".rho-startup-wordmark")).toHaveLength(1);
    expect(container.querySelector(".rho-startup-wordmark")?.textContent).toBe("Rho");
    expect(container.querySelector("h1")?.textContent).toBe("Opening your workspace");
    expect(container.querySelectorAll("ol[aria-label='Startup progress'] > li")).toHaveLength(3);
    expect(container.querySelector("[aria-current='step'] .rho-startup-step-label")?.textContent)
      .toBe("Workspace R");
    expect(container.querySelector("[role='status']")?.textContent).toBe("Starting Workspace R.");
    expect(container.querySelector("[role='status']")?.closest("[aria-busy='true']")).toBeNull();
    expect(container.querySelector("ol[aria-label='Startup progress']")?.getAttribute("aria-busy"))
      .toBe("true");
    expect(container.textContent).toContain("R version: 4.5.1");
    expect(container.textContent).toContain("Complete");
    expect(container.textContent).toContain("In progress");
    expect(container.textContent).toContain("Waiting");
    expect(container.textContent).not.toMatch(/Surface|%|ETA|estimated|remaining/i);
  });

  it("shows elapsed wall time only after eight seconds without changing stages or live copy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const ledger = projectLedger("active");
    const originalStates = ledger.steps.map((step) => step.state);
    const startedAtMs = Date.now();
    const { container, root } = renderView({ ledger, startedAtMs });

    act(() => vi.advanceTimersByTime(7_999));
    expect(container.querySelector(".rho-startup-footer")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector(".rho-startup-still")?.textContent).toBe("Still working");
    expect(container.querySelector(".rho-startup-elapsed")?.textContent).toBe("8 seconds elapsed");
    expect(container.querySelector("[role='status']")?.textContent).toBe("Restoring your project.");
    expect(ledger.steps.map((step) => step.state)).toEqual(originalStates);

    act(() => vi.advanceTimersByTime(1_000));
    expect(container.querySelector(".rho-startup-elapsed")?.textContent).toBe("9 seconds elapsed");
    expect(container.textContent).not.toMatch(/ETA|estimated|remaining/i);

    const retryStartedAtMs = Date.now();
    act(() => {
      root.render(<StartupLedgerView
        ledger={ledger}
        issue={null}
        recoveryAction={null}
        onRetry={() => undefined}
        startedAtMs={retryStartedAtMs}
      />);
    });
    expect(container.querySelector(".rho-startup-footer")).toBeNull();
    act(() => vi.advanceTimersByTime(8_000));
    expect(container.querySelector(".rho-startup-elapsed")?.textContent).toBe("8 seconds elapsed");
  });

  it("demotes technical details and exposes project recovery as the primary action", () => {
    const choose = vi.fn();
    const retry = vi.fn();
    const ledger = markStartupAttention(projectLedger("active"));
    const { container, root } = renderView({
      ledger,
      issue,
      recoveryAction: { kind: "choose_project", onChoose: choose },
      onRetry: retry,
    });

    expect(container.querySelectorAll("[role='alert']")).toHaveLength(1);
    expect(container.querySelector("[role='status']")).toBeNull();
    const heading = container.querySelector<HTMLHeadingElement>(".rho-startup-attention h2")!;
    expect(heading.textContent).toBe(issue.title);
    expect(heading.textContent).not.toContain(issue.code);
    expect(heading.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);
    const disclosure = container.querySelector<HTMLDetailsElement>(".rho-startup-technical")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector("code")?.textContent).toBe(issue.code);
    expect(disclosure.querySelector("pre")?.textContent).toBe(issue.technical_detail);

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".rho-startup-actions button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Choose project", "Retry"]);
    expect(buttons[0]?.classList.contains("rho-primary-action")).toBe(true);
    expect(disclosure.compareDocumentPosition(buttons[1]!) & Node.DOCUMENT_POSITION_PRECEDING)
      .not.toBe(0);
    buttons[0]?.focus();
    expect(document.activeElement).toBe(buttons[0]);
    act(() => {
      root.render(<StartupLedgerView
        ledger={ledger}
        issue={{ ...issue }}
        recoveryAction={{ kind: "choose_project", onChoose: choose }}
        onRetry={retry}
      />);
    });
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0]?.click();
    buttons[1]?.click();
    expect(choose).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers Rscript recovery for a runtime issue and preserves a long completed path", () => {
    const choose = vi.fn();
    const projectRoot = `/projects/${"deeply-nested/".repeat(20)}analysis`;
    let ledger = projectLedger("complete", projectRoot);
    const rendered = renderView({ ledger });
    expect(rendered.container.querySelector(".rho-startup-step-detail")?.textContent).not.toBeNull();
    expect(rendered.container.textContent).toContain(projectRoot);

    const runtimeIssue: WorkspacePreparationIssue = {
      code: "R_NOT_FOUND",
      title: "R was not found",
      message: "Choose Rscript manually.",
      technical_detail: null,
    };
    ledger = markStartupAttention(createStartupLedger(), "runtime");
    act(() => {
      rendered.root.render(<StartupLedgerView
        ledger={ledger}
        issue={runtimeIssue}
        recoveryAction={{ kind: "choose_rscript", onChoose: choose }}
        onRetry={() => undefined}
      />);
    });
    const primary = rendered.container.querySelector<HTMLButtonElement>(".rho-primary-action")!;
    expect(primary.textContent).toBe("Choose Rscript");
    primary.click();
    expect(choose).toHaveBeenCalledOnce();
  });

  it("makes Retry the sole primary action for a Workspace R failure", () => {
    const retry = vi.fn();
    const workspaceIssue: WorkspacePreparationIssue = {
      code: "WORKSPACE_START_FAILED",
      title: "Workspace R could not start",
      message: "Retry the Workspace R startup command.",
      technical_detail: "Workspace broker unavailable",
    };
    const ledger = markStartupAttention(applyStartupProgress(
      applyStartupProgress(
        applyStartupProgress(createStartupLedger(), { stage: "runtime", state: "active" }),
        { stage: "runtime", state: "complete", r_version: "4.5.1" },
      ),
      { stage: "workspace", state: "active" },
    ));
    const { container } = renderView({
      ledger,
      issue: workspaceIssue,
      recoveryAction: null,
      onRetry: retry,
    });

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(
      ".rho-startup-actions button",
    )];
    expect(buttons.map((button) => button.textContent)).toEqual(["Retry"]);
    expect(buttons[0]?.classList.contains("rho-primary-action")).toBe(true);
    expect(container.textContent).not.toContain("Choose Rscript");
    buttons[0]?.click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps a long technical detail inside the dedicated narrow-layout wrapper", () => {
    const technicalDetail = `Failure detail: ${"unbroken-path-segment".repeat(30)}`;
    const ledger = markStartupAttention(projectLedger("active"));
    const { container } = renderView({
      ledger,
      issue: { ...issue, technical_detail: technicalDetail },
      recoveryAction: { kind: "choose_project", onChoose: () => undefined },
    });
    const detail = container.querySelector(".rho-startup-technical-detail");
    expect(detail?.tagName).toBe("PRE");
    expect(detail?.textContent).toBe(technicalDetail);
  });

  it("does not move focus during ordinary progress and focuses a terminal issue once", () => {
    const focusAnchor = document.createElement("button");
    focusAnchor.textContent = "Existing focus";
    document.body.append(focusAnchor);
    let ledger = applyStartupProgress(createStartupLedger(), { stage: "runtime", state: "active" });
    const { container, root } = renderView({ ledger });
    focusAnchor.focus();

    ledger = applyStartupProgress(ledger, { stage: "runtime", state: "complete", r_version: "4.5.1" });
    act(() => {
      root.render(<StartupLedgerView
        ledger={ledger}
        issue={null}
        recoveryAction={null}
        onRetry={() => undefined}
      />);
    });
    expect(document.activeElement).toBe(focusAnchor);

    ledger = applyStartupProgress(ledger, { stage: "workspace", state: "active" });
    ledger = markStartupAttention(ledger);
    act(() => {
      root.render(<StartupLedgerView
        ledger={ledger}
        issue={{ ...issue, code: "WORKSPACE_START_FAILED" }}
        recoveryAction={{ kind: "choose_rscript", onChoose: () => undefined }}
        onRetry={() => undefined}
      />);
    });
    const heading = container.querySelector<HTMLHeadingElement>(".rho-startup-attention h2")!;
    expect(document.activeElement).toBe(heading);

    const primary = container.querySelector<HTMLButtonElement>(".rho-primary-action")!;
    primary.focus();
    act(() => {
      root.render(<StartupLedgerView
        ledger={ledger}
        issue={{ ...issue, code: "WORKSPACE_START_FAILED", message: "Still unavailable." }}
        recoveryAction={{ kind: "choose_rscript", onChoose: () => undefined }}
        onRetry={() => undefined}
      />);
    });
    expect(document.activeElement).toBe(primary);
  });

  it("formats bounded elapsed labels without predicting completion", () => {
    expect(formatStartupElapsed(-1)).toBe("0 seconds elapsed");
    expect(formatStartupElapsed(1_000)).toBe("1 second elapsed");
    expect(formatStartupElapsed(60_000)).toBe("1 minute elapsed");
    expect(formatStartupElapsed(61_000)).toBe("1 minute 1 second elapsed");
    expect(formatStartupElapsed(125_000)).toBe("2 minutes 5 seconds elapsed");
  });
});
