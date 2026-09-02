import { describe, expect, it } from "vitest";

import { createTauriStartupTransport } from "./startup";
import type { StartupView, WorkspaceStatus } from "./generated/startup";

function readyStartup(): StartupView {
  return {
    phase: "runtime_ready",
    busy: false,
    runtime: {
      rscript: "/usr/local/bin/Rscript",
      r_version: "4.5.1",
      agent_runtime: {
        available: true,
        status: "ready",
        active_agent_id: "claude-code-acp",
        active_agent_label: "Claude Code",
        protocol: "acp/1",
        executable: "/usr/local/bin/claude-code-acp",
        candidates: [{
          agent_id: "claude-code-acp",
          display_name: "Claude Code",
          status: "ready",
          protocol: "acp/1",
          executable: "/usr/local/bin/claude-code-acp",
          detail: "External ACP Agent executable discovered.",
        }],
        error: null,
      },
    },
    issue: null,
  };
}

function readyWorkspace(): WorkspaceStatus {
  return {
    status: "idle",
    r_version: "4.5.1",
    r_home: "/Library/Frameworks/R.framework/Resources",
    kernel_pid: 1234,
    workspace: { workspace_id: "workspace:fixture" },
    agent_runtime: readyStartup().runtime!.agent_runtime,
    python_required: false,
  };
}

describe("Startup generated transport", () => {
  it("owns exact bootstrap, picker, workspace-start and diagnostics commands", async () => {
    const calls: string[] = [];
    const startup = readyStartup();
    const workspace = readyWorkspace();
    const transport = createTauriStartupTransport(async <T,>(command: string): Promise<T> => {
      calls.push(command);
      return (command === "workspace_start"
        ? workspace
        : command === "startup_diagnostics"
          ? "Rho startup status"
          : startup) as T;
    });

    await expect(transport.bootstrapStartup()).resolves.toStrictEqual(startup);
    await expect(transport.chooseRscript()).resolves.toStrictEqual(startup);
    await expect(transport.startWorkspace()).resolves.toStrictEqual(workspace);
    await expect(transport.diagnostics()).resolves.toBe("Rho startup status");
    expect(calls).toEqual([
      "startup_bootstrap",
      "startup_choose_rscript",
      "workspace_start",
      "startup_diagnostics",
    ]);
  });
});
