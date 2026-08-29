import { describe, expect, it } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import {
  COMPOSE_FLOW_STAGES,
  FIRST_PARTY_SURFACE_CATALOG,
  FIRST_PARTY_SURFACE_UX,
  compareSurfaceCatalogOrder,
  humanizeSurfaceId,
  surfaceCatalogPolicy,
  surfaceDisplayLabel,
  surfaceUxProfile,
} from "./surface-ux";

const EXPECTED_FIRST_PARTY = [
  "rho.agent", "rho.check-result", "rho.console", "rho.environment",
  "rho.evidence", "rho.file-preview", "rho.file-source", "rho.git", "rho.help",
  "rho.logs", "rho.navigator", "rho.plots", "rho.problems", "rho.render-jobs",
  "rho.runs", "rho.settings", "rho.status", "rho.surface-playground",
];

describe("Surface UX contract", () => {
  it("keeps the closed first-party inventory complete and task-specific", () => {
    expect(Object.keys(FIRST_PARTY_SURFACE_UX).sort()).toEqual(EXPECTED_FIRST_PARTY);
    expect(Object.keys(FIRST_PARTY_SURFACE_CATALOG).sort()).toEqual(EXPECTED_FIRST_PARTY);
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

  it("keeps only eight stable workbench components in the primary catalog", () => {
    const primary = EXPECTED_FIRST_PARTY.filter(
      (surfaceId) => surfaceCatalogPolicy(surfaceId).visibility === "primary",
    );
    expect(primary).toEqual([
      "rho.agent", "rho.console", "rho.environment", "rho.file-source", "rho.git",
      "rho.navigator", "rho.plots", "rho.runs",
    ]);
    expect(surfaceCatalogPolicy("rho.check-result")).toMatchObject({
      visibility: "contextual",
      capabilityGroup: "results",
      flowStage: "results",
    });
    expect(surfaceCatalogPolicy("rho.problems").visibility).toBe("contextual");
    expect(surfaceCatalogPolicy("rho.surface-playground").visibility).toBe("developer");
    expect(surfaceCatalogPolicy("ui.surface.volcano")).toMatchObject({
      visibility: "primary",
      capabilityGroup: "project_extension",
      flowStage: "project",
    });
  });

  it("fixes the information flow and handoff order for the whole primary workbench", () => {
    const primary = EXPECTED_FIRST_PARTY
      .filter((surfaceId) => surfaceCatalogPolicy(surfaceId).visibility === "primary")
      .sort(compareSurfaceCatalogOrder);
    expect(primary).toEqual([
      "rho.navigator",
      "rho.file-source",
      "rho.console",
      "rho.plots",
      "rho.runs",
      "rho.agent",
      "rho.environment",
      "rho.git",
    ]);
    expect(Object.keys(COMPOSE_FLOW_STAGES)).toEqual([
      "work", "run", "results", "collaborate", "project",
    ]);
    const orders = primary.map((surfaceId) => surfaceCatalogPolicy(surfaceId).composeOrder);
    expect(new Set(orders).size).toBe(orders.length);
    for (const policy of Object.values(FIRST_PARTY_SURFACE_CATALOG)) {
      for (const target of policy.handoffTargets) {
        expect(FIRST_PARTY_SURFACE_CATALOG[target]).toBeDefined();
      }
    }
    expect(surfaceCatalogPolicy("rho.console").handoffTargets).toEqual([
      "rho.plots", "rho.runs",
    ]);
    expect(surfaceCatalogPolicy("rho.agent").handoffTargets).toEqual([
      "rho.file-source", "rho.console", "rho.plots", "rho.runs",
    ]);
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
