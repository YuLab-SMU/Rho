import { describe, expect, it } from "vitest";

import { createTauriEvidenceReadTransport } from "./evidence";

describe("Evidence generated read transport", () => {
  it("owns the exact project-scoped claim list command", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriEvidenceReadTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return [] as T;
      },
    );

    await expect(transport.listEvidenceClaims(100)).resolves.toEqual([]);
    expect(calls).toEqual([
      { command: "list_evidence_claims", args: { limit: 100 } },
    ]);
  });
});
