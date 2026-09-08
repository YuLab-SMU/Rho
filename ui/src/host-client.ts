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
import type { ApplicationBridgeSession } from "./generated/ApplicationBridgeSession";
import type { ApplicationBridgeRequest } from "./generated/ApplicationBridgeRequest";
import type { ApplicationBridgeReply } from "./generated/ApplicationBridgeReply";
import type { ApplicationCommandRequest } from "./generated/ApplicationCommandRequest";
import type { ApplicationCommandReceipt } from "./generated/ApplicationCommandReceipt";
import type { ApplicationExecuteRequest } from "./generated/ApplicationExecuteRequest";
import type { ApplicationExecuteReply } from "./generated/ApplicationExecuteReply";
import type { ApplicationCommandStatusArguments } from "./generated/ApplicationCommandStatusArguments";
import type { ApplicationReadDocumentArguments } from "./generated/ApplicationReadDocumentArguments";
import type { ApplicationDocumentPage } from "./generated/ApplicationDocumentPage";

export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The only transport owner. Domain owners receive narrow injected ports. */
export class HostClient {
  private reads = new Set<AbortController>();
  readonly windowId: string;
  readonly incarnation = crypto.randomUUID();
  constructor(private token: string, windowId?: string) {
    this.windowId = windowId ?? sessionStorage.getItem("rho-window-id") ?? crypto.randomUUID();
    if (!windowId) sessionStorage.setItem("rho-window-id", this.windowId);
  }
  previousBridgeSession(project: string): ApplicationBridgeSession | undefined {
    const saved = sessionStorage.getItem(`rho-application-session:${project}`);
    if (!saved) return undefined;
    try {
      const value = JSON.parse(saved) as ApplicationBridgeSession;
      return value.window?.window_id === this.windowId && typeof value.window.incarnation === "string" && typeof value.bridge_token === "string" ? value : undefined;
    } catch { return undefined; }
  }
  rememberBridgeSession(project: string, session: ApplicationBridgeSession) {
    sessionStorage.setItem(`rho-application-session:${project}`, JSON.stringify(session));
  }
  static fromLocation() {
    const address = new URL(location.href);
    const token = new URLSearchParams(address.hash.slice(1)).get("token");
    const requestedWindow = address.searchParams.get("window");
    if (requestedWindow !== null && !/^[A-Za-z0-9._:/-]{1,160}$/.test(requestedWindow))
      throw new Error("The Workbench URL contains an invalid window identity.");
    if (token) {
      sessionStorage.setItem("rho-token", token);
    }
    const client = new HostClient(token ?? sessionStorage.getItem("rho-token") ?? "", requestedWindow ?? undefined);
    sessionStorage.setItem("rho-window-id", client.windowId);
    // Window identity is a nonsecret reference. Keeping it in the document URL
    // lets this exact window be resumed after a Host port change without choosing
    // another window's drafts. Credentials remain scoped to sessionStorage.
    address.hash = "";
    address.searchParams.set("window", client.windowId);
    history.replaceState(null, "", address.pathname + address.search);
    return client;
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    const method = (body as WorkbenchFrame | undefined)?.frame?.request?.method;
    const reading = body === undefined || path === "/api/state/read" || path === "/api/r/probe" ||
      (path === "/api/host" && ["query_snapshot", "get_operation", "subscribe"].includes(method ?? ""));
    const controller = reading ? new AbortController() : undefined;
    if (controller) this.reads.add(controller);
    const timer = controller ? setTimeout(() => controller.abort(new Error("Host read timed out after 10 seconds")), 10000) : undefined;
    try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Rho-Studio-Window": this.windowId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal,
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const detail = value as { error?: string; diagnostics?: string[] } | null;
      throw new Error(
        detail?.error ??
          detail?.diagnostics?.join("\n") ??
          `Host HTTP ${response.status}`,
      );
    }
    return value as T;
    } finally {
      clearTimeout(timer);
      if (controller) this.reads.delete(controller);
    }
  }
  stopReads() {
    for (const controller of this.reads) controller.abort(new Error("Client stopped reading"));
    this.reads.clear();
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
    const reply = await this.request<SessionReply>(request.method === "application_bridge" ? "/api/application/bridge" : "/api/host", frame);
    if (!reply || typeof reply.ok !== "boolean" || !("result" in reply))
      throw new Error("Invalid Host reply");
    if (!reply.ok) throw new Error(reply.error ?? "Host result is unconfirmed");
    return reply.result as T;
  }
  query(project: string, id: string, args: unknown = {}) {
    return this.port<QuerySnapshot>(project, {
      method: "query_snapshot",
      params: { capability: { id, version: 1 }, arguments: json(args) },
    });
  }
  applicationBridge(project: string, params: ApplicationBridgeRequest) {
    return this.port<ApplicationBridgeReply>(project, { method: "application_bridge", params });
  }
  applicationControl(project: string, params: ApplicationCommandRequest) {
    return this.port<ApplicationCommandReceipt>(project, { method: "application_control", params });
  }
  applicationExecute(project: string, params: ApplicationExecuteRequest) {
    return this.port<ApplicationExecuteReply>(project, { method: "application_execute", params });
  }
  async applicationStatus(project: string, args: ApplicationCommandStatusArguments) {
    const reply = await this.query(project, "application.command_status", args);
    if (reply.status !== "ready") throw new Error(reply.notices.join("\n") || "Application command status is unavailable.");
    return reply.data as unknown as ApplicationCommandReceipt;
  }
  async applicationReadDocument(project: string, args: ApplicationReadDocumentArguments) {
    const reply = await this.query(project, "application.read_document", args);
    if (reply.status !== "ready") throw new Error(reply.notices.join("\n") || "The synchronized document is unavailable.");
    return reply.data as unknown as ApplicationDocumentPage;
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
