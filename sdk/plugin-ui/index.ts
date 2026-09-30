/** Public browser SDK. No React, Studio, Host credential or scientific owner. */
import type { JsonValue, CapabilityKey, PluginViewMessage, PluginViewRecord, PluginViewRequest, ResourceReference, PluginArchiveReference } from "../plugin-protocol/index.js";
import { isPluginArchiveReference } from "./archives.js";
import { ViewCloseCooperation, type ViewCloseHandler } from "./view-close.js";
import { downloadFilename } from "./download.js";
export { downloadFilename } from "./download.js";
import { externalUrl } from "./external.js";
export { externalUrl } from "./external.js";
export { ViewCloseCooperation } from "./view-close.js";
export type { ViewCloseHandler, ViewCloseSnapshot } from "./view-close.js";
export type { CapabilityKey, PluginViewRecord, PluginViewRequest } from "../plugin-protocol/index.js";
export {
  parseVisualDocument,
  createVisualNode,
  visualNodeKinds,
  visualBindingValue,
  visualConditionMatches,
  validateVisualSourcePath,
} from './visual-document.js';
export type { VisualDocument, VisualNode, VisualNodeKind, VisualCondition, VisualAction, CustomComponent } from '../plugin-protocol/index.js';
export { mountVisualDocument } from './visual-runtime.js';
export type { VisualRuntimeOptions, VisualEventContext, VisualCustomInstance, VisualCustomRegistration } from './visual-runtime.js';
export { createPollingVisualSubscription } from './visual-observations.js';
export { inspectOriginalOperation, verifyOriginalOperation, isTerminalOperation, canonicalOperationValue, sameOperationValue } from './operations.js';
export type { OperationIntent, OriginalOperationRecord } from './operations.js';
export const UI_PROTOCOL_VERSION = 1;
export const MAX_UI_MESSAGE_BYTES = 1024 * 1024;
export const MAX_UI_PENDING = 128;
function testProjectId(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(value) || value.includes(".."))
    throw new Error("Invalid disposable test project identity.");
  return value;
}
const testPortRequest = (body: PluginViewRequest) => ["query", "control", "invoke", "get_operation", "cancel"].includes(body.type);
/** A fixed child selection over the original document channel. No view-state,
 * credential, principal or project-path authority is exposed by this facade. */
export class PluginTestClient {
  constructor(private readonly send: <T>(body: PluginViewRequest) => Promise<T>) {}
  query<T = unknown>(capability: CapabilityKey, arguments_: JsonValue) { return this.send<T>({ type: "query", capability, arguments: arguments_ }); }
  control<T = unknown>(capability: CapabilityKey, arguments_: JsonValue) { return this.send<T>({ type: "control", capability, arguments: arguments_ }); }
  invoke<T = unknown>(capability: CapabilityKey, arguments_: JsonValue, options: { requestId?: string; preconditions?: JsonValue[] } = {}) {
    return this.send<T>({ type: "invoke", capability, arguments: arguments_, request_id: options.requestId ?? crypto.randomUUID(), preconditions: options.preconditions ?? [] });
  }
  operation<T = unknown>(operationId: string) { return this.send<T>({ type: "get_operation", operation_id: operationId }); }
  cancel<T = unknown>(operationId: string) { return this.send<T>({ type: "cancel", operation_id: operationId }); }
}
const isDraftFlush = (body: PluginViewRequest) =>
  (body.type === "control" && body.capability.id === "documents.stage" && body.capability.version === 1) ||
  (body.type === "invoke" && body.capability.id === "documents.save" && body.capability.version === 1);
export interface ViewInitialization {
  protocol_version: number;
  connection: string;
  view: PluginViewRecord;
  features?: string[];
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
export { operationRequestId } from './operation-identity.js';
/** One MessagePort belongs to one document lifetime. Disposing it never cancels
 * accepted Operations. Reopen the saved view through the containing shell. */
export class PluginViewClient {
  private sequence = 0;
  private responseSequence = 0;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private current: PluginViewRecord;
  private stateQueue: Promise<unknown> = Promise.resolve();
  private closeCooperation: ViewCloseCooperation | null = null;
  constructor(private port: MessagePort, readonly initialization: ViewInitialization) {
    this.current = structuredClone(initialization.view);
    port.onmessage = event => this.receive(event.data);
    port.onmessageerror = () => this.dispose("Invalid view response");
    port.start();
  }
  get view(): PluginViewRecord { return structuredClone(this.current); }
  async installCloseHandler(handler: ViewCloseHandler): Promise<ViewCloseCooperation> {
    if (!this.initialization.features?.includes("view_close_v1")) throw new Error("View close cooperation is unavailable in this container.");
    if (this.closeCooperation) throw new Error("This document already has a close handler.");
    const cooperation = new ViewCloseCooperation({ view: this.current.view,
      version: () => this.current.state_version, stateSettled: () => this.stateQueue,
      request: <T>(body: PluginViewRequest) => this.request<T>(body) }, handler);
    this.closeCooperation = cooperation;
    try { await cooperation.start(); return cooperation; }
    catch (error) { cooperation.dispose(); this.closeCooperation = null; throw error; }
  }
  request<T = unknown>(body: PluginViewRequest, testProject?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("View connection is closed"));
    if (testProject !== undefined) {
      try { testProjectId(testProject); } catch (error) { return Promise.reject(error); }
      if (!this.initialization.features?.includes("test_projects_v1") || !testPortRequest(body))
        return Promise.reject(new Error("Test selection is available only for ordinary Host port calls in a supporting container."));
    }
    if (this.closeCooperation?.getSnapshot().preparing && (!isDraftFlush(body) || testProject !== undefined) && ["invoke", "control", "cancel", "begin_text_copy", "finish_text_copy", "open_external_url", "open_test_workspace", "download_resource", "download_archive"].includes(body.type))
      return Promise.reject(new Error("View closure is preparing; wait before starting another action."));
    if (this.pending.size >= MAX_UI_PENDING) return Promise.reject(new Error("View request quota reached"));
    if (this.sequence >= 0xffffffff) { this.dispose("View sequence exhausted"); return Promise.reject(new Error("View sequence exhausted")); }
    const request = crypto.randomUUID();
    const message: PluginViewMessage = { protocol_version: UI_PROTOCOL_VERSION, connection: this.initialization.connection,
      view: this.current.view, sequence: this.sequence + 1, request, ...(testProject !== undefined ? { test_project: testProject } : {}), body };
    if (!boundedJson(message)) return Promise.reject(new Error("View request exceeds the message quota"));
    this.sequence++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timeout is not evidence of cancellation, rollback or native failure.
        this.dispose("View response timed out; accepted operations may still be running");
      }, body.type === "download_archive" ? 600000 : 30000);
      this.pending.set(request, { resolve: value => resolve(value as T), reject, timer });
      try { this.port.postMessage(message); } catch { this.dispose("View message could not be sent"); }
    });
  }
  query<T = unknown>(capability: CapabilityKey, arguments_: JsonValue) {
    return this.request<T>({ type: "query", capability, arguments: arguments_ });
  }
  control<T = unknown>(capability: CapabilityKey, arguments_: JsonValue) {
    return this.request<T>({ type: "control", capability, arguments: arguments_ });
  }
  invoke<T = unknown>(capability: CapabilityKey, arguments_: JsonValue, options: { requestId?: string; preconditions?: JsonValue[] } = {}) {
    return this.request<T>({ type: "invoke", capability, arguments: arguments_,
      request_id: options.requestId ?? crypto.randomUUID(), preconditions: (options.preconditions ?? []) });
  }
  operation<T = unknown>(operationId: string) { return this.request<T>({ type: "get_operation", operation_id: operationId }); }
  cancel<T = unknown>(operationId: string) { return this.request<T>({ type: "cancel", operation_id: operationId }); }
  testProject(id: string): PluginTestClient {
    const selected = testProjectId(id);
    if (!this.initialization.features?.includes("test_projects_v1")) throw new Error("Disposable test projects are unavailable in this container.");
    return new PluginTestClient(<T>(body: PluginViewRequest) => this.request<T>(body, selected));
  }
  /** Explicit Open test workspace action. The containing shell constructs the
   * private same-Host URL; resolution confirms navigation request, not loading. */
  async openTestWorkspace(id: string): Promise<void> {
    if (!this.initialization.features?.includes("test_projects_v1")) throw new Error("Disposable test projects are unavailable in this container.");
    const result = await this.request<{ navigation_requested: boolean }>({ type: "open_test_workspace", test_project: testProjectId(id) });
    if (result?.navigation_requested !== true) throw new Error("Test workspace navigation is unconfirmed.");
  }
  /** Explicit link action only. Acknowledges a new browser navigation request,
   * not remote page loading. No opener, referrer or Host credential is sent. */
  async openExternal(url: string): Promise<void> {
    if (!this.initialization.features?.includes("external_links_v1")) throw new Error("External links are unavailable in this view container.");
    const result = await this.request<{ navigation_requested: boolean }>({ type: "open_external_url", url: externalUrl(url) });
    if (result?.navigation_requested !== true) throw new Error("External navigation is unconfirmed.");
  }
  /** Call from an explicit Export action. The container verifies bounded
   * original bytes using this view's declared resources.read grant. A resolved
   * call means the browser was asked to download, not that a file was saved. */
  async downloadResource(reference: ResourceReference, filename: string): Promise<void> {
    if (!this.initialization.features?.includes("resource_download_v1")) throw new Error("Original downloads are unavailable in this view container.");
    if (!reference || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || reference.bytes > 16 * 1024 * 1024)
      throw new Error("The original resource exceeds the download limit or has an invalid size.");
    const result = await this.request<{ download_requested: boolean }>({ type: "download_resource", reference: structuredClone(reference), filename: downloadFilename(filename) });
    if (result?.download_requested !== true) throw new Error("Original download request is unconfirmed.");
  }
  /** Call from an explicit Download action after preparing an export. The
   * container checks exact archive bytes using this view's declared read grant.
   * Resolution acknowledges only the browser request, never a saved file. */
  async downloadArchive(reference: PluginArchiveReference, filename: string): Promise<void> {
    if (!this.initialization.features?.includes("archive_download_v1")) throw new Error("Archive downloads are unavailable in this view container.");
    if (!isPluginArchiveReference(reference)) throw new Error("The archive exceeds the download limit or has an invalid identity.");
    const result = await this.request<{ download_requested: boolean }>({ type: "download_archive", reference: structuredClone(reference), filename: downloadFilename(filename) });
    if (result?.download_requested !== true) throw new Error("Archive download request is unconfirmed.");
  }
  /** Invoke from an explicit Copy action. The producer runs only after the
   * containing browser reserves that gesture, allowing bounded asynchronous
   * scientific reads to finish before any clipboard content is published. */
  async copyText(source: string | (() => Promise<string>)): Promise<void> {
    if (!this.initialization.features?.includes("text_copy_v1")) throw new Error("Text copying is unavailable in this view container.");
    const reservation = await this.request<{ copy_id: string }>({ type: "begin_text_copy" });
    if (typeof reservation?.copy_id !== "string" || !reservation.copy_id) throw new Error("Text copy reservation is invalid.");
    let confirmed = false;
    try {
      const text = typeof source === "function" ? await source() : source;
      if (typeof text !== "string") throw new Error("Text copying requires a string.");
      const body: PluginViewRequest = { type: "finish_text_copy", copy_id: reservation.copy_id, text };
      if (!boundedJson(body)) throw new Error("Text copy exceeds the view message quota.");
      const result = await this.request<{ copied: boolean }>(body);
      if (result?.copied !== true) throw new Error("Clipboard completion is unconfirmed.");
      confirmed = true;
    } finally {
      // This releases only an unsubmitted reservation, including a request that
      // failed its framing quota. It never rolls back a submitted native copy.
      if (!confirmed) await this.request({ type: "cancel_text_copy", copy_id: reservation.copy_id }).catch(() => undefined);
    }
  }
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
    this.closeCooperation?.dispose();
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
      const features = Array.isArray(data.features) && data.features.length <= 16 && data.features.every((item: unknown) => typeof item === "string" && item.length <= 64) ? data.features : [];
      resolve(new PluginViewClient(event.ports[0], { protocol_version: data.protocol_version, connection: data.connection, view: data.view, features }));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Rho view connection timed out")); }, timeoutMs);
    window.addEventListener("message", listener);
    // Do not wait for load: a module can await this connection at top level.
    window.parent.postMessage({ type: "rho:view:ready", protocol_version: UI_PROTOCOL_VERSION, nonce }, "*");
  });
}

export { readResource, isResourceReference, sameResource, DEFAULT_RESOURCE_VIEW_BYTES } from "./resources.js";
export type { ResourceReference, ResourceReader } from "./resources.js";
export { captureDraftContent, stageDraftContent, readDraft, isDraftContent, isDocumentDraft, MAX_DRAFT_BYTES, DRAFT_CHUNK_BYTES } from "./drafts.js";
export type { CapturedDraftContent, DraftReader, DraftWriter, DocumentDraft, DraftContent } from "./drafts.js";
export { capturePluginArchive, stagePluginArchive, readPluginArchive, isPluginArchiveReference, samePluginArchive, ARCHIVE_CHUNK_BYTES, MAX_PLUGIN_ARCHIVE_BYTES } from "./archives.js";
export type { CapturedPluginArchive, ArchiveReader, ArchiveWriter, PluginArchiveReference, PluginArchiveProgress } from "./archives.js";
