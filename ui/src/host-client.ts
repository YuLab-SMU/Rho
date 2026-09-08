import type { HostRequest } from "./generated/HostRequest";
import type { SessionReply } from "./generated/SessionReply";
import type { WorkbenchInfo } from "./generated/WorkbenchInfo";
import type { WorkbenchFrame } from "./generated/WorkbenchFrame";
import type { QuerySnapshot } from "./generated/QuerySnapshot";
import type { Invocation } from "./generated/Invocation";
import type { OperationRecord } from "./generated/OperationRecord";
import type { OutboxRecord } from "./generated/OutboxRecord";
import type { ApplicationState } from "./generated/ApplicationState";
import type { RConfiguration } from "./generated/RConfiguration";
import type { RSelection } from "./generated/RSelection";
import type { RProbe } from "./generated/RProbe";
import type { JsonValue } from "./generated/serde_json/JsonValue";

export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The only transport owner. Panels consume the shared Studio model. */
export class HostClient {
  constructor(private token: string) {}
  static fromLocation() {
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    if (token) {
      sessionStorage.setItem("rho-token", token);
      history.replaceState(null, "", location.pathname);
    }
    return new HostClient(token ?? sessionStorage.getItem("rho-token") ?? "");
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = value as { error?: string; diagnostics?: string[] } | null;
      throw new Error(
        detail?.error ??
          detail?.diagnostics?.join("\n") ??
          `Host HTTP ${response.status}`,
      );
    }
    return value as T;
  }
  info() {
    return this.request<WorkbenchInfo>("/api/info");
  }
  selectProject(project_root: string) {
    return this.request<WorkbenchInfo>("/api/project", { project_root });
  }
  rConfiguration() {
    return this.request<RConfiguration>("/api/r");
  }
  probeR(selection: RSelection) {
    return this.request<RProbe>("/api/r/probe", selection);
  }
  applyR(selection: RSelection, end_session: boolean) {
    return this.request<RConfiguration>("/api/r", { selection, end_session });
  }
  readState(project_root: string | null, key: string) {
    return this.request<ApplicationState>("/api/state/read", {
      project_root,
      key,
    });
  }
  writeState(project_root: string | null, state: ApplicationState) {
    return this.request<ApplicationState>("/api/state/write", {
      project_root,
      state,
    });
  }
  async port<T>(project_root: string, request: HostRequest): Promise<T> {
    const frame: WorkbenchFrame = {
      project_root,
      frame: { id: crypto.randomUUID(), request },
    };
    const reply = await this.request<SessionReply>("/api/host", frame);
    if (!reply.ok) throw new Error(reply.error ?? "Host result is unconfirmed");
    return reply.result as T;
  }
  query(project: string, id: string, args: unknown = {}) {
    return this.port<QuerySnapshot>(project, {
      method: "query_snapshot",
      params: { capability: { id, version: 1 }, arguments: json(args) },
    });
  }
  invoke(
    project: string,
    invocation: Invocation,
    return_after_acceptance = false,
  ) {
    return this.port<OperationRecord>(project, {
      method: "invoke",
      params: { ...invocation, return_after_acceptance },
    });
  }
  getOperation(project: string, operation_id: string) {
    return this.port<OperationRecord | null>(project, {
      method: "get_operation",
      params: { operation_id },
    });
  }
  cancel(project: string, operation_id: string, only_if_pending = false) {
    return this.port<unknown>(project, {
      method: "request_cancellation",
      params: { operation_id, only_if_pending },
    });
  }
  respondInput(
    project: string,
    params: import("./generated/RespondInput").RespondInput,
  ) {
    return this.port<{ submitted: boolean }>(project, {
      method: "respond_input",
      params,
    });
  }
  subscribe(project: string, after_sequence: number) {
    return this.port<OutboxRecord[]>(project, {
      method: "subscribe",
      params: { after_sequence, limit: 100 },
    });
  }
}
