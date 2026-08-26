import { describe, expect, it } from "vitest";

import {
  artifactStudioTarget,
  checkNeedsCoverageWarning,
  evidenceStudioTarget,
  plotStudioTarget,
  verificationFocusKey,
} from "./verification-model";
import {
  makeArtifact,
  makeCheck,
  makeEvidence,
  makeFocus,
  makePlot,
  makeReference,
} from "./verification-test-fixtures";

describe("verification projection model", () => {
  it("keys async work by project, revision, epoch, Page and exact references", () => {
    const focus = makeFocus([makeReference("artifact", "artifact-a", "DE table")]);
    expect(verificationFocusKey({ ...focus, projectRevision: 13 }))
      .not.toBe(verificationFocusKey(focus));
    expect(verificationFocusKey({ ...focus, epoch: 4 }))
      .not.toBe(verificationFocusKey(focus));
    expect(verificationFocusKey({ ...focus, projectId: "/projects/other" }))
      .not.toBe(verificationFocusKey(focus));
    expect(verificationFocusKey({ ...focus, projectRoot: "/projects/other" }))
      .not.toBe(verificationFocusKey(focus));
    expect(verificationFocusKey({
      ...focus,
      references: [makeReference("artifact", "artifact-b", "QC table")],
    })).not.toBe(verificationFocusKey(focus));
  });

  it("treats incomplete Check coverage as attention without assigning scientific meaning", () => {
    expect(checkNeedsCoverageWarning(makeCheck())).toBe(false);
    expect(checkNeedsCoverageWarning(makeCheck({
      status: "incomplete",
      limitations: ["One file exceeded the snapshot budget."],
    }))).toBe(true);
    expect(checkNeedsCoverageWarning(makeCheck({
      coverage: {
        files_scanned: 8,
        files_skipped: 1,
        core_rules: 12,
        plugin_rule_packs: 1,
        plugin_rule_failures: 0,
      },
    }))).toBe(true);
  });

  it("derives Studio targets only from exact owning identities", () => {
    expect(artifactStudioTarget(makeArtifact())).toEqual({
      kind: "artifact",
      id: "artifact-differential-expression",
    });
    expect(plotStudioTarget(makePlot())).toEqual({ kind: "run", id: "run-18" });
    expect(evidenceStudioTarget(makeEvidence())).toEqual({
      kind: "artifact",
      id: "artifact-differential-expression",
    });
    expect(evidenceStudioTarget(makeEvidence({ artifact_id: null }))).toBeNull();
  });
});
