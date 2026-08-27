import { describe, expect, it } from "vitest";

import {
  applyStartupProgress,
  createStartupLedger,
  markStartupAttention,
  startupAttentionStage,
  startupStep,
} from "./startup-ledger";

function states(ledger: ReturnType<typeof createStartupLedger>) {
  return ledger.steps.map((step) => step.state);
}

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
    workspace_pid: 4_212,
  });
}

describe("startup ledger presentation model", () => {
  it("projects every ordered command boundary without mutating prior snapshots", () => {
    const initial = createStartupLedger();
    expect(states(initial)).toEqual(["waiting", "waiting", "waiting"]);

    const runtimeActive = applyStartupProgress(initial, {
      stage: "runtime",
      state: "active",
    });
    expect(states(runtimeActive)).toEqual(["active", "waiting", "waiting"]);
    expect(runtimeActive.summary).toBe("Checking your R installation.");
    expect(states(initial)).toEqual(["waiting", "waiting", "waiting"]);

    const runtimeComplete = applyStartupProgress(runtimeActive, {
      stage: "runtime",
      state: "complete",
      r_version: "4.5.1",
    });
    expect(states(runtimeComplete)).toEqual(["complete", "waiting", "waiting"]);
    expect(startupStep(runtimeComplete, "runtime").detail).toBe("R version: 4.5.1");

    const workspaceActive = applyStartupProgress(runtimeComplete, {
      stage: "workspace",
      state: "active",
    });
    expect(states(workspaceActive)).toEqual(["complete", "active", "waiting"]);
    expect(workspaceActive.summary).toBe("Starting Workspace R.");

    const workspaceComplete = applyStartupProgress(workspaceActive, {
      stage: "workspace",
      state: "complete",
      workspace_pid: 4_212,
    });
    expect(states(workspaceComplete)).toEqual(["complete", "complete", "waiting"]);
    expect(startupStep(workspaceComplete, "workspace").detail).toContain("4212");

    const projectActive = applyStartupProgress(workspaceComplete, {
      stage: "project",
      state: "active",
    });
    expect(states(projectActive)).toEqual(["complete", "complete", "active"]);
    expect(projectActive.summary).toBe("Restoring your project.");

    const projectComplete = applyStartupProgress(projectActive, {
      stage: "project",
      state: "complete",
      project_root: "/projects/rho-analysis",
    });
    expect(states(projectComplete)).toEqual(["complete", "complete", "complete"]);
    expect(startupStep(projectComplete, "project").detail).toBe("/projects/rho-analysis");
    expect(projectComplete.summary).toBe(
      "Startup steps are complete. Confirming workspace readiness.",
    );
  });

  it("retains established facts and marks the truthful failed boundary", () => {
    const runtimeComplete = applyStartupProgress(
      applyStartupProgress(createStartupLedger(), { stage: "runtime", state: "active" }),
      { stage: "runtime", state: "complete", r_version: "4.5.1" },
    );
    const workspaceFailure = markStartupAttention(
      applyStartupProgress(runtimeComplete, { stage: "workspace", state: "active" }),
    );
    expect(states(workspaceFailure)).toEqual(["complete", "attention", "waiting"]);
    expect(startupStep(workspaceFailure, "runtime").detail).toBe("R version: 4.5.1");
    expect(workspaceFailure.summary).toBe("Workspace R needs attention.");
    expect(startupAttentionStage(workspaceFailure)).toBe("workspace");

    const runtimeFailure = markStartupAttention(
      applyStartupProgress(createStartupLedger(), { stage: "runtime", state: "active" }),
    );
    expect(states(runtimeFailure)).toEqual(["attention", "waiting", "waiting"]);

    const projectFailure = markStartupAttention(applyStartupProgress(
      throughWorkspaceComplete(),
      { stage: "project", state: "active" },
    ));
    expect(states(projectFailure)).toEqual(["complete", "complete", "attention"]);
  });

  it("rejects skipped and stale callbacks instead of manufacturing completed facts", () => {
    const initial = createStartupLedger();
    expect(applyStartupProgress(initial, {
      stage: "workspace",
      state: "active",
    })).toBe(initial);

    const runtimeComplete = applyStartupProgress(applyStartupProgress(initial, {
      stage: "runtime",
      state: "active",
    }), {
      stage: "runtime",
      state: "complete",
      r_version: "4.5.1",
    });
    expect(startupAttentionStage(runtimeComplete)).toBe("workspace");
    expect(applyStartupProgress(runtimeComplete, {
      stage: "project",
      state: "active",
    })).toBe(runtimeComplete);

    const projectActive = applyStartupProgress(throughWorkspaceComplete(), {
      stage: "project",
      state: "active",
    });
    expect(states(projectActive)).toEqual(["complete", "complete", "active"]);
    expect(applyStartupProgress(projectActive, {
      stage: "runtime",
      state: "complete",
      r_version: "stale",
    })).toBe(projectActive);
  });

  it("marks an explicitly known later failure without inventing earlier facts", () => {
    const ledger = markStartupAttention(createStartupLedger(), "project");
    expect(states(ledger)).toEqual(["waiting", "waiting", "attention"]);
    expect(startupStep(ledger, "runtime").detail).toBeNull();
    expect(startupStep(ledger, "workspace").detail).toBeNull();
  });

  it("returns a project-attention recovery to active without losing completed facts", () => {
    const attention = markStartupAttention(applyStartupProgress(
      throughWorkspaceComplete(),
      { stage: "project", state: "active" },
    ));
    const resumed = applyStartupProgress(attention, { stage: "project", state: "active" });
    expect(states(resumed)).toEqual(["complete", "complete", "active"]);
    expect(startupStep(resumed, "runtime").detail).toBe("R version: 4.5.1");
    expect(startupStep(resumed, "workspace").detail).toContain("4212");
    expect(resumed.summary).toBe("Restoring your project.");
  });

  it("resumes a sparse same-stage retry from attention before the rank guard", () => {
    const attention = markStartupAttention(createStartupLedger(), "project");
    const resumed = applyStartupProgress(attention, { stage: "project", state: "active" });

    expect(states(resumed)).toEqual(["waiting", "waiting", "active"]);
    expect(resumed.summary).toBe("Restoring your project.");
  });

  it("does not let a stale completion overwrite terminal attention copy", () => {
    const attention = markStartupAttention(applyStartupProgress(
      throughWorkspaceComplete(),
      { stage: "project", state: "active" },
    ));
    expect(applyStartupProgress(attention, {
      stage: "workspace",
      state: "complete",
      workspace_pid: 9_999,
    })).toBe(attention);
    expect(attention.summary).toBe("Project needs attention.");
  });

  it("defensively bounds custom progress facts to 512 UTF-8 bytes", () => {
    const active = applyStartupProgress(throughWorkspaceComplete(), {
      stage: "project",
      state: "active",
    });
    const ledger = applyStartupProgress(active, {
      stage: "project",
      state: "complete",
      project_root: `/${"😀".repeat(200)}`,
    });
    const detail = startupStep(ledger, "project").detail!;
    expect(new TextEncoder().encode(detail).byteLength).toBe(512);
    expect(detail).toBe(`/${"😀".repeat(127)}…`);
  });

  it("defensively normalizes isolated UTF-16 surrogates in visible facts", () => {
    const active = applyStartupProgress(throughWorkspaceComplete(), {
      stage: "project",
      state: "active",
    });
    const ledger = applyStartupProgress(active, {
      stage: "project",
      state: "complete",
      project_root: "/project/\ud800-root/\udc00",
    });
    expect(startupStep(ledger, "project").detail).toBe("/project/�-root/�");
  });
});
