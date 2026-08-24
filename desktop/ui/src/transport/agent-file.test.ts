import { describe, expect, it } from "vitest";

import {
  createTauriAgentFileTransport,
  type AgentFileApplyRequest,
  type AgentFileMutationResponse,
  type AgentFileTransport,
  type AgentFileUndoRequest,
} from "./agent-file";
import type {
  AgentFileMutationResponse as AgentFileMutationResponseWire,
} from "./generated/agent-file";
import { createMockUiKernelTransport } from "./mock";

const applyRequest = {
  turn_id: "agent-turn:fixture",
  proposal_event_id: 42,
  path: "analysis.R",
  expected_disk_sha256: "a".repeat(64),
  before_content: "before <- TRUE\n",
} satisfies AgentFileApplyRequest;

const undoRequest = {
  turn_id: applyRequest.turn_id,
  proposal_event_id: applyRequest.proposal_event_id,
  path: applyRequest.path,
  expected_after_sha256: "b".repeat(64),
  before_content: applyRequest.before_content,
  created: false,
} satisfies AgentFileUndoRequest;

const wireResponse = {
  status: "applied",
  path: applyRequest.path,
  content: "after <- TRUE\n",
  start: 0,
  end: 13,
  afterSha256: "b".repeat(64),
  project: {
    root: "/tmp/Project A",
    files: [{ path: applyRequest.path, name: "analysis.R", kind: "file", size_bytes: 14 }],
    truncated: false,
  },
  workspace: {
    workspace_id: "workspace:a",
    kernel_instance_id: "kernel:a",
    execution_seq: 3,
    state_revision: 5,
    project_revision: 7,
  },
} as const satisfies AgentFileMutationResponseWire;

describe("Agent file generated transport", () => {
  it("owns exact camel-case requests and normalizes the real afterSha256 response", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const transport = createTauriAgentFileTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return wireResponse as T;
      },
    );

    const applied = await transport.applyAgentFileEdit(applyRequest);
    const undone = await transport.undoAgentFileEdit(undoRequest);
    expect(calls).toEqual([
      {
        command: "apply_agent_file_edit",
        args: { request: {
          turnId: applyRequest.turn_id,
          proposalEventId: applyRequest.proposal_event_id,
          path: applyRequest.path,
          expectedDiskSha256: applyRequest.expected_disk_sha256,
          beforeContent: applyRequest.before_content,
        } },
      },
      {
        command: "undo_agent_file_edit",
        args: { request: {
          turnId: undoRequest.turn_id,
          proposalEventId: undoRequest.proposal_event_id,
          path: undoRequest.path,
          expectedAfterSha256: undoRequest.expected_after_sha256,
          beforeContent: undoRequest.before_content,
          created: false,
        } },
      },
    ]);
    for (const response of [applied, undone]) {
      expect(response.after_sha256).toBe(wireResponse.afterSha256);
      expect(response).not.toHaveProperty("afterSha256");
      expect(response.project.files[0]).toMatchObject({ path: "analysis.R", size_bytes: 14 });
      expect(response.workspace).toMatchObject({ workspace_id: "workspace:a", project_revision: 7 });
    }
  });

  it("preserves stale digest rejection", async () => {
    const transport = createTauriAgentFileTransport(async () => {
      throw new Error("The file changed after the Agent edit");
    });
    await expect(transport.undoAgentFileEdit(undoRequest)).rejects.toThrow("file changed");
  });

  it("keeps the browser mock assignable to the complete narrow facet", async () => {
    const transport: AgentFileTransport = createMockUiKernelTransport();
    const response: AgentFileMutationResponse = await transport.applyAgentFileEdit(applyRequest);
    expect(response.after_sha256).toHaveLength(64);
    expect(response.project.root).not.toBe("");
    expect(response.workspace.workspace_id).not.toBe("");
  });
});
