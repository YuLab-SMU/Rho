import { describe, expect, it } from "vitest";

import {
  createTauriProjectCommands,
  createTauriProjectTransport,
  normalizeProjectSwitchResponse,
  type ProjectSwitchResponse,
  type ProjectTransport,
} from "./project";
import type { ProjectRestoreResponse } from "./generated/project";
import { createMockUiKernelTransport } from "./mock";

const readyResponse = {
  status: "ready",
  project: {
    root: "/projects/fixture",
    files: [{
      path: "analysis.R",
      name: "analysis.R",
      kind: "file",
      size_bytes: 128,
    }],
    truncated: false,
  },
  session: {
    open_documents: [{
      path: "analysis.R",
      cursor_start: 4,
      cursor_end: 9,
      draft_content: "value <- 1",
    }],
    closed_documents: [],
    active_document: "analysis.R",
    selected_agent_conversation_id: "conversation:fixture",
    panels: { left: 240, right: null, dock: 320 },
  },
  unavailable: null,
  blocker: null,
  reason_code: null,
  message: null,
  restored_root: null,
  restart_required: false,
} as const satisfies ProjectRestoreResponse;

describe("Project transition generated transport", () => {
  it("owns exact path, picker, and startup restore commands", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const commands = createTauriProjectCommands(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return readyResponse as T;
      },
    );
    const transport = createTauriProjectTransport(commands);

    await expect(transport.openProject("/projects/fixture")).resolves.toStrictEqual(readyResponse);
    await expect(transport.pickProjectDirectory()).resolves.toStrictEqual(readyResponse);
    await expect(commands.projectRestoreSession()).resolves.toStrictEqual(readyResponse);
    expect(calls).toEqual([
      { command: "project_open", args: { path: "/projects/fixture" } },
      { command: "project_pick_directory" },
      { command: "project_restore_session" },
    ]);
  });

  it("preserves complete blocker identity and fails closed on unknown statuses", () => {
    const blocked = normalizeProjectSwitchResponse({
      ...readyResponse,
      status: "blocked",
      project: null,
      blocker: {
        kind: "agent_file_mutation",
        message: "Finish the pending file mutation.",
        pending_count: 1,
        run_id: null,
        turn_id: "turn:fixture",
        request_id: "request:fixture",
        operation_status: "active",
      },
    });
    expect(blocked.blocker).toMatchObject({
      kind: "agent_file_mutation",
      turn_id: "turn:fixture",
      request_id: "request:fixture",
    });
    expect(() => normalizeProjectSwitchResponse({
      ...readyResponse,
      status: "future_status",
    })).toThrow("Unsupported project transition status: future_status");
  });

  it("keeps the browser mock assignable and isolates A/B/A project truth", async () => {
    const transport: ProjectTransport = createMockUiKernelTransport();
    const first = await transport.openProject("/projects/a");
    const second = await transport.openProject("/projects/b");
    const restored = await transport.openProject("/projects/a");
    expect(first.project?.root).toBe("/projects/a");
    expect(second.project?.root).toBe("/projects/b");
    expect(restored.project?.root).toBe("/projects/a");
    const typed: ProjectSwitchResponse = restored;
    expect(typed.status).toBe("ready");
  });
});
