import type { OperationCommands, QueryPort, RequestContext, RuntimeTarget } from "./shared/ports";
import type { WorkspaceInstance } from "./generated/WorkspaceInstance";
import type { RunSource } from "./generated/RunSource";

/** Project-scoped observations and the existing Operation owner are the only I/O. */
export interface RuntimeSessionsPorts {
  context(): RequestContext;
  query: QueryPort;
  commands: Pick<OperationCommands, "invoke">;
  changed(): void;
  schedule(): void;
  instanceObserved?(previous: WorkspaceInstance | null, current: WorkspaceInstance): void;
  selectionChanged?(id: string | null): void;
}

/** Capture before awaiting a save, admission or transport acknowledgement. */
export type { RuntimeTarget } from "./shared/ports";

/** Composition owns model lifetimes; each registered model retains its own scientific state. */
export class RuntimeOwnerRegistry<T> implements Iterable<[string, T]> {
  private owners = new Map<string, T>();
  get(id: string) { return this.owners.get(id); }
  register(id: string, owner: T) {
    if (this.owners.has(id)) throw new Error(`R session owners already registered: ${id}`);
    this.owners.set(id, owner);
  }
  release(id: string) { this.owners.delete(id); }
  values() { return this.owners.values(); }
  [Symbol.iterator]() { return this.owners[Symbol.iterator](); }
}

/** Historical artifact readers deliberately retain their original Operation identity. */
export const nativeWorkspaceCapabilities: ReadonlySet<string> = new Set([
  "workspace.runtime_status", "workspace.console_state", "workspace.snapshot", "workspace.inspect_object", "workspace.list_objects",
  "workspace.observe_object", "workspace.read_object", "workspace.package_index", "workspace.packages", "workspace.check_code",
  "workspace.help", "workspace.run_r", "workspace.format", "workspace.lint", "workspace.pause_queue", "workspace.resume_queue",
  "workspace.checkpoints", "workspace.checkpoint_capture", "workspace.checkpoint_restore", "workspace.checkpoint_pin", "workspace.checkpoint_delete", "workspace.checkpoint_reconcile",
]);

export function workspaceArguments(workspaceInstanceId: string, args: unknown = {}): Record<string, unknown> {
  if (!workspaceInstanceId || /[\u0000-\u001f]/.test(workspaceInstanceId)) throw new Error("An explicit R session is required");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Workspace arguments must be an object");
  const supplied = (args as Record<string, unknown>).workspace_instance_id;
  if (supplied !== undefined && supplied !== workspaceInstanceId) throw new Error("The request targets a different R session");
  return { ...args, workspace_instance_id: workspaceInstanceId };
}

/** Fixed-instance adapters never follow a later selector change. */
export function workspaceQuery(workspaceInstanceId: string, query: QueryPort): QueryPort {
  return (project, capability, args) => query(project, capability,
    nativeWorkspaceCapabilities.has(capability) ? workspaceArguments(workspaceInstanceId, args) : args);
}

export function workspaceCommands(workspaceInstanceId: string, commands: Pick<OperationCommands, "invoke">): Pick<OperationCommands, "invoke"> {
  return { invoke: (capability, args, preconditions) => commands.invoke(capability,
    nativeWorkspaceCapabilities.has(capability) ? workspaceArguments(workspaceInstanceId, args) : args, preconditions) };
}

export function runInWorkspace(target: RuntimeTarget, commands: Pick<OperationCommands, "invoke">, code: string, source: RunSource) {
  if (!code.trim()) throw new Error("R code is empty. Your input is retained.");
  if (code.includes("\0")) throw new Error("R code cannot contain NUL.");
  if (!target.nativeSessionId) throw new Error("R is unavailable. Your input is retained.");
  return commands.invoke("workspace.run_r", workspaceArguments(target.workspaceInstanceId, { code, output_mode: "console", source }),
    [{ kind: "workspace.session", subject: "active", expected: target.nativeSessionId }]);
}
