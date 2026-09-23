/** Public browser SDK. No React, Studio, Host credential or scientific owner. */
import type { JsonValue, CapabilityKey, PluginViewMessage, PluginViewRecord, PluginViewRequest } from "../plugin-protocol/index.js";
export type { CapabilityKey, PluginViewRecord, PluginViewRequest } from "../plugin-protocol/index.js";
export const UI_PROTOCOL_VERSION = 1;
export const MAX_UI_MESSAGE_BYTES = 1024 * 1024;
export const MAX_UI_PENDING = 128;
export interface ViewInitialization {
  protocol_version: number;
  connection: string;
  view: PluginViewRecord;
}
export interface ViewReply {
  protocol_version: number;
  connection: string;
  view: string;
  sequence: number;
  request: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  diagnostic?: unknown;
}
export class ViewRequestError extends Error {
  constructor(message: string, readonly diagnostic?: unknown) { super(message); this.name = "ViewRequestError"; }
}
export function boundedJson(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_UI_MESSAGE_BYTES; }
  catch { return false; }
}
/** One MessagePort belongs to one document lifetime. Disposing it never cancels
 * accepted Operations. Reopen the saved view through the containing shell. */
export class PluginViewClient {
  private sequence = 0;
  private responseSequence = 0;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private current: PluginViewRecord;
  private stateQueue: Promise<unknown> = Promise.resolve();
  constructor(private port: MessagePort, readonly initialization: ViewInitialization) {
    this.current = structuredClone(initialization.view);
    port.onmessage = event => this.receive(event.data);
    port.onmessageerror = () => this.dispose("Invalid view response");
    port.start();
  }
  get view(): PluginViewRecord { return structuredClone(this.current); }
  request<T = unknown>(body: PluginViewRequest): Promise<T> {
    if (this.closed) return Promise.reject(new Error("View connection is closed"));
    if (this.pending.size >= MAX_UI_PENDING) return Promise.reject(new Error("View request quota reached"));
    if (this.sequence >= 0xffffffff) { this.dispose("View sequence exhausted"); return Promise.reject(new Error("View sequence exhausted")); }
    const request = crypto.randomUUID();
    const message: PluginViewMessage = { protocol_version: UI_PROTOCOL_VERSION, connection: this.initialization.connection,
      view: this.current.view, sequence: this.sequence + 1, request, body };
    if (!boundedJson(message)) return Promise.reject(new Error("View request exceeds the message quota"));
    this.sequence++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timeout is not evidence of cancellation, rollback or native failure.
        this.dispose("View response timed out; accepted operations may still be running");
      }, 30000);
      this.pending.set(request, { resolve: value => resolve(value as T), reject, timer });
      try { this.port.postMessage(message); } catch { this.dispose("View message could not be sent"); }
    });
  }
  query<T = unknown>(capability: CapabilityKey, arguments_: JsonValue) {
    return this.request<T>({ type: "query", capability, arguments: arguments_ });
  }
  invoke<T = unknown>(capability: CapabilityKey, arguments_: JsonValue, options: { requestId?: string; preconditions?: JsonValue[] } = {}) {
    return this.request<T>({ type: "invoke", capability, arguments: arguments_,
      request_id: options.requestId ?? crypto.randomUUID(), preconditions: (options.preconditions ?? []) });
  }
  operation<T = unknown>(operationId: string) { return this.request<T>({ type: "get_operation", operation_id: operationId }); }
  cancel<T = unknown>(operationId: string) { return this.request<T>({ type: "cancel", operation_id: operationId }); }
  setState(state: JsonValue): Promise<PluginViewRecord> {
    const captured = structuredClone(state);
    const task = this.stateQueue.then(async () => {
      const result = await this.request<{ status: string; output?: PluginViewRecord; error?: unknown }>({ type: "set_state", expected_version: this.current.state_version, state: captured });
      if (result.status !== "succeeded" || !result.output) throw new Error("View state was not saved; inspect its Operation before retrying");
      this.current = structuredClone(result.output);
      return this.view;
    });
    this.stateQueue = task.catch(() => undefined);
    return task;
  }
  dispose(reason = "View connection closed") {
    if (this.closed) return;
    this.closed = true;
    this.port.close();
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error(reason)); }
    this.pending.clear();
  }
  private receive(value: unknown) {
    const reply = value as Partial<ViewReply> | null;
    if (!reply || !boundedJson(reply) || reply.protocol_version !== UI_PROTOCOL_VERSION || reply.connection !== this.initialization.connection ||
      reply.view !== this.current.view || reply.sequence !== this.responseSequence + 1 || typeof reply.request !== "string" || typeof reply.ok !== "boolean") {
      this.dispose("View response identity or sequence is invalid"); return;
    }
    const pending = this.pending.get(reply.request);
    if (!pending) { this.dispose("View response has no pending request"); return; }
    this.responseSequence++;
    this.pending.delete(reply.request); clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.result); else pending.reject(new ViewRequestError(reply.error ?? "View request failed", reply.diagnostic));
  }
}
/** The nonce is scoped to this iframe document, not a Host bearer. An unrelated
 * window, a stale document, or a second bootstrap cannot replace this channel. */
export function connectPluginView(timeoutMs = 15000): Promise<PluginViewClient> {
  const nonce = new URLSearchParams(location.hash.slice(1)).get("rho-view-nonce");
  if (!nonce || window.parent === window) return Promise.reject(new Error("Open this view in a Rho container"));
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", listener); };
    const listener = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.type !== "rho:view:connect" || data.nonce !== nonce || !boundedJson(data) || data.protocol_version !== UI_PROTOCOL_VERSION ||
        typeof data.connection !== "string" || typeof data.view?.view !== "string" || event.ports.length !== 1) return;
      cleanup();
      resolve(new PluginViewClient(event.ports[0], { protocol_version: data.protocol_version, connection: data.connection, view: data.view }));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Rho view connection timed out")); }, timeoutMs);
    window.addEventListener("message", listener);
    // Do not wait for load: a module can await this connection at top level.
    window.parent.postMessage({ type: "rho:view:ready", protocol_version: UI_PROTOCOL_VERSION, nonce }, "*");
  });
}
