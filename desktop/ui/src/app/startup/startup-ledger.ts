import type {
  WorkspacePreparationProgress,
  WorkspacePreparationStage,
} from "../../transport/types";

export type StartupLedgerStepState =
  | "waiting"
  | "active"
  | "complete"
  | "attention";

export interface StartupLedgerStep {
  readonly stage: WorkspacePreparationStage;
  readonly label: string;
  readonly state: StartupLedgerStepState;
  readonly detail: string | null;
}

export interface StartupLedger {
  readonly steps: readonly StartupLedgerStep[];
  readonly summary: string;
}

const stages: readonly WorkspacePreparationStage[] = [
  "runtime",
  "workspace",
  "project",
];

const stageLabels: Readonly<Record<WorkspacePreparationStage, string>> = {
  runtime: "R runtime",
  workspace: "Workspace R",
  project: "Project",
};

const activeSummaries: Readonly<Record<WorkspacePreparationStage, string>> = {
  runtime: "Checking your R installation.",
  workspace: "Starting Workspace R.",
  project: "Restoring your project.",
};

const defaultCompleteDetails: Readonly<Record<WorkspacePreparationStage, string>> = {
  runtime: "R is ready.",
  workspace: "Workspace R is ready.",
  project: "Project is ready.",
};

const STARTUP_FACT_BYTE_LIMIT = 512;
const utf8Encoder = new TextEncoder();

function wellFormedFact(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value.slice(index, index + 2);
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value[index];
    }
  }
  return result;
}

function boundedFact(value: string | undefined): string | null {
  if (value == null || value.trim().length === 0) return null;
  const normalized = wellFormedFact(value);
  if (utf8Encoder.encode(normalized).byteLength <= STARTUP_FACT_BYTE_LIMIT) return normalized;
  const suffix = "…";
  const budget = STARTUP_FACT_BYTE_LIMIT - utf8Encoder.encode(suffix).byteLength;
  let bounded = "";
  let byteLength = 0;
  for (const character of normalized) {
    const characterBytes = utf8Encoder.encode(character).byteLength;
    if (byteLength + characterBytes > budget) break;
    bounded += character;
    byteLength += characterBytes;
  }
  return `${bounded}${suffix}`;
}

function progressRank(progress: WorkspacePreparationProgress): number {
  return stages.indexOf(progress.stage) * 2 + (progress.state === "complete" ? 1 : 0);
}

function ledgerRank(ledger: StartupLedger): number {
  let rank = -1;
  for (const [index, step] of ledger.steps.entries()) {
    if (step.state === "active") rank = Math.max(rank, index * 2);
    if (step.state === "complete") rank = Math.max(rank, index * 2 + 1);
  }
  return rank;
}

function completedDetail(
  progress: Extract<WorkspacePreparationProgress, { readonly state: "complete" }>,
): string {
  if (progress.stage === "runtime") {
    const version = boundedFact(progress.r_version);
    return version == null ? defaultCompleteDetails.runtime : `R version: ${version}`;
  }
  if (progress.stage === "workspace") {
    const pid = progress.workspace_pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
      ? `Workspace R is ready · Process ${pid}`
      : defaultCompleteDetails.workspace;
  }
  const root = boundedFact(progress.project_root);
  return root ?? defaultCompleteDetails.project;
}

/** Create a ledger before the first transport progress boundary is observed. */
export function createStartupLedger(): StartupLedger {
  return {
    steps: stages.map((stage) => ({
      stage,
      label: stageLabels[stage],
      state: "waiting",
      detail: null,
    })),
    summary: "Waiting to begin startup.",
  };
}

/**
 * Project one immutable transport boundary into the visible ledger.
 * Missing, skipped, or stale boundaries cannot manufacture established facts
 * or move the presentation backwards.
 */
export function applyStartupProgress(
  ledger: StartupLedger,
  progress: WorkspacePreparationProgress,
): StartupLedger {
  const attentionStage = ledger.steps.find((step) => step.state === "attention")?.stage;
  if (
    attentionStage != null
    && (progress.stage !== attentionStage || progress.state !== "active")
  ) return ledger;
  const currentRank = ledgerRank(ledger);
  const nextRank = progressRank(progress);
  if (nextRank < currentRank || nextRank > currentRank + 1) return ledger;

  const targetIndex = stages.indexOf(progress.stage);
  const steps = ledger.steps.map((step, index): StartupLedgerStep => {
    if (index !== targetIndex) return step;
    if (progress.state === "active") {
      return { ...step, state: "active", detail: null };
    }
    return { ...step, state: "complete", detail: completedDetail(progress) };
  });

  const allComplete = steps.every((step) => step.state === "complete");
  return {
    steps,
    summary: progress.state === "active"
      ? activeSummaries[progress.stage]
      : allComplete
        ? "Your workspace is ready."
        : `${stageLabels[progress.stage]} is ready.`,
  };
}

/** Mark one failed boundary while retaining every fact established before it. */
export function markStartupAttention(
  ledger: StartupLedger,
  stage: WorkspacePreparationStage = startupAttentionStage(ledger),
): StartupLedger {
  const activeStage = ledger.steps.find((step) => step.state === "active")?.stage;
  const resolvedStage = activeStage ?? stage;
  return {
    steps: ledger.steps.map((step): StartupLedgerStep => {
      if (step.stage === resolvedStage) return { ...step, state: "attention", detail: null };
      return step;
    }),
    summary: `${stageLabels[resolvedStage]} needs attention.`,
  };
}

/** Resolve the active boundary, or the next truthful boundary if commands rejected. */
export function startupAttentionStage(
  ledger: StartupLedger,
): WorkspacePreparationStage {
  return ledger.steps.find((step) => step.state === "active" || step.state === "attention")?.stage
    ?? ledger.steps.find((step) => step.state === "waiting")?.stage
    ?? "project";
}

export function startupStep(
  ledger: StartupLedger,
  stage: WorkspacePreparationStage,
): StartupLedgerStep {
  const step = ledger.steps.find((candidate) => candidate.stage === stage);
  if (step == null) throw new Error(`Startup ledger is missing ${stage}.`);
  return step;
}
