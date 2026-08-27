import type {
  ProjectSwitchResponse,
  UiKernelTransport,
  WorkspacePreparation,
  WorkspacePreparationIssue,
  WorkspacePreparationStage,
} from "../../transport";
import { projectSwitchFailure } from "../controllers/project-switch-controller";
import {
  applyStartupProgress,
  createStartupLedger,
  markStartupAttention,
  startupAttentionStage,
  startupStep,
  type StartupLedger,
} from "./startup-ledger";

export type StartupRecoveryKind = "choose_project" | "choose_rscript";
export type StartupFocusTarget = "issue_heading" | "recovery_action";

export interface StartupControllerSnapshot {
  readonly status: "preparing" | "needs_attention" | "ready";
  readonly ledger: StartupLedger;
  readonly issue: WorkspacePreparationIssue | null;
  readonly result: WorkspacePreparation | null;
  readonly recovery: StartupRecoveryKind | null;
  readonly startedAtMs: number;
  readonly focusRequest: number;
  readonly focusTarget: StartupFocusTarget | null;
}

export interface StartupController {
  readonly getSnapshot: () => StartupControllerSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly connect: () => () => void;
  readonly start: () => void;
  readonly retry: () => void;
  readonly chooseRscript: () => void;
  readonly chooseProject: () => void;
  readonly dispose: () => void;
}

interface StartupControllerOptions {
  readonly now?: () => number;
}

const TECHNICAL_DETAIL_LIMIT = 2_048;
const orderedStages: readonly WorkspacePreparationStage[] = [
  "runtime",
  "workspace",
  "project",
];

function boundedTechnicalDetail(value: unknown): string {
  let detail: string;
  try {
    detail = value instanceof Error ? value.message : String(value);
  } catch {
    detail = "The transport rejected startup without a readable error.";
  }
  return detail.slice(0, TECHNICAL_DETAIL_LIMIT);
}

function projectRecoveryDetail(response: ProjectSwitchResponse): string {
  if (response.unavailable != null) {
    return `Selected project: ${response.unavailable.path}\nReason: ${response.unavailable.reason}`
      .slice(0, TECHNICAL_DETAIL_LIMIT);
  }
  return [
    `project_pick_directory returned ${response.status}`,
    response.reason_code,
    response.message,
  ].filter((value): value is string => value != null && value.length > 0)
    .join("\n")
    .slice(0, TECHNICAL_DETAIL_LIMIT);
}

function stageFromResult(
  ledger: StartupLedger,
  result: WorkspacePreparation,
): WorkspacePreparationStage {
  const observed = ledger.steps.find(
    (step) => step.state === "active" || step.state === "attention",
  )?.stage;
  if (observed != null) return observed;
  if (result.workspace_ready) return "project";
  const hint = `${result.phase} ${result.issue?.code ?? ""}`.toLowerCase();
  if (hint.includes("workspace")) return "workspace";
  // Project admission cannot be inferred when the aggregate result says the
  // Workspace itself is unavailable; avoid manufacturing completed stages
  // from a contradictory phase string.
  return "runtime";
}

function establishPriorStages(
  ledger: StartupLedger,
  stage: WorkspacePreparationStage,
): StartupLedger {
  let next = ledger;
  for (const prior of orderedStages.slice(0, orderedStages.indexOf(stage))) {
    const step = startupStep(next, prior);
    if (step.state === "complete") continue;
    if (step.state !== "active") {
      next = applyStartupProgress(next, { stage: prior, state: "active" });
    }
    if (prior === "runtime") {
      next = applyStartupProgress(next, { stage: "runtime", state: "complete" });
    } else if (prior === "workspace") {
      next = applyStartupProgress(next, { stage: "workspace", state: "complete" });
    }
  }
  return next;
}

function recoveryFor(
  stage: WorkspacePreparationStage,
  workspaceReady: boolean,
): StartupRecoveryKind | null {
  if (stage === "runtime") return "choose_rscript";
  if (stage === "project" && workspaceReady) return "choose_project";
  return null;
}

function fallbackIssue(stage: WorkspacePreparationStage): WorkspacePreparationIssue {
  if (stage === "workspace") {
    return {
      code: "WORKSPACE_START_FAILED",
      title: "Workspace R could not start",
      message: "Retry Workspace R startup to continue.",
      technical_detail: null,
    };
  }
  if (stage === "project") {
    return {
      code: "PROJECT_RESTORE_INCOMPLETE",
      title: "The project could not be restored",
      message: "Choose another project folder or retry startup.",
      technical_detail: null,
    };
  }
  return {
    code: "RUNTIME_PREPARATION_FAILED",
    title: "Rho could not prepare the R runtime",
    message: "Retry startup or choose a valid Rscript executable.",
    technical_detail: null,
  };
}

function rejectionIssue(
  stage: WorkspacePreparationStage,
  error: unknown,
): WorkspacePreparationIssue {
  const fallback = fallbackIssue(stage);
  return {
    ...fallback,
    code: "PREPARATION_FAILED",
    technical_detail: boundedTechnicalDetail(error),
  };
}

function rejectedPreparation(
  ledger: StartupLedger,
  stage: WorkspacePreparationStage,
  issue: WorkspacePreparationIssue,
): WorkspacePreparation {
  return {
    status: "needs_attention",
    phase: "preparation_failed",
    workspace_ready: startupStep(ledger, "workspace").state === "complete",
    restored_project_status: null,
    issue,
  };
}

/**
 * Owns startup admission independently of React's effect lifecycle. Progress
 * is cached in this external store, so a StrictMode unsubscribe gap cannot
 * lose an observed command boundary or start a second backend bootstrap.
 */
export function createStartupController(
  transport: UiKernelTransport,
  options: StartupControllerOptions = {},
): StartupController {
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot: StartupControllerSnapshot = {
    status: "preparing",
    ledger: createStartupLedger(),
    issue: null,
    result: null,
    recovery: null,
    startedAtMs: now(),
    focusRequest: 0,
    focusTarget: null,
  };
  let started = false;
  let disposed = false;
  let actionInFlight = false;
  let generation = 0;
  let connectionCount = 0;
  let disposalToken = 0;
  let focusSequence = 0;

  const getSnapshot = () => snapshot;

  const publish = (next: StartupControllerSnapshot) => {
    if (disposed || Object.is(next, snapshot)) return;
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Store observers cannot control startup admission.
      }
    }
  };

  const operationIsCurrent = (operationGeneration: number) =>
    !disposed && operationGeneration === generation;

  const publishAttention = (
    ledger: StartupLedger,
    result: WorkspacePreparation,
    stage: WorkspacePreparationStage,
  ) => {
    const established = establishPriorStages(ledger, stage);
    const attention = markStartupAttention(established, stage);
    const issue = result.issue ?? fallbackIssue(stage);
    focusSequence += 1;
    publish({
      status: "needs_attention",
      ledger: attention,
      issue,
      result: { ...result, issue },
      recovery: recoveryFor(stage, result.workspace_ready),
      startedAtMs: snapshot.startedAtMs,
      focusRequest: focusSequence,
      focusTarget: "issue_heading",
    });
  };

  const runPreparation = (chooseRscript: boolean) => {
    if (disposed || actionInFlight) return;
    actionInFlight = true;
    const operationGeneration = generation + 1;
    generation = operationGeneration;
    publish({
      status: "preparing",
      // prepareWorkspace always begins at runtime bootstrap. A retry must not
      // keep a later failed row active while that earlier command is running.
      ledger: createStartupLedger(),
      issue: null,
      result: null,
      recovery: null,
      startedAtMs: now(),
      focusRequest: snapshot.focusRequest,
      focusTarget: null,
    });

    let request: Promise<WorkspacePreparation>;
    let closed = false;
    try {
      request = transport.prepareWorkspace(chooseRscript, (progress) => {
        if (closed || !operationIsCurrent(operationGeneration)) return;
        const ledger = applyStartupProgress(snapshot.ledger, progress);
        if (ledger === snapshot.ledger) return;
        publish({
          ...snapshot,
          status: "preparing",
          ledger,
          issue: null,
          result: null,
          recovery: null,
          focusTarget: null,
        });
      });
    } catch (error: unknown) {
      closed = true;
      actionInFlight = false;
      if (!operationIsCurrent(operationGeneration)) return;
      const failedStage = startupAttentionStage(snapshot.ledger);
      const issue = rejectionIssue(failedStage, error);
      publishAttention(
        snapshot.ledger,
        rejectedPreparation(snapshot.ledger, failedStage, issue),
        failedStage,
      );
      return;
    }

    void request.then((result) => {
      if (closed || !operationIsCurrent(operationGeneration)) return;
      closed = true;
      actionInFlight = false;
      if (result.status === "ready") {
        publish({
          ...snapshot,
          status: "ready",
          issue: null,
          result,
          recovery: null,
          focusTarget: null,
        });
        return;
      }
      const failedStage = stageFromResult(snapshot.ledger, result);
      publishAttention(snapshot.ledger, result, failedStage);
    }).catch((error: unknown) => {
      if (closed || !operationIsCurrent(operationGeneration)) return;
      closed = true;
      actionInFlight = false;
      const failedStage = startupAttentionStage(snapshot.ledger);
      const issue = rejectionIssue(failedStage, error);
      publishAttention(
        snapshot.ledger,
        rejectedPreparation(snapshot.ledger, failedStage, issue),
        failedStage,
      );
    });
  };

  const start = () => {
    if (started || disposed) return;
    started = true;
    runPreparation(false);
  };

  const retry = () => {
    if (snapshot.status !== "needs_attention") return;
    runPreparation(false);
  };

  const chooseRscript = () => {
    if (snapshot.status !== "needs_attention" || snapshot.recovery !== "choose_rscript") return;
    runPreparation(true);
  };

  const chooseProject = () => {
    if (
      disposed
      || actionInFlight
      || snapshot.status !== "needs_attention"
      || snapshot.recovery !== "choose_project"
      || snapshot.result?.workspace_ready !== true
    ) return;
    actionInFlight = true;
    const previous = snapshot;
    const operationGeneration = generation + 1;
    generation = operationGeneration;
    const ledger = applyStartupProgress(previous.ledger, { stage: "project", state: "active" });
    publish({
      status: "preparing",
      ledger,
      issue: null,
      result: null,
      recovery: null,
      startedAtMs: now(),
      focusRequest: previous.focusRequest,
      focusTarget: null,
    });

    let request: Promise<ProjectSwitchResponse>;
    try {
      request = transport.pickProjectDirectory();
    } catch (error: unknown) {
      request = Promise.reject(error);
    }
    void request.then((response) => {
      if (!operationIsCurrent(operationGeneration)) return;
      actionInFlight = false;
      if (response.status === "ready") {
        publish({
          ...snapshot,
          status: "ready",
          issue: null,
          result: {
            status: "ready",
            phase: "project_ready",
            workspace_ready: true,
            restored_project_status: "ready",
            issue: null,
          },
          recovery: null,
          focusTarget: null,
        });
        return;
      }
      if (response.status === "cancelled") {
        focusSequence += 1;
        publish({
          ...previous,
          focusRequest: focusSequence,
          focusTarget: "recovery_action",
        });
        return;
      }
      const issue: WorkspacePreparationIssue = {
        code: "PROJECT_SELECTION_INCOMPLETE",
        title: "The selected project could not be opened",
        message: projectSwitchFailure(response, null)
          ?? "Choose another project folder to continue.",
        technical_detail: projectRecoveryDetail(response),
      };
      publishAttention(
        snapshot.ledger,
        {
          status: "needs_attention",
          phase: "project_selection_incomplete",
          workspace_ready: true,
          restored_project_status: response.status,
          issue,
        },
        "project",
      );
    }).catch((error: unknown) => {
      if (!operationIsCurrent(operationGeneration)) return;
      actionInFlight = false;
      const issue: WorkspacePreparationIssue = {
        code: "PROJECT_SELECTION_FAILED",
        title: "The project picker could not open the selected project",
        message: "Choose another project folder or retry startup.",
        technical_detail: boundedTechnicalDetail(error),
      };
      publishAttention(
        snapshot.ledger,
        {
          status: "needs_attention",
          phase: "project_selection_failed",
          workspace_ready: true,
          restored_project_status: null,
          issue,
        },
        "project",
      );
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    actionInFlight = false;
    listeners.clear();
  };

  const connect = () => {
    if (disposed) return () => undefined;
    connectionCount += 1;
    disposalToken += 1;
    start();
    let disconnected = false;
    return () => {
      if (disconnected) return;
      disconnected = true;
      connectionCount = Math.max(0, connectionCount - 1);
      const token = disposalToken + 1;
      disposalToken = token;
      queueMicrotask(() => {
        if (connectionCount === 0 && disposalToken === token) dispose();
      });
    };
  };

  return {
    getSnapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect,
    start,
    retry,
    chooseRscript,
    chooseProject,
    dispose,
  };
}
