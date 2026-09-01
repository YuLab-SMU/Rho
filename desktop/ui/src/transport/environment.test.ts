import { describe, expect, it } from "vitest";

import { createTauriEnvironmentReadTransport } from "./environment";

describe("Environment generated read transport", () => {
  it("owns only typed Authority health and Workspace re-observation commands", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriEnvironmentReadTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return { status: command === "environment_health" ? "realized" : "observation_required" } as T;
      },
    );

    await expect(transport.environmentHealth()).resolves.toMatchObject({ status: "realized" });
    await expect(transport.reobserveEnvironment()).resolves.toMatchObject({ status: "observation_required" });
    expect(calls).toEqual([
      { command: "environment_health" },
      { command: "environment_reobserve" },
    ]);
  });
});
