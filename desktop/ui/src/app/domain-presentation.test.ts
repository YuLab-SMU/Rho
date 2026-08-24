import { describe, expect, it } from "vitest";

import type { DomainSurfaceItem } from "../transport";
import {
  domainItemPresentation,
  domainItemsForMode,
  domainMatches,
  domainPresentationKind,
  domainSummary,
} from "./domain-presentation";

const run: DomainSurfaceItem = {
  id: "run:private-id",
  title: "workspace.execute",
  subtitle: "analysis.R",
  status: "failed",
  detail: JSON.stringify({
    run_id: "private-id", project_root: "/private/project", workspace_id: "workspace-secret",
    source_path: "analysis.R", request_type: "workspace.execute", started_at: "2026-08-22T10:00:00Z",
    code_preview: "plot(x)", error_message: "object 'x' not found",
  }),
};

describe("domain Surface presentation", () => {
  it("assigns distinct jobs to domain Surface families", () => {
    expect(domainPresentationKind("rho.runs")).toBe("timeline");
    expect(domainPresentationKind("rho.artifacts")).toBe("outputs");
    expect(domainPresentationKind("rho.problems")).toBe("stream");
    expect(domainPresentationKind("rho.evidence")).toBe("claims");
    expect(domainPresentationKind("rho.git")).toBe("git");
    expect(domainPresentationKind("rho.help")).toBe("help");
  });

  it("projects useful run facts while excluding internal ownership fields", () => {
    const projected = domainItemPresentation("rho.runs", run);
    expect(projected.title).toBe("analysis.R");
    expect(projected.code).toBe("plot(x)");
    expect(projected.description).toBe("object 'x' not found");
    expect(projected.meta).toEqual(["Source editor", "2026-08-22 10:00"]);
    expect(JSON.stringify(projected)).not.toContain("/private/project");
    expect(JSON.stringify(projected)).not.toContain("workspace-secret");
    expect(domainSummary("rho.runs", [run]).title).toBe("1 execution needs attention");
    expect(domainMatches("rho.runs", run, "analysis.R")).toBe(true);
    expect(domainMatches("rho.runs", run, "private/project")).toBe(false);
  });

  it("keeps system probes out of the default scientific run history", () => {
    const probe: DomainSurfaceItem = {
      id: "run:probe",
      title: "workspace.list_installed_packages",
      subtitle: null,
      status: "completed",
      detail: "{\"origin\":\"system\",\"operation_class\":\"probe\",\"request_type\":\"workspace.list_installed_packages\"}",
    };
    expect(domainItemsForMode("rho.runs", "history", [probe, run])).toEqual([run]);
  });

  it("keeps pure comment and whitespace submissions out of History", () => {
    const comment: DomainSurfaceItem = {
      id: "run:comment",
      title: "workspace.execute",
      subtitle: "analysis.R",
      status: "completed",
      detail: "{\"origin\":\"user\",\"source_path\":\"analysis.R\",\"code_preview\":\"  # note\\n\\t\"}",
    };
    expect(domainItemsForMode("rho.runs", "history", [comment, run])).toEqual([run]);
  });

  it("separates Git working tree from history without inventing actions", () => {
    const status: DomainSurfaceItem = { id: "rho.git:1", title: "main", subtitle: null, status: null, detail: "{\"dirty\":true,\"modified\":2,\"staged\":1,\"untracked\":0}" };
    const commit: DomainSurfaceItem = { id: "abc12345", title: "Refine plot", subtitle: "Ada", status: null, detail: "{\"hash\":\"abc12345\",\"author\":\"Ada\",\"date\":\"2026-08-22\"}" };
    expect(domainItemsForMode("rho.git", "changes", [status, commit])).toEqual([status]);
    expect(domainItemsForMode("rho.git", "history", [status, commit])).toEqual([commit]);
    expect(domainItemPresentation("rho.git", status)).toMatchObject({
      status: "changed",
      description: "1 staged · 2 modified · 0 untracked",
    });
  });

  it("allows only task-specific diagnostic and build disclosures", () => {
    const log: DomainSurfaceItem = { id: "log", title: "Startup diagnostics", subtitle: null, status: "current", detail: "{\"detail\":\"Ark ready\\nR ready\",\"project_root\":\"/private\"}" };
    const help: DomainSurfaceItem = { id: "rho.build", title: "Rho 0.4.1", subtitle: null, status: "current", detail: "{\"summary\":\"Exact build identity\",\"detail\":\"Commit: abc\\nPlatform: macOS\",\"executable_path\":\"/private/bin\"}" };
    expect(domainItemPresentation("rho.logs", log)).toMatchObject({ disclosureLabel: "Open diagnostic text", disclosureText: "Ark ready\nR ready" });
    expect(domainItemPresentation("rho.help", help)).toMatchObject({ description: "Exact build identity", disclosureLabel: "Build details" });
    expect(JSON.stringify(domainItemPresentation("rho.help", help))).not.toContain("/private/bin");
  });
});
