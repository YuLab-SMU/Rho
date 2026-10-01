import type { PluginTestProjectObservation } from "../../sdk/plugin-protocol/index.js";
import { requestExternalNavigation } from "./plugin-external";
import type { HostRequest } from "./generated/HostRequest";
import type { SessionReply } from "./generated/SessionReply";
import type { WorkbenchInfo } from "./generated/WorkbenchInfo";
import type { WorkbenchFrame } from "./generated/WorkbenchFrame";
import type { QuerySnapshot } from "./generated/QuerySnapshot";
import type { Invocation } from "./generated/Invocation";
import type { OperationRecord } from "./generated/OperationRecord";
import type { OutboxRecord } from "./generated/OutboxRecord";
import type { ApplicationState } from "./generated/ApplicationState";
import type { JsonValue } from "./generated/serde_json/JsonValue";

import type { Diagnostic } from "./generated/Diagnostic";

interface HostHttpFailure { error?: string; diagnostic?: Diagnostic; diagnostics?: string[] }

export class HostRequestError extends Error {
  readonly status: number;
  readonly diagnostic?: Diagnostic;
  constructor(status: number, detail: HostHttpFailure | null) {
    super(detail?.diagnostic?.message ?? detail?.error ?? detail?.diagnostics?.join("\n") ?? `Host HTTP ${status}`);
    this.name = "HostRequestError"; this.status = status; this.diagnostic = detail?.diagnostic;
  }
}

/** A structured rejection correlated to the exact shared-port request. Network,
 * HTTP and malformed replies remain unconfirmed transport errors. */
export class HostPortError extends Error {
  constructor(readonly diagnostic: Diagnostic, readonly request: HostRequest) {
    super(diagnostic.message); this.name = "HostPortError";
  }
}

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
  constructor(private token: string, windowId?: string, readonly testProject?: string) {
    if (testProject !== undefined && (!/^[a-z][a-z0-9._-]{0,127}$/.test(testProject) || testProject.includes("..")))
      throw new Error("The Workbench URL contains an invalid test project identity.");
    const windowKey = testProject ? `rho-test-window:${testProject}` : "rho-window-id";
    this.windowId = windowId ?? sessionStorage.getItem(windowKey) ?? crypto.randomUUID();
    if (!windowId) sessionStorage.setItem(windowKey, this.windowId);
  }
  static fromLocation() {
    const address = new URL(location.href);
    const token = new URLSearchParams(address.hash.slice(1)).get("token");
    const requestedWindow = address.searchParams.get("window");
    const testProjects = address.searchParams.getAll("test-project");
    if (testProjects.length > 1) throw new Error("The Workbench URL contains duplicate test project selections.");
    if (requestedWindow !== null && !/^[A-Za-z0-9._:/-]{1,160}$/.test(requestedWindow))
      throw new Error("The Workbench URL contains an invalid window identity.");
    if (token) {
      sessionStorage.setItem("rho-token", token);
    }
    const client = new HostClient(token ?? sessionStorage.getItem("rho-token") ?? "", requestedWindow ?? undefined, testProjects[0]);
    sessionStorage.setItem(client.testProject ? `rho-test-window:${client.testProject}` : "rho-window-id", client.windowId);
    // Window identity is a nonsecret reference. Keeping it in the document URL
    // lets this exact window be resumed after a Host port change without choosing
    // another window's drafts. Credentials remain scoped to sessionStorage.
    address.hash = "";
    address.searchParams.set("window", client.windowId);
    history.replaceState(null, "", address.pathname + address.search);
    return client;
  }
  private assertEndpoint(path: string) {
    if (this.testProject && !["/api/info", "/api/host", "/api/plugin-view"].includes(path))
      throw new Error("This endpoint is unavailable in a disposable test workspace.");
  }
  pluginAssetUrl(connection: string, token: string, path: string) {
    const prefix = this.testProject ? `/view/plugin-test/${encodeURIComponent(this.testProject)}` : "/view/plugin";
    return `${prefix}/${encodeURIComponent(connection)}/${encodeURIComponent(token)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  openTestWorkspace(testProject: string, windowId: string, open?: () => Window | null) {
    if (this.testProject || windowId !== this.windowId || !/^[a-z][a-z0-9._-]{0,127}$/.test(testProject) || testProject.includes(".."))
      throw new Error("The test workspace does not belong to this containing window.");
    const address = new URL("/", location.href);
    address.searchParams.set("plugin-window", ""); address.searchParams.set("window", windowId);
    address.searchParams.set("test-project", testProject);
    address.hash = new URLSearchParams({ token: this.token }).toString();
    return requestExternalNavigation(address.href, open);
  }
  async testProjectObservation(project: string): Promise<PluginTestProjectObservation | undefined> {
    if (!this.testProject) return undefined;
    const snapshot = await this.port<QuerySnapshot>(project, { method: "query_snapshot", params: {
      capability: { id: "plugins.test_project", version: 1 }, arguments: { id: this.testProject },
    } }, null);
    const observation = snapshot.data as unknown as PluginTestProjectObservation | undefined;
    if (snapshot.status !== "ready" || observation?.project?.id !== this.testProject || !observation.observed_in_this_host ||
      !["ready", "failed"].includes(observation.project.state))
      throw new Error("This disposable test workspace is unavailable. Inspect its original test record.");
    return observation;
  }
  async request<T>(path: string, body?: unknown, keepalive = false): Promise<T> {
    this.assertEndpoint(path);
    if (path === "/api/plugin-view" && body !== undefined)
      body = { ...(body as object), test_project: this.testProject ?? null };
    const method = (body as WorkbenchFrame | undefined)?.frame?.request?.method;
    const reading = body === undefined || path === "/api/state/read" ||
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
      ...(keepalive ? { keepalive: true } : {}),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      throw new HostRequestError(response.status, value as HostHttpFailure | null);
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
  selectDemoProject() {
    return this.request<WorkbenchInfo>("/api/project/demo", {});
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
  async port<T>(project_root: string, request: HostRequest, testProject: string | null = this.testProject ?? null, keepalive = false): Promise<T> {
    const frame: WorkbenchFrame = {
      project_root,
      frame: { id: crypto.randomUUID(), ...(testProject ? { test_project: testProject } : {}), request: structuredClone(request) },
    };
    const reply = await this.request<SessionReply>("/api/host", frame, keepalive);
    if (!reply || typeof reply.ok !== "boolean")
      throw new Error("Invalid Host reply");
    if (!reply.ok) {
      if (reply.id === frame.frame.id && reply.diagnostic)
        throw new HostPortError(reply.diagnostic, frame.frame.request);
      throw new Error(reply.error ?? "Host result is unconfirmed");
    }
    if (!("result" in reply)) throw new Error("Invalid Host reply");
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
  subscribe(project: string, after_sequence: number) {
    return this.port<OutboxRecord[]>(project, {
      method: "subscribe",
      params: { after_sequence, limit: 100 },
    });
  }
}
