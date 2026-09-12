import type { WorkspaceInstance } from "./generated/WorkspaceInstance";
import type { ConsoleState } from "./generated/ConsoleState";
import type { OperationRecord } from "./generated/OperationRecord";

export const copyTime = (ms: number | null | undefined) => ms == null ? "Time unavailable" :
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const rLabel = (instance: WorkspaceInstance) => instance.installation ? `R ${instance.installation.r_version} · ${instance.installation.platform}` : "R installation not yet observed";
export const environmentLabel = (instance: WorkspaceInstance) => instance.binding.environment_realization_id ? "Managed dependency environment" : "R installation libraries";
export const sessionState = (instance: WorkspaceInstance, queue?: ConsoleState | null, connected = true) =>
  !connected ? "Connection lost" : instance.state === "ready" ? queue?.input ? "Input needed" : queue?.current ? "Running" : "Ready" :
    ({ stopped: "Stopped", starting: "Opening…", stopping: "Stopping…", recovery_required: "Needs attention", failed: "Failed" }[instance.state]);
export function requireSucceeded(record: OperationRecord) {
  if (record.status !== "succeeded") throw new Error(record.error || `Operation ${record.operation.operation_id}: ${record.status}. Check the original request before trying again.`);
  return record;
}
export function coverageReason(reason: string): [string, string] {
  const known: Record<string, [string, string]> = {
    external_resource: ["Live connection or external resource", "Reconnect from code"],
    unknown_altrep_provider: ["Object storage is not supported", "Recreate from source code"],
    graph_byte_limit: ["Exceeds the capture size limit", "Save selected objects…"],
    graph_node_limit: ["Object graph is too large", "Save selected objects…"],
    graph_depth_limit: ["Object graph is too deeply nested", "Recreate from source code"],
    active_binding: ["Active binding was not evaluated", "Recreate from source code"],
    nested_active_binding: ["Contains an active binding", "Recreate from source code"],
    promise: ["Unevaluated binding", "Evaluate explicitly from your script"],
    excluded_by_policy: ["Excluded by recovery settings", "Review object selection"],
    package_environment: ["Contains a package environment", "Recreate from source code"],
    project_class_requires_reconstruction: ["Project-defined class", "Recreate its class from code"],
  };
  return known[reason] ?? [reason.replaceAll("_", " "), "Review source and technical details"];
}
