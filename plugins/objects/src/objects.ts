import { Model, immutable, readonlyMap, readonlySet } from "./shared/model.js";
import { sameScope, terminal, message } from "./shared/ports.js";
import type { OperationChange } from "./resource-ports.js";
import type { ResourcePorts } from "./resource-ports.js";
import type { ObjectSelection } from "./resource-ports.js";
import type { BindingSummary } from "../public/r-protocol/index.js";
import type { ObjectMetadata } from "../public/r-protocol/index.js";
import type { ObjectDirectoryPage } from "../public/r-protocol/index.js";
import type { ObjectObservation as NativeObjectObservation } from "../public/r-protocol/index.js";
import type { ObjectReadPage } from "../public/r-protocol/index.js";
import type { CollectedVector } from "./object-vector.js";
import { vectorCopyBytes } from "./object-vector.js";
import type { ObjectPathElement } from "../public/r-protocol/index.js";
import type { ReadObjectArguments } from "../public/r-protocol/index.js";
import type { ObjectReadKind } from "../public/r-protocol/index.js";
import type { ObjectScalar } from "../public/r-protocol/index.js";
import type { JsonValue } from "../public/plugin-protocol/index.js";

export interface ObjectObservation { readonly page?: ObjectReadPage; readonly binding: BindingSummary; readonly observedAt: number; readonly notice: string; readonly stale: boolean }
interface ObjectIndex { readonly objects: readonly BindingSummary[]; readonly total_bindings: number; readonly truncated: boolean; readonly directory_ref: string }
interface ObjectsSnapshot {
  readonly data: ObjectIndex | null; readonly observedAt: number | null; readonly notice: string; readonly stale: boolean; readonly loading: boolean;
  readonly expanded: ReadonlySet<string>; readonly inspectors: ReadonlyMap<string, ObjectObservation>; readonly selected: string | null; readonly canLoadMore: boolean; readonly indexExpired: boolean;
}
interface ObservedReference { reference: string; metadata: ObjectMetadata | null; observedAt: number | null; expiresAt: number; validated: boolean }
export type ObjectPageRequest = Partial<Omit<ReadObjectArguments, "expected_session" | "object_ref">> & { kind: ObjectReadKind };
interface DetailRequest { key: string; name: string; reference: string; options: ObjectPageRequest; resolve(page: ObjectReadPage): void; reject(error: Error): void; promise: Promise<ObjectReadPage>; cancelled?: () => boolean }
type ObjectRead = { kind: "detail"; detail: DetailRequest; name: string; reference: string } | { kind: "directory"; reference: string | null; offset: number } | { kind: "observe"; name: string } | { kind: "read"; name: string; reference: string; readKind: ObjectReadKind };
const capabilities = ["r.list_objects", "r.observe_object", "r.read_object"];
const previewKind = (metadata: ObjectMetadata | null): ObjectReadKind => metadata?.supported_reads.includes("table") ? "table" : metadata?.supported_reads.includes("values") ? "values" : metadata?.supported_reads.includes("children") ? "children" : "structure";
const summary = (name: string, metadata: ObjectMetadata): BindingSummary => ({ name, kind: metadata.kind, object_type: metadata.object_type, classes: metadata.classes,
  length: metadata.length, dimensions: metadata.dimensions, preview: metadata.preview?.length ? metadata.preview.map(scalar) : null, preview_kind: metadata.preview?.length ? "values" : null, truncated: false, notice: metadata.notice });
function scalar(value: ObjectScalar): JsonValue {
  if (value.label !== null) return { kind: value.kind, label: value.label };
  if (value.text !== null) return value.text;
  if (value.logical !== null) return value.logical;
  if (value.imaginary !== null) return { kind: "complex", real: value.number, imaginary: value.imaginary };
  return value.number;
}
function preview(name: string, page: ObjectReadPage): BindingSummary {
  const binding = summary(name, page.metadata); binding.preview_kind = page.kind;
  if (page.kind === "table") binding.preview = page.columns.map((column) => ({ name: column.name ?? `Column ${column.index}`, type: column.metadata.object_type,
    classes: column.metadata.classes, values: column.metadata.supported_reads.includes("values") || column.values.length ? column.values.map(scalar) : null }));
  else if (page.kind === "values") binding.preview = page.values.map(scalar);
  else if (page.children.length) binding.preview = page.children.map((child) => ({ index: child.index, name: child.name, type: child.metadata.object_type,
    classes: child.metadata.classes, length: child.metadata.length, dimensions: child.metadata.dimensions, notice: child.metadata.notice }));
  binding.truncated = !page.complete; binding.notice = [page.metadata.notice, ...page.notices].filter(Boolean).join("\n") || null; return binding;
}

/** One native observation lane serves the retained directory and independent view demands. */
export class Objects extends Model<ObjectsSnapshot> {
  private viewState = new Map<string, unknown>();
  viewValue<T>(key: string, initial: T): T { return (this.viewState.has(key) ? this.viewState.get(key) : initial) as T; }
  setViewValue<T>(key: string, value: T) {
    if (!this.viewState.has(key) && this.viewState.size >= 128) this.viewState.delete(this.viewState.keys().next().value!);
    this.viewState.set(key, value); this.publish(); this.ports.changed();
  }
  private details = new Map<string, DetailRequest>();
  private pages = new Map<string, ObjectReadPage>();
  private indexMetadata = new Map<string, ObjectMetadata>();
  private dataValue: ObjectIndex | null = null;
  private time: number | null = null;
  private error = "";
  private staleValue = true;
  private expandedNames = new Set<string>();
  private previews = new Map<string, ObjectObservation>();
  private references = new Map<string, ObservedReference>();
  private blocked = new Set<string>();
  private demands = new Map<string, { name: string; viewId: string }>();
  private activeViewIds: ReadonlySet<string> | null = null;
  private manual = new Set<string>();
  private names: readonly string[] = Object.freeze([]);
  private selectedName: string | null = null;
  private pending = new Set<string>();
  private listDirty = true;
  private requestedOffset: number | null = null;
  private nextOffset: number | null = null;
  private directoryExpiresAt = 0;
  private directoryExpired = false;
  private retryRead: ObjectRead | null = null;
  private inFlight: { revision: number; generation: number } | null = null;
  private revision = 0;
  private generation = 0;
  private invalidation = 0;
  private stopped = false;
  constructor(private readonly ports: ResourcePorts) { super(); }
  protected readSnapshot(): ObjectsSnapshot {
    return { data: this.dataValue, observedAt: this.time, notice: this.notice, stale: this.staleValue, loading: !!this.inFlight,
      expanded: readonlySet(this.expandedNames), inspectors: readonlyMap(this.previews), selected: this.selectedName, canLoadMore: this.canLoadMore, indexExpired: this.directoryExpired };
  }
  metadata(name: string) { return this.references.get(name)?.metadata ?? this.indexMetadata.get(name) ?? null; }
  get version() { return this.invalidation; }
  readPage(name: string, options: ObjectPageRequest, continuation?: { cancelled?: () => boolean }): Promise<ObjectReadPage> {
    const scope = this.ports.context(), ref = this.references.get(name);
    if (!scope.connected || (scope.runtimeState !== "idle" && !(continuation && scope.runtimeState === "busy"))) return Promise.reject(new Error("R is busy or disconnected. The previous observation is retained."));
    if (!ref?.validated || Date.now() >= ref.expiresAt) return Promise.reject(new Error("Refresh this object to read a current observation."));
    const key = JSON.stringify([ref.reference, options]);
    const cached = this.pages.get(key); if (cached) return Promise.resolve(cached);
    const pending = this.details.get(key); if (pending) return pending.promise;
    if (this.details.size >= 64) return Promise.reject(new Error("Too many object pages requested. Narrow the view."));
    let resolve!: DetailRequest["resolve"], reject!: DetailRequest["reject"];
    const promise = new Promise<ObjectReadPage>((yes, no) => { resolve = yes; reject = no; });
    this.details.set(key, { key, name, reference: ref.reference, options, resolve, reject, promise, cancelled: continuation?.cancelled });
    this.ports.schedule(); return promise;
  }
  summaryValues(name: string): readonly ObjectScalar[] {
    const observed = this.previews.get(name);
    if (observed?.page?.kind === "values" && observed.page.object_ref === this.references.get(name)?.reference && !observed.page.path.length && !observed.page.observed_path.length)
      return observed.page.values.slice(0, (observed.page.metadata.length ?? Infinity) <= 8 ? 8 : 4);
    return this.metadata(name)?.preview ?? [];
  }
  /** Explicit user copy reads are bounded and may never combine observations. */
  async collectVector(name: string, path: ObjectPathElement[], options: {
    reference: string; basis?: "values" | "levels"; range?: { start: number; count: number }; cancelled?: () => boolean;
  }): Promise<CollectedVector> {
    const scope = { ...this.ports.context() }, revision = this.revision, invalidation = this.invalidation;
    if (!scope.connected || scope.runtimeState !== "idle") throw new Error("R is busy or disconnected. The previous observation is retained.");
    let bytes = 0;
    const check = () => {
      const ref = this.references.get(name);
      if (options.cancelled?.()) throw new Error("Copy cancelled.");
      if (!this.ports.context().connected) throw new Error("R is disconnected. The previous observation is retained.");
      if (this.stopped || revision !== this.revision || invalidation !== this.invalidation || !sameScope(scope, this.ports.context(), true) || !ref?.validated || ref.reference !== options.reference || Date.now() >= ref.expiresAt)
        throw new Error("The object observation changed. Refresh before copying again.");
    };
    const read = async (request: ObjectPageRequest) => {
      check(); const page = await this.readPage(name, { ...request, path }, { cancelled: options.cancelled }); check();
      if (page.object_ref !== options.reference) throw new Error("The object changed during copy.");
      if (page.kind !== request.kind || page.start !== (request.start ?? 1)) throw new Error("The requested copy range is unavailable.");
      return page;
    };
    const completeText = async (value: ObjectScalar, index: number, attribute?: "names" | "levels") => {
      let v = { ...value }, next = v.text !== null ? v.next_text_start : null;
      while (next !== null) {
        const part = await read({ kind: "text", start: index, text_start: next, text_limit_bytes: 16384, text_attribute: attribute });
        const text = part.values[0];
        if (!text || text.text === null || (part.next_text_start !== null && part.next_text_start <= next)) throw new Error("Text continuation did not advance.");
        v.text = (v.text ?? "") + text.text; next = part.next_text_start;
        if (new TextEncoder().encode(v.text).length > vectorCopyBytes) throw new Error("Copy exceeds 1 MiB. Select a smaller range.");
      }
      if(v.text !== null) v.next_text_start = null;
      bytes += new TextEncoder().encode(v.text ?? String(v.number ?? v.logical ?? v.label ?? "")).length + 4;
      if(bytes > vectorCopyBytes) throw new Error("Copy exceeds 1 MiB. Select a smaller range.");
      return v;
    };
    const gather = async (kind: "values" | "names" | "levels", range?: {start: number;count: number}) => {
      let start = range?.start ?? 1; const values: ObjectScalar[] = []; let metadata: ObjectMetadata | null = null;
      if(!Number.isSafeInteger(start) || start < 1 || (range && (!Number.isSafeInteger(range.count) || range.count < 0 || range.count > 100000))) throw new Error("Copy range is outside the supported limit.");
      do {
        const remaining = range ? range.count - values.length : 100000 - values.length;
        if(remaining <= 0 && metadata) break;
        const limit = Math.max(1, Math.min(200, remaining));
        const page = await read({ kind, start, limit }); metadata = page.metadata;
        if(page.values.length > limit) throw new Error("Copy page exceeds its requested range.");
        if(range?.count === 0) break;
        for(let i=0;i<page.values.length;i++) values.push(await completeText(page.values[i], start+i, kind==='values' ? undefined : kind));
        if(page.next_start === null) break;
        if(!page.values.length || page.next_start !== start + page.values.length) throw new Error("Vector continuation did not advance without gaps.");
        if(values.length >= 100000 && (!range || values.length < range.count)) throw new Error("Copy is limited to 100,000 values. Select a smaller range.");
        start = page.next_start;
      } while (!range || values.length < range.count);
      if(range && values.length !== range.count) throw new Error("The full requested range is unavailable.");
      const total = kind === "levels" ? metadata?.level_count : metadata?.length;
      if (!range && total != null && values.length !== total) throw new Error("The complete vector is unavailable. Copy a shown range instead.");
      return { values, metadata: metadata! };
    };
    const basis = options.basis ?? "values", data = await gather(basis, options.range);
    const metadata = basis === "levels" ? { ...data.metadata, object_type: "character", classes: [], dimensions: [], attributes: [], length: data.values.length } : data.metadata;
    const names = basis === "values" && metadata.supported_reads.includes("names") ? (await gather("names", { start: options.range?.start ?? 1, count: data.values.length })).values : undefined;
    const levels = basis === "values" && metadata.classes.includes("factor") ? (await gather("levels")).values : undefined;
    check(); return { values: data.values, names, levels, metadata, objectRef: options.reference, start: options.range?.start ?? 1 };
  }
  private clearPages() {
    for (const request of this.details.values()) request.reject(new Error("Object observation changed. Refresh to read current values."));
    this.details.clear(); this.pages.clear();
  }
  get data() { return this.dataValue; }
  get observedAt() { return this.time; }
  get notice() { return this.ports.context().session && !this.supported ? "Progressive object reads are unavailable for this R instance." : this.error; }
  get stale() { return this.staleValue; }
  get loading() { return !!this.inFlight; }
  get expanded() { return this.getSnapshot().expanded; }
  get inspectors() { return this.getSnapshot().inspectors; }
  get selected() { return this.selectedName; }
  private get supported() { return capabilities.every((id) => this.ports.context().capabilities.includes(id)); }
  get canLoadMore() { return this.nextOffset !== null && !this.listDirty && !this.directoryExpired && Date.now() < this.directoryExpiresAt && !this.loading && this.requestedOffset === null; }
  get selection(): ObjectSelection | null {
    const session = this.ports.context().session, name = this.selectedName, observed = name ? this.references.get(name) : null;
    return name && session && observed?.validated && Date.now() < observed.expiresAt ? Object.freeze({ name, object_ref: observed.reference, native_session_id: session }) : null;
  }
  /** The optional page is an already verified root read from the shared owner. */
  selectObservation(selection: ObjectSelection, page?: ObjectReadPage) {
    if (!selection.object_ref || selection.native_session_id !== this.ports.context().session) throw new Error("The selected object observation is no longer current.");
    if (page && (page.object_ref !== selection.object_ref || page.root_name !== selection.name || page.observed_path.length || page.path.length)) throw new Error("The selected evidence does not identify this root binding.");
    this.references.set(selection.name, { reference: selection.object_ref, metadata: page?.metadata ?? null, observedAt: page?.observed_at_ms ?? null,
      expiresAt: page ? Math.min(page.observed_at_ms + 300000, Date.now() + 60000) : 0, validated: !!page });
    this.selectedName = selection.name; this.expandedNames.add(selection.name); this.blocked.delete(selection.name);
    this.manual.add(selection.name); this.pending.add(selection.name); this.publish(); this.ports.changed(); this.ports.schedule();
  }
  get visibleNames(): readonly string[] { return [...new Set([...this.demands.values()].filter((d) => !this.activeViewIds || this.activeViewIds.has(d.viewId)).map((d) => d.name))]; }
  completionNames = (): readonly string[] => this.names;
  get needsObservation() {
    const scope = this.ports.context();
    return !this.stopped && this.supported && !!scope.project && !!scope.session && scope.connected && scope.runtimeState === "idle" &&
      (!!this.retryRead || this.listDirty || this.details.size > 0 || this.requestedOffset !== null || [...this.pending].some((name) => !this.blocked.has(name)));
  }
  serialize() { return { objectViews: Object.fromEntries(this.viewState), expandedObjects: [...this.expandedNames], selectedObject: this.selectedName }; }
  restore(value: unknown) {
    this.reset(); const data = value as { objectViews?: Record<string, unknown>; expandedObjects?: unknown; selectedObject?: unknown } | null;
    this.viewState = new Map(Object.entries(data?.objectViews ?? {}).slice(0, 128));
    if (Array.isArray(data?.expandedObjects)) for (const name of data.expandedObjects) if (typeof name === "string") this.expandedNames.add(name);
    if (typeof data?.selectedObject === "string") this.selectedName = data.selectedObject; this.publish();
  }
  reset() {
    this.clearPages(); this.viewState.clear(); this.indexMetadata.clear(); this.revision++; this.stopped = false; this.inFlight = null; this.dataValue = null; this.time = null; this.error = ""; this.staleValue = true;
    this.previews.clear(); this.references.clear(); this.blocked.clear(); this.pending.clear(); this.manual.clear(); this.demands.clear(); this.activeViewIds = null;
    this.listDirty = true; this.requestedOffset = this.nextOffset = null; this.directoryExpired = false; this.directoryExpiresAt = 0; this.retryRead = null;
    this.names = Object.freeze([]); this.expandedNames.clear(); this.selectedName = null; this.publish();
  }
  sessionChanged() {
    this.clearPages(); this.indexMetadata.clear();
    this.revision++; this.inFlight = null; this.dataValue = null; this.time = null; this.previews.clear(); this.references.clear(); this.blocked.clear(); this.manual.clear();
    this.names = Object.freeze([]); this.error = ""; this.staleValue = true; this.listDirty = true; this.requestedOffset = this.nextOffset = null;
    this.directoryExpired = false; this.directoryExpiresAt = 0; this.retryRead = null; this.pending = new Set(this.visibleNames); this.publish(); this.ports.schedule();
  }
  stop() { this.clearPages(); this.stopped = true; this.revision++; this.inFlight = null; this.demands.clear(); this.pending.clear(); this.retryRead = null; this.publish(); this.dispose(); }
  operationChanged(event: OperationChange) {
    const scope = this.ports.context();
    if (event.epoch === scope.epoch && event.project === scope.project && event.session === scope.session && event.capability === "r.execute" && (event.status === "running" || terminal(event.status))) this.invalidate();
  }
  invalidate() {
    this.clearPages();
    this.invalidation++; this.listDirty = true; this.staleValue = true; this.references.clear(); this.blocked.clear(); this.retryRead = null;
    this.requestedOffset = this.nextOffset = null; this.directoryExpired = false;
    for (const [name, observed] of this.previews) this.previews.set(name, Object.freeze({ ...observed, stale: true }));
    for (const name of this.visibleNames) this.pending.add(name); this.publish(); this.ports.schedule();
  }
  viewsChanged(event: { activeViewIds: readonly string[] }) {
    this.activeViewIds = new Set(event.activeViewIds); const visible = new Set(this.visibleNames);
    for (const name of this.pending) if (!visible.has(name) && !this.manual.has(name)) this.pending.delete(name);
    if (this.retryRead && "name" in this.retryRead && !visible.has(this.retryRead.name) && !this.manual.has(this.retryRead.name)) this.retryRead = null;
    for (const name of visible) if (!this.blocked.has(name) && (!this.previews.has(name) || this.previews.get(name)?.stale)) this.pending.add(name);
    if (this.needsObservation) this.ports.schedule();
  }
  registerDemand(token: string, name: string, viewId: string): () => void {
    const demand = { name, viewId }; this.demands.set(token, demand);
    if ((!this.activeViewIds || this.activeViewIds.has(viewId)) && !this.blocked.has(name) && (!this.previews.has(name) || this.previews.get(name)?.stale || !this.references.get(name)?.validated)) this.pending.add(name);
    if (this.needsObservation) this.ports.schedule(); return () => { if (this.demands.get(token) === demand) this.releaseDemand(token); };
  }
  releaseDemand(token: string) {
    const name = this.demands.get(token)?.name; this.demands.delete(token);
    if (name && !this.visibleNames.includes(name) && !this.manual.has(name)) { this.pending.delete(name); if (this.retryRead && "name" in this.retryRead && this.retryRead.name === name) this.retryRead = null; }
  }
  toggleExpanded(name: string) { this.setExpanded(name, !this.expandedNames.has(name)); }
  setExpanded(name: string, expanded: boolean) {
    if (expanded) { this.expandedNames.add(name); this.selectedName = name; if (this.blocked.delete(name)) this.references.delete(name);
      if (this.visibleNames.includes(name) && (!this.references.get(name)?.validated || this.previews.get(name)?.stale)) { this.pending.add(name); this.ports.schedule(); } }
    else this.expandedNames.delete(name); this.publish(); this.ports.changed();
  }
  collapseAll() { this.expandedNames.clear(); this.publish(); this.ports.changed(); }
  inspect(name: string) {
    for (const [key, page] of this.pages) if (page.root_name === name) this.pages.delete(key);
    const previous = this.previews.get(name); if (previous) this.previews.set(name, Object.freeze({ ...previous, stale: true }));
    if (this.blocked.delete(name) || (this.references.get(name)?.expiresAt ?? Infinity) <= Date.now()) this.references.delete(name);
    this.manual.add(name); this.pending.add(name); this.selectedName = name; this.publish(); this.ports.changed(); this.ports.schedule();
  }
  refresh() { this.invalidate(); }
  loadMore() { if (this.canLoadMore) { this.requestedOffset = this.nextOffset; this.publish(); this.ports.schedule(); } }
  private expire() {
    let changed = false; const now = Date.now();
    if (this.dataValue && !this.listDirty && !this.directoryExpired && now >= this.directoryExpiresAt) {
      this.directoryExpired = true; this.requestedOffset = null; this.error = "The object directory reference expired. Refresh Objects to open a new observation."; changed = true;
    }
    for (const [name, reference] of this.references) if (reference.validated && now >= reference.expiresAt) {
      reference.validated = false; this.blocked.add(name); this.pending.delete(name);
      const previous = this.previews.get(name); if (previous) this.previews.set(name, Object.freeze({ ...previous, stale: true, notice: "The observation reference expired. Refresh this preview to read it again." })); changed = true;
    }
    for (const [key, detail] of this.details) {
      if (detail.cancelled?.() || !this.references.get(detail.name)?.validated || !this.ports.context().connected) {
        this.details.delete(key); detail.reject(new Error(detail.cancelled?.() ? "Copy cancelled." : "The object observation expired or disconnected. Refresh before copying again."));
        if (this.retryRead?.kind === "detail" && this.retryRead.detail.key === key) this.retryRead = null;
      }
    }
    if (changed) { this.publish(); this.ports.changed(); }
  }
  private request(): ObjectRead | null {
    if (this.retryRead) return this.retryRead;
    if (this.listDirty) return { kind: "directory", reference: null, offset: 0 };
    const name = [...this.pending].find((name) => !this.blocked.has(name));
    if (name) { const observed = this.references.get(name); return observed ? { kind: "read", name, reference: observed.reference, readKind: previewKind(observed.metadata) } : { kind: "observe", name }; }
    const detail = this.details.values().next().value;
    if (detail) return { kind: "detail", detail, name: detail.name, reference: detail.reference };
    return this.requestedOffset !== null && this.dataValue ? { kind: "directory", reference: this.dataValue.directory_ref, offset: this.requestedOffset } : null;
  }
  /** Exactly one serial native query per slice; pages never drain implicitly. */
  async observe() {
    this.expire(); const identity = { ...this.ports.context() };
    if (!this.needsObservation || this.inFlight || !identity.project || !identity.session) return;
    const request = this.request(); if (!request) return;
    const capability = request.kind === "directory" ? "r.list_objects" : request.kind === "observe" ? "r.observe_object" : "r.read_object";
    const args = request.kind === "directory" ? { expected_session: identity.session, name_contains: "", object_type: null, directory_ref: request.reference, offset: request.offset, limit: 200 }
      : request.kind === "detail" ? { expected_session: identity.session, object_ref: request.reference, path: [], start: 1, limit: 100, column_start: 1, column_limit: 20, ...request.detail.options }
      : request.kind === "observe" ? { expected_session: identity.session, name: request.name, path: [] }
        : { expected_session: identity.session, object_ref: request.reference, kind: request.readKind, path: [], start: 1, limit: 20, column_start: 1, column_limit: 10 };
    const flight = { revision: this.revision, generation: ++this.generation }, invalidation = this.invalidation, started = Date.now(); this.inFlight = flight; this.publish();
    const current = () => !this.stopped && this.inFlight === flight && flight.revision === this.revision && sameScope(identity, this.ports.context(), true);
    try {
      // Empty optional features do not require a newer live Host. Feature-bearing
      // reads are enabled only by the native metadata's table_features.
      const nativeArgs = Object.fromEntries(Object.entries(args).filter(([key, value]) => !["slice", "sort_column", "sort_descending", "filter_column", "filter_text"].includes(key) || (value !== null && value !== false && value !== "" && (!Array.isArray(value) || value.length > 0))));
      const result = await this.ports.query(identity.project, capability, nativeArgs); if (!current()) return;
      if (result.session_id !== identity.session) throw new Error("The object observation belongs to another R session.");
      if (result.status !== "ready" || !result.data) {
        this.error = result.diagnostic ? `${result.diagnostic.code}: ${result.diagnostic.message}` : result.notices.join("\n") || `Objects ${result.status}.`; this.staleValue = true;
        const permanent = ["observation_expired", "observation_invalid", "content_changed", "budget_exhausted", "budget_exceeded", "stale_session", "session_changed", "invalid_input", "not_found"].includes(result.diagnostic?.code ?? "");
        if (request.kind === "detail") {
          if (!permanent && result.status === "busy") this.retryRead = request;
          else { request.detail.reject(new Error(this.error)); this.details.delete(request.detail.key); if (permanent) this.block(request); }
        }
        else if (permanent) this.block(request); else this.retryRead = request; return;
      }
      if (request.kind === "directory") {
        const page = result.data as ObjectDirectoryPage;
        if (!page.directory_ref || !Array.isArray(page.entries) || page.offset !== request.offset || (request.reference && page.directory_ref !== request.reference) || (page.next_offset !== null && page.next_offset <= page.offset)) throw new Error("The object directory page does not match its original reference and position.");
        if (invalidation !== this.invalidation) return;
        if (!request.reference) this.indexMetadata.clear();
        for (const entry of page.entries) this.indexMetadata.set(entry.name, entry.metadata);
        const entries = request.reference ? [...this.dataValue!.objects, ...page.entries.map((entry) => summary(entry.name, entry.metadata))] : page.entries.map((entry) => summary(entry.name, entry.metadata));
        this.dataValue = immutable({ directory_ref: page.directory_ref, objects: [...new Map(entries.map((entry) => [entry.name, entry])).values()], total_bindings: page.total, truncated: !page.complete });
        const names = this.dataValue.objects.map((entry) => entry.name); if (names.length !== this.names.length || names.some((name, i) => name !== this.names[i])) this.names = Object.freeze(names);
        this.time = page.observed_at_ms; this.nextOffset = page.next_offset; this.requestedOffset = null; this.listDirty = false; this.directoryExpired = false;
        this.directoryExpiresAt = Math.min(page.observed_at_ms + 300000, started + 60000); this.staleValue = false;
      } else if (request.kind === "observe") {
        const observed = result.data as NativeObjectObservation;
        if (!observed.object_ref || observed.name !== request.name || observed.path.length !== 0) throw new Error("The object observation does not identify the requested root binding.");
        if (invalidation !== this.invalidation) return;
        this.references.set(request.name, { reference: observed.object_ref, metadata: observed.metadata, observedAt: observed.observed_at_ms, expiresAt: Math.min(observed.expires_at_ms, started + 60000), validated: true });
        if (!this.previews.has(request.name)) this.previews.set(request.name, immutable({ binding: summary(request.name, observed.metadata), observedAt: observed.observed_at_ms, notice: "Reading bounded preview…", stale: true })); this.ports.changed();
      } else if (request.kind === "detail") {
        const page = result.data as ObjectReadPage, expected = request.detail.options;
        if (invalidation !== this.invalidation || page.object_ref !== request.reference || page.root_name !== request.name || page.observed_path.length ||
          page.kind !== expected.kind || JSON.stringify(page.path) !== JSON.stringify(expected.path ?? []) || page.start !== (expected.start ?? 1) || page.column_start !== (expected.column_start ?? 1))
          throw new Error("The page no longer matches the requested object observation.");
        this.details.delete(request.detail.key);
        if (this.pages.size >= 48) this.pages.delete(this.pages.keys().next().value!);
        this.pages.set(request.detail.key, immutable(page)); request.detail.resolve(page);
        const ref = this.references.get(request.name); if (ref) ref.expiresAt = Math.min(page.observed_at_ms + 300000, started + 60000);
      } else {
        const page = result.data as ObjectReadPage;
        if (page.object_ref !== request.reference || page.root_name !== request.name || page.observed_path.length || page.path.length || page.kind !== request.readKind) throw new Error("The preview does not match the original object reference.");
        const stale = invalidation !== this.invalidation; this.previews.set(request.name, immutable({ page, binding: preview(request.name, page), observedAt: page.observed_at_ms, notice: page.notices.join("\n"), stale }));
        if (!stale) {
          this.references.set(request.name, { reference: request.reference, metadata: page.metadata, observedAt: page.observed_at_ms, expiresAt: Math.min(page.observed_at_ms + 300000, started + 60000), validated: true });
          if (request.readKind !== "structure" || !["table", "values"].includes(previewKind(page.metadata))) { this.pending.delete(request.name); this.manual.delete(request.name); } this.ports.changed();
        }
      }
      this.retryRead = null; this.error = "";
    } catch (error) {
      if (current()) {
        this.error = message(error); this.staleValue = true;
        if (request.kind === "detail") { request.detail.reject(new Error(this.error)); this.details.delete(request.detail.key); if (invalidation === this.invalidation && /expired|changed|invalid|budget|stale_session/i.test(this.error)) this.block(request); return; }
        if (/not_found|does not exist|observation_expired|content_changed|budget_exhausted|budget_exceeded|stale_session|reference[^\n]*(expired|invalid)|binding[^\n]*changed/i.test(this.error)) this.block(request);
        else if (invalidation === this.invalidation) this.retryRead = request; throw error;
      }
    } finally { if (current()) { this.inFlight = null; this.publish(); if (this.needsObservation) this.ports.schedule(); } }
  }
  private block(request: ObjectRead) {
    this.retryRead = null;
    if (request.kind === "directory") { this.directoryExpired = true; this.listDirty = false; this.requestedOffset = null; }
    else { this.blocked.add(request.name); this.pending.delete(request.name); const reference = this.references.get(request.name); if (reference) reference.validated = false;
      const previous = this.previews.get(request.name); if (previous) this.previews.set(request.name, Object.freeze({ ...previous, stale: true, notice: this.error })); }
  }
}
