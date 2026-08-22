import { describe, expect, it } from "vitest";

import { createMockBootstrapTransport } from "./mock";
import { normalizeProjectState, normalizeStartupView, projectLabel } from "./normalize";
import { createTauriBootstrapTransport } from "./tauri";

describe("bootstrap transport", () => {
  it("creates a deterministic ready browser snapshot", async () => {
    const transport = createMockBootstrapTransport(
      "?project=%2Ftmp%2F%E7%A7%91%E5%AD%A6%20Project&health=ready",
    );
    await expect(transport.loadBootstrap()).resolves.toEqual({
      source: "mock",
      project: { root: "/tmp/科学 Project", label: "科学 Project" },
      startup: { state: "ready", phase: "runtime_ready", title: "Local runtime ready" },
    });
  });

  it("keeps a recoverable startup issue separate from project availability", () => {
    expect(
      normalizeStartupView({
        phase: "needs_attention",
        busy: false,
        issue: { title: "Agent packages are incompatible", message: "Upgrade aisdk." },
      }),
    ).toEqual({
      state: "needs_attention",
      phase: "needs_attention",
      title: "Agent packages are incompatible",
      detail: "Upgrade aisdk.",
    });
  });

  it("normalizes Windows project labels", () => {
    expect(projectLabel("D:\\work\\Rho project")).toBe("Rho project");
  });

  it("does not trim valid project-path whitespace", () => {
    expect(normalizeProjectState({ root: "/tmp/Rho project " })).toEqual({
      root: "/tmp/Rho project ",
      label: "Rho project ",
    });
  });

  it("uses the existing Tauri commands through the shared transport shape", async () => {
    const calls: string[] = [];
    const transport = createTauriBootstrapTransport(async <T,>(command: string) => {
      calls.push(command);
      if (command === "startup_status") {
        return { phase: "runtime_ready", busy: false, runtime: {} } as T;
      }
      return { root: "/tmp/rho" } as T;
    });
    await expect(transport.loadBootstrap()).resolves.toMatchObject({
      source: "tauri",
      project: { root: "/tmp/rho" },
      startup: { state: "ready" },
    });
    expect(calls.sort()).toEqual(["project_state", "startup_status"]);
  });
});
