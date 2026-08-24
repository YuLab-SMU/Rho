import { describe, expect, it } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { FIRST_PARTY_SURFACE_UX, humanizeSurfaceId, surfaceDisplayLabel, surfaceUxProfile } from "./surface-ux";

const EXPECTED_FIRST_PARTY = [
  "rho.agent", "rho.artifacts", "rho.check-result", "rho.console", "rho.environment",
  "rho.evidence", "rho.file-preview", "rho.file-source", "rho.git", "rho.help",
  "rho.logs", "rho.navigator", "rho.plots", "rho.problems", "rho.render-jobs",
  "rho.runs", "rho.status", "rho.surface-playground",
];

describe("Surface UX contract", () => {
  it("keeps the closed first-party inventory complete and task-specific", () => {
    expect(Object.keys(FIRST_PARTY_SURFACE_UX).sort()).toEqual(EXPECTED_FIRST_PARTY);
    for (const profile of Object.values(FIRST_PARTY_SURFACE_UX)) {
      expect(profile.label.trim()).not.toBe("");
      expect(profile.primaryTask.trim()).not.toBe("");
      expect(profile.defaultFocus.trim()).not.toBe("");
      expect(profile.emptyState.trim()).not.toBe("");
      expect(profile.actionBudget).toBeGreaterThanOrEqual(1);
      expect(profile.actionBudget).toBeLessThanOrEqual(3);
    }
  });

  it("covers every first-party factory in the generated contract", () => {
    const factoryIds = fixture.surface_runtime_snapshot.catalog.factories
      .map((factory) => factory.definition.surface_id)
      .filter((surfaceId) => surfaceId.startsWith("rho."));
    for (const surfaceId of factoryIds) expect(FIRST_PARTY_SURFACE_UX[surfaceId]).toBeDefined();
  });

  it("turns project component identifiers into human labels without hiding first-party names", () => {
    expect(humanizeSurfaceId("ui.surface.differential-expression")).toBe("Differential expression");
    expect(surfaceDisplayLabel("ui.surface.differential-expression")).toBe("Differential expression");
    expect(surfaceDisplayLabel("rho.console")).toBe("R Console");
    expect(surfaceUxProfile("project.viewer.volcano_plot")).toMatchObject({
      label: "Volcano plot",
      areaRole: "context",
      actionBudget: 2,
    });
  });
});
