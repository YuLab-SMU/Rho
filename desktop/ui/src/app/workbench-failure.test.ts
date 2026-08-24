import { describe, expect, it } from "vitest";

import { normalizeWorkbenchFailure, sanitizeFailureMessage } from "./workbench-failure";

describe("Workbench failure normalization", () => {
  it("keeps bounded actionable text while redacting local paths and control characters", () => {
    expect(sanitizeFailureMessage(
      "Could not read /Users/alice/private/project/analysis.R\u0000; retry.",
      "Read failed.",
    )).toBe("Could not read [local path] retry.");
  });

  it("classifies existing raw failures without requiring a backend envelope", () => {
    expect(normalizeWorkbenchFailure("Surface revision is stale.", { fallback: "Failed" }).kind).toBe("conflict");
    expect(normalizeWorkbenchFailure("Workspace R is busy.", { fallback: "Failed" }).kind).toBe("admission");
    expect(normalizeWorkbenchFailure("Runtime bridge connection failed.", { fallback: "Failed" })).toMatchObject({
      kind: "runtime_infrastructure",
      retryable: true,
    });
    expect(normalizeWorkbenchFailure("Tauri invoke channel closed.", { fallback: "Failed" }).kind).toBe("transport");
  });

  it("accepts only redaction-safe operation identifiers", () => {
    expect(normalizeWorkbenchFailure({ message: "failed", operation_id: "op:runtime-0042" }, { fallback: "Failed" }).operation_id).toBe("op:runtime-0042");
    expect(normalizeWorkbenchFailure({ message: "failed", operation_id: "/Users/alice/secret" }, { fallback: "Failed" }).operation_id).toBeNull();
  });

  it("does not relabel an explicit R evaluation outcome as infrastructure", () => {
    expect(normalizeWorkbenchFailure("object 'df' not found", {
      fallback: "R evaluation failed.",
      defaultKind: "runtime_execution",
      scope: "surface",
    })).toMatchObject({ kind: "runtime_execution", scope: "surface", retryable: false });
  });
});
