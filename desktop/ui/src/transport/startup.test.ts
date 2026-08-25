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
        rscript: "/usr/local/bin/Rscript",
        r_version: "4.5.1",
        aisdk_version: "1.2.0",
        provider_adapters_available: true,
        provider_health: "ready",
        dependencies: [],
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
  it("owns exact bootstrap, picker and workspace-start commands", async () => {
    const calls: string[] = [];
    const startup = readyStartup();
    const workspace = readyWorkspace();
    const transport = createTauriStartupTransport(async <T,>(command: string): Promise<T> => {
      calls.push(command);
      return (command === "workspace_start" ? workspace : startup) as T;
    });

    await expect(transport.bootstrapStartup()).resolves.toStrictEqual(startup);
    await expect(transport.chooseRscript()).resolves.toStrictEqual(startup);
    await expect(transport.startWorkspace()).resolves.toStrictEqual(workspace);
    expect(calls).toEqual([
      "startup_bootstrap",
      "startup_choose_rscript",
      "workspace_start",
    ]);
  });
});
