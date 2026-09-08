import { Model } from "./shared/model";
import { actionDocument } from "./application-ports";
import type { ApplicationBridgePorts } from "./application-ports";
import type { ApplicationBridgeSession } from "./generated/ApplicationBridgeSession";
import type { ApplicationContextState } from "./generated/ApplicationContextState";
import type { ApplicationChanges } from "./generated/ApplicationChanges";
import type { ApplicationDocument } from "./generated/ApplicationDocument";
import type { ApplicationCommandCompletion } from "./generated/ApplicationCommandCompletion";
import type { ApplicationCommandGrant } from "./generated/ApplicationCommandGrant";
import type { ApplicationCommandReceipt } from "./generated/ApplicationCommandReceipt";
import type { ApplicationExecutionStep } from "./generated/ApplicationExecutionStep";
import type { ApplicationSyncReceipt } from "./generated/ApplicationSyncReceipt";
import type { ApplicationAction } from "./generated/ApplicationAction";
import type { RequestContext } from "./shared/ports";

type LocalSnapshot = { context: ApplicationContextState; documents: ApplicationDocument[] };
type PendingSync = { id: string; changes: ApplicationChanges; snapshot: LocalSnapshot };
type PendingCompletion = { value: ApplicationCommandCompletion; snapshot: LocalSnapshot; grant: ApplicationCommandGrant; captured: string | null; uncertain: boolean };
type PendingExecution = { grant: ApplicationCommandGrant; captured: string | null; step: ApplicationExecutionStep; continueRun: boolean; saveConfirmed: boolean };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameProject = (a: RequestContext, b: RequestContext) => a.project === b.project;
const ref = (d: ApplicationDocument) => ({ document_id: d.document_id, document_version: d.version, selection_version: d.selection.version });

/** One resident bridge per window, stepped by Studio's existing coordinator.
 * Delivery, CAS synchronization and scientific acceptance each retain their own
 * identity. A transport retry cannot repeat a local module mutation.
 */
export class ApplicationBridge extends Model<{ online: boolean; initialized: boolean; error: string; receipt: ApplicationCommandReceipt | null }> {
  private session: ApplicationBridgeSession | null = null;
  private registeringSession: ApplicationBridgeSession | null = null;
  private registeredScope: RequestContext | null = null;
  private acknowledged: LocalSnapshot | null = null;
  private localContext: ApplicationContextState | null = null;
  private pendingSync: PendingSync | null = null;
  private pendingCompletion: PendingCompletion | null = null;
  private execution: PendingExecution | null = null;
  private recovery: PendingExecution | null = null;
  private claimRequestId: string | null = null;
  private inFlight: Promise<void> | null = null;
  private renewing: Promise<void> | null = null;
  private generation = 0;
  private renewedAt = 0;
  private lastSyncedAt = 0;
  private error = "";
  private lastReceipt: ApplicationCommandReceipt | null = null;
  private initialized = false;
  private restoreConflict = false;
  private stopped = false;
  constructor(private readonly ports: ApplicationBridgePorts) { super(); }
  protected readSnapshot() { return { online: !!this.session && this.ports.scope().connected && this.now() < this.renewedAt + 15000, initialized: this.initialized, error: this.error, receipt: this.lastReceipt }; }
  private now() { return this.ports.now?.() ?? Date.now(); }
  get window() { return (this.session ?? this.registeringSession)?.window ?? null; }
  get ready() { return this.initialized; }
  private snapshot(): LocalSnapshot {
    const data = this.ports.modules.context();
    const previous = this.localContext;
    if (!previous || !same({ ...previous, version: undefined }, { ...data, version: undefined }))
      this.localContext = { ...structuredClone(data), version: crypto.randomUUID() };
    return { context: structuredClone(this.localContext!), documents: structuredClone([...this.ports.modules.documents()]) };
  }
  private changes(snapshot: LocalSnapshot): ApplicationChanges {
    const previous = this.acknowledged;
    if (!previous) throw new Error("The application window has not been registered.");
    return {
      context: same(snapshot.context, previous.context) ? null : { expected_version: previous.context.version, context: snapshot.context },
      documents: snapshot.documents.filter((d) => !same(d, previous.documents.find((p) => p.document_id === d.document_id)))
        .map((document) => { const old = previous.documents.find((d) => d.document_id === document.document_id); return {
          expected_version: old?.version ?? null, expected_selection_version: old?.selection.version ?? null, document,
        }; }),
      removed_documents: previous.documents.filter((d) => !snapshot.documents.some((p) => p.document_id === d.document_id)).map(ref),
    };
  }
  private empty(changes: ApplicationChanges) { return !changes.context && !changes.documents.length && !changes.removed_documents.length; }
  private assertScope(scope: RequestContext, generation: number) {
    if (this.stopped || generation !== this.generation || !sameProject(scope, this.ports.scope())) throw new Error("The application project changed; this result was fenced.");
  }
  async start(): Promise<void> {
    this.stopped = false;
    await this.step();
  }
  step(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const scope = this.ports.scope(), generation = this.generation;
    if (this.stopped || !scope.project) return Promise.resolve();
    if (!scope.connected) { this.disconnected(); return Promise.resolve(); }
    const task = this.perform(scope, generation).catch((error) => {
      if (this.stopped || generation !== this.generation || !sameProject(scope, this.ports.scope())) return;
      this.error = message(error); this.ports.reportError(this.error);
      if (this.execution) { this.execution.continueRun = false; this.recovery = this.execution; this.execution = null; }
      if (this.pendingCompletion) this.pendingCompletion.uncertain = true;
      this.publish();
    }).finally(() => { if (this.inFlight === task) this.inFlight = null; });
    this.inFlight = task;
    return task;
  }
  private async perform(scope: RequestContext, generation: number) {
    const project = scope.project!, transport = this.ports.transport;
    const current = () => this.assertScope(scope, generation);
    if (this.restoreConflict) return;
    if (this.registeredScope && !sameProject(this.registeredScope, scope)) { this.reset(); return; }
    if (!this.session) {
      const localBefore = this.ports.modules.documents().map((d) => ({ id: d.document_id, version: d.version, selection: d.selection.version }));
      const contextBefore = structuredClone(this.ports.modules.context());
      const registration = await transport.bridge(project, { kind: "register", window_id: this.ports.identity.windowId,
        incarnation: this.ports.identity.incarnation, label: this.ports.modules.context().label,
        previous_session: this.ports.identity.previousSession ?? null });
      current();
      if (registration.kind !== "registered") throw new Error("Host did not return a bridge registration.");
      const session = registration.data.session;
      this.registeringSession = session;
      this.ports.registered(session);
      this.renewedAt = this.now();
      const restored: ApplicationDocument[] = [];
      for (const summary of registration.data.documents) {
        const read = async (content: "draft" | "base", digest: string) => {
          let offset = 0, text = "";
          do {
            const page = await transport.readDocument(project, { window: session.window, document: summary.document,
              expected_sha256: digest, content, offset_utf8: offset, limit_bytes: 65536, allow_offline: false });
            current();
            if (page.offset_utf8 !== offset || page.document.sha256 !== summary.sha256 || page.content !== content || page.content_sha256 !== digest)
              throw new Error("The synchronized draft changed while restoring.");
            text += page.text;
            if (page.next_offset_utf8 !== null && page.next_offset_utf8 <= offset) throw new Error("Document continuation did not advance.");
            offset = page.next_offset_utf8 ?? -1;
          } while (offset !== -1);
          return text;
        };
        const text = await read("draft", summary.sha256);
        const base = summary.base_text_present && summary.base_hash ? await read("base", summary.base_hash) : null;
        restored.push({ document_id: summary.document.document_id, version: summary.document.document_version, path: summary.path,
          text, base_text: base, base_hash: summary.base_hash, selection: summary.selection, readonly_reason: summary.readonly_reason });
      }
      if (restored.length && (!same(localBefore, this.ports.modules.documents().map((d) => ({ id: d.document_id, version: d.version, selection: d.selection.version }))) || !same(contextBefore, this.ports.modules.context()))) {
        this.restoreConflict = true;
        throw new Error("Local input changed while synchronized window state was being restored. Local input was retained; restoration needs explicit resolution.");
      }
      if (restored.length) this.ports.modules.restoreDocuments(restored, registration.data.context.active_document_id);
      if (registration.data.context.views.length) this.ports.modules.restoreViews(registration.data.context);
      this.session = session; this.registeredScope = scope;
      this.registeringSession = null;
      this.localContext = structuredClone(registration.data.context);
      this.acknowledged = { context: structuredClone(registration.data.context), documents: restored };
      this.initialized = true;
      this.publish();
    }
    current();
    if (this.now() - this.renewedAt >= 5000) {
      await this.heartbeat(); current();
    }
    if (this.pendingCompletion) { await this.finishCompletion(project, current); return; }
    if (this.recovery) { await this.observeRecovery(project, current); return; }
    if (this.execution) { await this.executeStep(project, current); return; }
    // Polling detects module changes without adding serialization to every input
    // callback. Sync is coalesced; a command always follows the latest completed CAS.
    if (this.pendingSync || this.now() - this.lastSyncedAt >= 400) {
      await this.sync(project, current); current();
      if (this.pendingSync) return;
    }
    if (!this.empty(this.changes(this.snapshot()))) return;
    this.claimRequestId ??= crypto.randomUUID();
    const claimed = await transport.bridge(project, { kind: "claim", session: this.session!, claim_request_id: this.claimRequestId });
    current(); if (claimed.kind !== "claimed") throw new Error("Host returned an invalid command delivery.");
    this.claimRequestId = null;
    if (!claimed.data) { this.error = ""; this.publish(); return; }
    await this.applyGrant(claimed.data, project, current);
  }
  private async sync(project: string, current: () => void) {
    if (!this.pendingSync) {
      const snapshot = this.snapshot(), changes = this.changes(snapshot);
      if (this.empty(changes)) { this.lastSyncedAt = this.now(); return; }
      this.pendingSync = { id: crypto.randomUUID(), changes, snapshot };
    }
    const pending = this.pendingSync;
    const reply = await this.ports.transport.bridge(project, { kind: "sync", session: this.session!, sync_id: pending.id, changes: pending.changes });
    current(); if (reply.kind !== "synced") throw new Error("Host did not confirm application synchronization.");
    this.acceptSync(pending.snapshot, reply.data);
    this.pendingSync = null; this.lastSyncedAt = this.now(); this.error = ""; this.publish();
  }
  private acceptSync(snapshot: LocalSnapshot, receipt: ApplicationSyncReceipt) {
    if (receipt.context_version !== snapshot.context.version || receipt.document_versions.some((r) => {
      const d = snapshot.documents.find((d) => d.document_id === r.document_id); return !d || !same(ref(d), r);
    })) throw new Error("Host synchronization receipt does not match the captured application resources.");
    this.acknowledged = snapshot;
  }
  private async applyGrant(grant: ApplicationCommandGrant, project: string, current: () => void) {
    let captured: string | null = null;
    let diagnostic: string | null = null;
    let outcome: ApplicationCommandCompletion["outcome"] = "applied";
    try {
      const expected = "expected_context_version" in grant.request.action ? grant.request.action.expected_context_version : null;
      if (expected && expected !== this.snapshot().context.version) throw new Error("The window context changed before the command was applied.");
      const document = actionDocument(grant.request.action);
      if (document) this.ports.modules.checkDocument(document);
      if (grant.capture) {
        const d = this.ports.modules.documents().find((d) => d.document_id === grant.capture!.document.document_id);
        if (!d || !same(ref(d), grant.capture.document)) throw new Error("The captured document version is no longer current.");
        captured = d.text;
      }
      await this.applyAction(grant.request.action);
      current();
    } catch (error) { outcome = "rejected"; diagnostic = message(error); }
    current();
    const snapshot = this.snapshot();
    this.pendingCompletion = { value: { request_id: grant.request.request_id, claim_id: grant.claim_id, outcome, changes: this.changes(snapshot), diagnostic }, snapshot, grant, captured, uncertain: false };
    await this.finishCompletion(project, current);
  }
  private async applyAction(action: ApplicationAction) {
    const modules = this.ports.modules;
    switch (action.kind) {
      case "open_view": modules.openView(action.view_type, action.view_id ?? undefined); break;
      case "activate_view": modules.activateView(action.view_id); break;
      case "close_view": modules.closeView(action.view_id); break;
      case "open_document": await modules.openDocument(action.path); break;
      case "create_document": modules.createDocument(action.path, action.text); break;
      case "set_selection": modules.setSelection(action.document, action.anchor, action.head); break;
      case "edit_document": modules.editDocument(action.document, action.edits); break;
      case "select_object": await modules.selectObject(action.selection); break;
      case "select_package": await modules.selectPackage(action.selection); break;
      case "select_plot": await modules.selectPlot(action.selection); break;
      case "save": case "run_selection": case "run_file": break;
    }
  }
  private async finishCompletion(project: string, current: () => void) {
    const pending = this.pendingCompletion!;
    let receipt: ApplicationCommandReceipt;
    if (pending.uncertain) {
      receipt = await this.ports.transport.status(project, { window: this.session!.window, request_id: pending.value.request_id }); current();
      if (receipt.state === "claimed") {
        const reply = await this.ports.transport.bridge(project, { kind: "complete", session: this.session!, completion: pending.value }); current();
        if (reply.kind !== "completed") throw new Error("Host did not return the original application receipt."); receipt = reply.data;
      }
    } else {
      const reply = await this.ports.transport.bridge(project, { kind: "complete", session: this.session!, completion: pending.value }); current();
      if (reply.kind !== "completed") throw new Error("Host did not confirm the application command."); receipt = reply.data;
    }
    this.lastReceipt = receipt;
    if (receipt.state === "applied" || receipt.state === "awaiting_execution") this.acknowledged = pending.snapshot;
    if (receipt.state === "locally_applied_unsynced" || receipt.state === "uncertain") {
      this.error = receipt.diagnostic ?? "Local changes are retained; application synchronization is unconfirmed.";
      this.ports.reportError(this.error);
    }
    if (receipt.state === "awaiting_execution" && pending.grant.execution_ref && !pending.uncertain) {
      this.execution = { grant: pending.grant, captured: pending.captured, step: receipt.save ? "save" : "run", continueRun: true, saveConfirmed: false };
    }
    this.pendingCompletion = null; this.publish();
  }
  private async executeStep(project: string, current: () => void) {
    const pending = this.execution!;
    const scope = this.ports.scope();
    if (!scope.connected || this.now() >= this.renewedAt + 15000) { this.disconnected(); return; }
    const reply = await this.ports.transport.execute(project, { session: this.session!, request_id: pending.grant.request.request_id,
      execution_ref: pending.grant.execution_ref!, step: pending.step });
    current();
    this.lastReceipt = reply.receipt;
    this.confirmSave(pending, reply.receipt);
    const step = pending.step === "save" ? reply.receipt.save : reply.receipt.run;
    if (step?.state === "succeeded") {
      if (pending.step === "save" && reply.receipt.run?.state === "not_submitted" && pending.continueRun && this.ports.scope().connected) pending.step = "run";
      else this.execution = null;
    } else if (step && ["failed", "cancelled", "uncertain"].includes(step.state)) this.execution = null;
    this.publish();
  }
  private confirmSave(pending: PendingExecution, receipt: ApplicationCommandReceipt) {
    const capture = receipt.capture;
    if (!pending.saveConfirmed && receipt.save?.state === "succeeded" && capture?.path && pending.captured !== null) {
      this.ports.modules.confirmSave(capture.document.document_id, pending.captured, capture.path, capture.sha256);
      pending.saveConfirmed = true;
    }
  }
  private async observeRecovery(project: string, current: () => void) {
    const pending = this.recovery!;
    const receipt = await this.ports.transport.status(project, { window: pending.grant.request.window, request_id: pending.grant.request.request_id });
    current(); this.lastReceipt = receipt; this.confirmSave(pending, receipt);
    // No execute call is made from reconnection. The original receipt and
    // authoritative Operation records determine what actually finished.
    const step = pending.step === "save" ? receipt.save : receipt.run;
    if (!step || ["succeeded", "failed", "cancelled", "uncertain", "not_submitted"].includes(step.state)) this.recovery = null;
    this.publish();
  }
  disconnected() {
    if (this.execution) { this.execution.continueRun = false; this.recovery = this.execution; this.execution = null; }
    if (this.pendingCompletion) this.pendingCompletion.uncertain = true;
    this.publish();
  }
  /** Independent of command/read latency; called by Studio's five-second lane. */
  heartbeat(): Promise<void> {
    if (this.renewing) return this.renewing;
    const session = this.session ?? this.registeringSession, scope = this.ports.scope(), generation = this.generation;
    if (this.stopped || !session || !scope.project || !scope.connected) { this.disconnected(); return Promise.resolve(); }
    if (this.now() - this.renewedAt < 5000) return Promise.resolve();
    const task = this.ports.transport.bridge(scope.project, { kind: "renew", session }).then((reply) => {
      this.assertScope(scope, generation);
      if (reply.kind !== "renewed") throw new Error("Host did not renew this window lease.");
      this.renewedAt = this.now(); this.publish();
    }).catch((error) => {
      if (!this.stopped && generation === this.generation && sameProject(scope, this.ports.scope())) {
        this.disconnected(); this.error = message(error); this.ports.reportError(this.error);
      }
      throw error;
    }).finally(() => { if (this.renewing === task) this.renewing = null; });
    this.renewing = task; return task;
  }
  async flush() {
    await this.step();
    if (!this.session || !this.initialized || this.restoreConflict) throw new Error(this.error || "Application drafts have not been synchronized.");
    const scope = this.ports.scope(), generation = this.generation;
    if (!scope.project || !scope.connected) throw new Error("The window is offline; drafts are retained locally.");
    if (this.pendingCompletion) await this.finishCompletion(scope.project, () => this.assertScope(scope, generation));
    await this.sync(scope.project, () => this.assertScope(scope, generation));
    if (this.pendingSync || !this.empty(this.changes(this.snapshot()))) throw new Error("The latest application draft is not yet synchronized.");
  }
  reset() {
    this.generation++; this.session = null; this.registeringSession = null; this.registeredScope = null; this.acknowledged = null; this.localContext = null;
    this.pendingSync = null; this.pendingCompletion = null; this.execution = null; this.recovery = null; this.claimRequestId = null;
    this.initialized = false; this.restoreConflict = false; this.error = ""; this.lastReceipt = null; this.publish();
  }
  stop() { this.stopped = true; this.generation++; this.disconnected(); this.dispose(); }
}
