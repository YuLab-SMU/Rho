import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ControlledPatchCard,
  type ControlledPatchProjection,
} from "../app/agent/ControlledPatchCard";

function patch(state: ControlledPatchProjection["state"]): ControlledPatchProjection {
  return {
    patch_id: "patch_controlled",
    base_project_revision: 4,
    paths: ["R/analysis.R", ".Rprofile"],
    creates: 1,
    replaces: 1,
    deletes: 0,
    renames: 0,
    staged_bytes: 128,
    high_risk_warnings: ["startup_profile:.Rprofile"],
    sandbox_scope: "/workspace:ro,/scratch:rw,/staging:rw,authoritative-project:none",
    state,
    resulting_project_revision: state === "committed" ? 5 : null,
    reobserve_required: state === "committed",
  };
}

describe("controlled external mutation UX", () => {
  it("shows exact diff summary, sandbox scope, paths, and high-risk warning", () => {
    const markup = renderToStaticMarkup(<ControlledPatchCard patch={patch("approval_required")} />);
    expect(markup).toContain("Base project revision");
    expect(markup).toContain("+1 ~1 −0 ↪0");
    expect(markup).toContain("/workspace:ro,/scratch:rw,/staging:rw,authoritative-project:none");
    expect(markup).toContain("R/analysis.R");
    expect(markup).toContain("High-risk path: startup_profile:.Rprofile");
  });

  it("reports partial outcome as reconcile, never all success", () => {
    const markup = renderToStaticMarkup(
      <ControlledPatchCard patch={patch("reconcile_required")} />,
    );
    expect(markup).toContain("reconciliation");
    expect(markup).toContain("all-success is not reported");
  });

  it("requires re-observation after committed revision", () => {
    const markup = renderToStaticMarkup(<ControlledPatchCard patch={patch("committed")} />);
    expect(markup).toContain("Project revision 5");
    expect(markup).toContain("must re-observe before another effect");
  });
});
