import { expect, it, vi } from "vitest";
import { runInWorkspace, workspaceArguments, workspaceCommands, workspaceQuery } from "../src/runtime-ports";
import type { OperationRecord } from "../src/generated/OperationRecord";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";

it("fixed-instance reads preserve native preconditions without mutating arguments", async () => {
  const query = vi.fn(async () => ({}) as QuerySnapshot), bound = workspaceQuery("scratch", query);
  const args = Object.freeze({ expected_session: "r-scratch", object_ref: "ref-1" });
  await bound("/study", "workspace.read_object", args);
  expect(query).toHaveBeenCalledWith("/study", "workspace.read_object", { ...args, workspace_instance_id: "scratch" });
  expect(args).not.toHaveProperty("workspace_instance_id");
  await bound("/study", "operation.list_recent", { limit: 5 });
  expect(query).toHaveBeenLastCalledWith("/study", "operation.list_recent", { limit: 5 });
  await bound("/study", "workspace.list_outputs", { operation_id: "original-run" });
  expect(query).toHaveBeenLastCalledWith("/study", "workspace.list_outputs", { operation_id: "original-run" });
});

it("rejects conflicting instance arguments before dispatch", () => {
  const query = vi.fn(), bound = workspaceQuery("scratch", query);
  expect(() => bound("/study", "workspace.console_state", { workspace_instance_id: "main" })).toThrow("different R session");
  expect(query).not.toHaveBeenCalled();
  expect(() => workspaceArguments("", {})).toThrow("explicit");
  expect(() => workspaceArguments("main", [])).toThrow("object");
});

it("queue controls bind their instance and keep the original native session", async () => {
  const invoke = vi.fn(async () => ({}) as OperationRecord), commands = workspaceCommands("scratch", { invoke });
  await commands.invoke("workspace.resume_queue", { session_id: "r-scratch", pause_id: "pause-1" });
  expect(invoke).toHaveBeenCalledWith("workspace.resume_queue", { session_id: "r-scratch", pause_id: "pause-1", workspace_instance_id: "scratch" }, undefined);
});

it("run submission captures explicit instance and native precondition once", async () => {
  const record = {} as OperationRecord, invoke = vi.fn(async () => record);
  const target = Object.freeze({ workspaceInstanceId: "scratch", nativeSessionId: "r-scratch", continuationLineageId: "lineage-1" });
  const source = { view_id: "document-1", label: "analysis.R", kind: "file" as const };
  expect(await runInWorkspace(target, { invoke }, "x <- 42", source)).toBe(record);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("workspace.run_r", { workspace_instance_id: "scratch", code: "x <- 42", output_mode: "console", source },
    [{ kind: "workspace.session", subject: "active", expected: "r-scratch" }]);
  expect(() => runInWorkspace(target, { invoke }, " ", source)).toThrow("empty");
  expect(() => runInWorkspace(target, { invoke }, "a\0b", source)).toThrow("NUL");
});
