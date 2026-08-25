import { describe, expect, it } from "vitest";

import { createTauriGitReadTransport } from "./git";

describe("Git generated read transport", () => {
  it("owns exact status and bounded-log commands", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriGitReadTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return (command === "git_status"
          ? {
              is_repo: true,
              branch: "main",
              dirty: false,
              ahead: 0,
              behind: 0,
              untracked: 0,
              modified: 0,
              staged: 0,
            }
          : []) as T;
      },
    );

    await expect(transport.status()).resolves.toMatchObject({ is_repo: true, branch: "main" });
    await expect(transport.log(30)).resolves.toEqual([]);
    expect(calls).toEqual([
      { command: "git_status" },
      { command: "git_log", args: { limit: 30 } },
    ]);
  });
});
