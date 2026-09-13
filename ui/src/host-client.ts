import type { HostRequest } from "./generated/HostRequest";
import type { SessionReply } from "./generated/SessionReply";
import type { WorkbenchInfo } from "./generated/WorkbenchInfo";
import type { WorkbenchAgentConnection } from "./generated/WorkbenchAgentConnection";
import type { LocalAgent } from "./generated/LocalAgent";
import type { SetupAgent } from "./generated/SetupAgent";
import type { DiscoverAgent } from "./generated/DiscoverAgent";
import type { AgentConfigurationFormat } from "./agent-ports";
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
import type { AgentTasksQuery } from "./generated/AgentTasksQuery";
import type { AgentTaskQueryResult } from "./generated/AgentTaskQueryResult";
import type { AgentTasksCommand } from "./generated/AgentTasksCommand";
import type { AgentTaskCommandResult } from "./generated/AgentTaskCommandResult";
import type { TestAgent } from "./generated/TestAgent";
import type { AgentDiagnostic } from "./generated/AgentDiagnostic";
import type { ReadAgentAsset } from "./generated/ReadAgentAsset";
import type { ComponentQueryReplies, ComponentCommandReplies } from "./component-agent-ports";
import type { ComponentAgentQuery } from "./generated/ComponentAgentQuery";
import type { ComponentAgentCommand } from "./generated/ComponentAgentCommand";
import type { ComponentAgentsQuery } from "./generated/ComponentAgentsQuery";
import type { ComponentAgentsCommand } from "./generated/ComponentAgentsCommand";
import type { ComponentSourcePreviewRequest } from "./generated/ComponentSourcePreviewRequest";
import type { ComponentSourcePreview } from "./generated/ComponentSourcePreview";
import type { ComponentSourceSearch } from "./generated/ComponentSourceSearch";
import type { ComponentSourceSearchResult } from "./generated/ComponentSourceSearchResult";
import type { ComponentSessionCredential } from "./generated/ComponentSessionCredential";
import type { ComponentCredentialRef } from "./generated/ComponentCredentialRef";
import type { ComponentModelTestRequest } from "./generated/ComponentModelTestRequest";
import type { ComponentModelDiagnostic } from "./generated/ComponentModelDiagnostic";

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
    const reading = body === undefined || path === "/api/state/read" || path === "/api/r/probe" || path === "/api/agents/tasks/query" ||
      ["/api/agents/components/query", "/api/agents/components/context", "/api/agents/components/context/search"].includes(path) ||
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
      const error = new Error(
        detail?.error ??
          detail?.diagnostics?.join("\n") ??
          `Host HTTP ${response.status}`,
      );
      Object.assign(error, { status: response.status });
      throw error;
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
  agentConnection() { return this.request<WorkbenchAgentConnection>("/api/agent-connection"); }
  discoverAgent(request: DiscoverAgent) { return this.request<LocalAgent>("/api/agents/discover", request); }
  setupAgent(request: SetupAgent) { return this.request<LocalAgent>("/api/agents/setup", request); }
  agentTaskQuery(request: AgentTasksQuery) { return this.request<AgentTaskQueryResult>("/api/agents/tasks/query", request); }
  agentTaskCommand(request: AgentTasksCommand) { return this.request<AgentTaskCommandResult>("/api/agents/tasks/command", request); }
  componentQuery<Q extends ComponentAgentQuery>(request: ComponentAgentsQuery & { query: Q }) {
    return this.request<ComponentQueryReplies[Q["kind"]]>("/api/agents/components/query", request);
  }
  componentCommand<C extends ComponentAgentCommand>(request: ComponentAgentsCommand & { command: C }) {
    return this.request<ComponentCommandReplies[C["kind"]]>("/api/agents/components/command", request);
  }
  componentSourcePreview(request: ComponentSourcePreviewRequest) { return this.request<ComponentSourcePreview>("/api/agents/components/context", request); }
  componentSourceSearch(request: ComponentSourceSearch) { return this.request<ComponentSourceSearchResult>("/api/agents/components/context/search", request); }
  componentCredential(request: ComponentSessionCredential) { return this.request<{ credential: ComponentCredentialRef }>("/api/agents/components/credential", request); }
  componentModelTest(request: ComponentModelTestRequest) { return this.request<{ diagnostic: ComponentModelDiagnostic }>("/api/agents/components/test", request); }
  testAgent(request: TestAgent) { return this.request<AgentDiagnostic>("/api/agents/test", request); }
  async agentAsset(request: ReadAgentAsset) {
    const response = await fetch("/api/agents/tasks/asset", { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
    if (!response.ok) throw new Error((await response.json() as {error?: string}).error ?? "Attachment is unavailable.");
    return response.blob();
  }
  agentConfiguration(data: WorkbenchAgentConnection, format: AgentConfigurationFormat, masked: boolean) {
    const endpoint = new URL(data.endpoint);
    if (endpoint.origin !== location.origin || endpoint.pathname !== "/mcp" || endpoint.search || endpoint.hash ||
      endpoint.username || endpoint.password || !/^rho_[0-9]+$/.test(data.suggested_server_name))
      throw new Error("The connection endpoint does not belong to this Workbench.");
    const authorization = `Bearer ${masked ? "<private-workbench-token>" : this.token}`;
    if (format === "codex") return `[mcp_servers.${data.suggested_server_name}]\n` +
      `url = ${JSON.stringify(data.endpoint)}\nhttp_headers = { Authorization = ${JSON.stringify(authorization)} }\n` +
      "startup_timeout_sec = 30\ntool_timeout_sec = 90\n";
    return JSON.stringify({ transport: "streamable-http", url: data.endpoint, headers: { Authorization: authorization } }, null, 2);
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
  quitWorkbench(project_root: string) { return this.request<{ quitting: boolean }>("/api/quit", { project_root }); }
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
    if (!reply || typeof reply.ok !== "boolean")
      throw new Error("Invalid Host reply");
    if (!reply.ok) throw new Error(reply.error ?? "Host result is unconfirmed");
    if (!("result" in reply)) throw new Error("Invalid Host reply");
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
