import { Model, immutable, readonlyMap } from "./shared/model";
import { sameScope, terminal, message } from "./shared/ports";
import type { OperationChange, DomainEvents } from "./shared/events";
import type { ResourcePorts } from "./resource-ports";
import type { PackageSnapshotData } from "./generated/PackageSnapshotData";
import type { PackageQueryArguments } from "./generated/PackageQueryArguments";
import type { PackageGroup } from "./generated/PackageGroup";
import type { PackageEntry } from "./generated/PackageEntry";

export type PackageView = "installed" | "loaded" | "attached" | "multiple";
export interface PackageDetails {
  readonly copies: readonly PackageEntry[];
  readonly total: number;
  readonly next: number | null;
  readonly loading: boolean;
  readonly notice: string;
}
export const packageCopyKey = (copy: PackageEntry) =>
  `${copy.library_path ?? ""}\n${copy.name}\n${copy.version}`;
/** Validate navigation independently of native metadata sanitization. */
export function packageLink(value: string | null | undefined): string | null {
  if (!value || value.length > 2048 || /[\u0000-\u0020]/.test(value))
    return null;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname.includes("[redacted]")
    )
      return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

interface PackagesSnapshot {
  readonly data: PackageSnapshotData | null;
  readonly observedAt: number | null;
  readonly session: string | null;
  readonly groups: ReadonlyMap<string, PackageGroup>;
  readonly details: ReadonlyMap<string, PackageDetails>;
  readonly filter: string;
  readonly mode: PackageView;
  readonly descending: boolean;
  readonly offset: number;
  readonly scrollTop: number;
  readonly selected: string | null;
  readonly sourceCopy: string | null;
  readonly inspectorMode: "overview" | "source";
  readonly loading: boolean;
  readonly stale: boolean;
  readonly notice: string;
  readonly expired: boolean;
  readonly next: number | null;
  readonly filtered: readonly PackageGroup[];
  readonly page: readonly PackageGroup[];
  readonly completeIndex: boolean;
}
interface PackageRead { args: PackageQueryArguments; invalidation: number; fresh: boolean; }

/** All index pages and copy details remain pinned to one native observation. */
export class Packages extends Model<PackagesSnapshot> {
  private dataValue: PackageSnapshotData | null = null;
  private time: number | null = null;
  private sessionValue: string | null = null;
  private groupIndex = new Map<string, PackageGroup>();
  private copyDetails = new Map<string, PackageDetails>();
  private filterValue = "";
  private modeValue: PackageView = "installed";
  private descendingValue = false;
  private offsetValue = 0;
  private scroll = 0;
  private selectedName: string | null = null;
  private selectedCopy: string | null = null;
  private inspection: "overview" | "source" = "overview";
  private visibleViews = new Map<string, string>();
  private activeViewIds: ReadonlySet<string> | null = null;
  private dirtyValue = true;
  private staleValue = true;
  private error = "";
  private expiredValue = false;
  private nextOffset: number | null = null;
  private revision = 0;
  private invalidation = 0;
  private generation = 0;
  private flight: { revision: number; generation: number; request: PackageRead } | null = null;
  private retryRead: PackageRead | null = null;
  private detailRequests = new Map<string, { offset: number }>();
  private stopped = false;
  constructor(private readonly ports: ResourcePorts) { super(); }
  protected readSnapshot(): PackagesSnapshot {
    const filter = this.filterValue.toLocaleLowerCase();
    const filtered = Object.freeze([...this.groupIndex.values()].filter((group) =>
      (this.modeValue === "installed" || (this.modeValue === "loaded" && group.loaded_version !== null) ||
        (this.modeValue === "attached" && group.attached) || (this.modeValue === "multiple" && group.copy_count > 1)) &&
      `${group.name} ${group.title ?? ""}`.toLocaleLowerCase().includes(filter))
      .sort((a, b) => (this.descendingValue ? -1 : 1) * a.name.localeCompare(b.name)));
    return { data: this.dataValue, observedAt: this.time, session: this.sessionValue,
      groups: readonlyMap(this.groupIndex), details: readonlyMap(this.copyDetails), filter: this.filterValue,
      mode: this.modeValue, descending: this.descendingValue, offset: this.offsetValue, scrollTop: this.scroll,
      selected: this.selectedName, sourceCopy: this.selectedCopy, inspectorMode: this.inspection,
      loading: !!this.flight, stale: this.staleValue, notice: this.error, expired: this.expiredValue, next: this.nextOffset,
      filtered, page: Object.freeze(filtered.slice(this.offsetValue, this.offsetValue + 100)),
      completeIndex: !!this.dataValue && this.groupIndex.size === this.dataValue.counts.all };
  }
  get data() { return this.dataValue; }
  get observedAt() { return this.time; }
  get session() { return this.sessionValue; }
  get groups() { return this.getSnapshot().groups; }
  get details() { return this.getSnapshot().details; }
  get filter() { return this.filterValue; }
  get mode() { return this.modeValue; }
  get descending() { return this.descendingValue; }
  get offset() { return this.offsetValue; }
  get scrollTop() { return this.scroll; }
  get selected() { return this.selectedName; }
  get sourceCopy() { return this.selectedCopy; }
  get inspectorMode() { return this.inspection; }
  get loading() { return !!this.flight; }
  get notice() { return this.error; }
  get stale() { return this.staleValue; }
  get expired() { return this.expiredValue; }
  get next() { return this.nextOffset; }
  get dirty() { return this.dirtyValue; }
  get visible() { return [...this.visibleViews.values()].some((viewId) => !this.activeViewIds || this.activeViewIds.has(viewId)); }
  get filtered() { return this.getSnapshot().filtered; }
  get page() { return this.getSnapshot().page; }
  get completeIndex() { return this.getSnapshot().completeIndex; }
  get needsObservation() {
    const scope = this.ports.context();
    return !this.stopped && this.visible && !this.expiredValue && !!scope.project && !!scope.session && scope.connected &&
      scope.runtimeState === "idle" && scope.capabilities.includes("workspace.packages") && (this.dirtyValue || !!this.retryRead || this.nextOffset !== null || this.detailRequests.size > 0);
  }
  serialize() {
    return { packages: { filter: this.filterValue, mode: this.modeValue, descending: this.descendingValue, offset: this.offsetValue,
      scrollTop: this.scroll, selected: this.selectedName, sourceCopy: this.selectedCopy, inspectorMode: this.inspection } };
  }
  restore(value: unknown) {
    this.reset();
    const data = (value as { packages?: Partial<ReturnType<Packages["serialize"]>["packages"]> } | null)?.packages;
    if (typeof data?.filter === "string") this.filterValue = data.filter;
    if (["installed", "loaded", "attached", "multiple"].includes(data?.mode ?? "")) this.modeValue = data!.mode!;
    this.descendingValue = data?.descending === true;
    if (Number.isSafeInteger(data?.offset) && data!.offset! >= 0) this.offsetValue = data!.offset!;
    if (typeof data?.scrollTop === "number" && Number.isFinite(data.scrollTop)) this.scroll = Math.max(0, data.scrollTop);
    if (typeof data?.selected === "string") this.selectedName = data.selected;
    if (typeof data?.sourceCopy === "string") this.selectedCopy = data.sourceCopy;
    this.inspection = data?.inspectorMode === "source" ? "source" : "overview";
    this.publish();
  }
  reset() {
    this.revision++; this.stopped = false; this.flight = null; this.retryRead = null;
    this.dataValue = null; this.time = null; this.sessionValue = null; this.groupIndex.clear(); this.copyDetails.clear();
    this.detailRequests.clear(); this.selectedName = null; this.selectedCopy = null; this.inspection = "overview";
    this.offsetValue = 0; this.scroll = 0; this.nextOffset = null; this.dirtyValue = true; this.staleValue = true;
    this.error = ""; this.expiredValue = false; this.publish();
  }
  sessionChanged() {
    const selected = this.selectedName, copy = this.selectedCopy, inspection = this.inspection;
    this.reset(); this.selectedName = selected; this.selectedCopy = copy; this.inspection = inspection;
    this.publish(); this.ports.schedule();
  }
  stop() { this.stopped = true; this.revision++; this.flight = null; this.retryRead = null; this.visibleViews.clear(); this.detailRequests.clear(); this.publish(); this.dispose(); }
  viewsChanged(event: DomainEvents["viewsChanged"]) {
    this.activeViewIds = new Set(event.activeViewIds);
    if (this.needsObservation) this.ports.schedule();
  }
  setVisible(token: string, visible: boolean, viewId = "packages") {
    if (visible) this.visibleViews.set(token, viewId); else this.visibleViews.delete(token);
    if (visible && this.needsObservation) this.ports.schedule();
  }
  operationChanged(event: OperationChange) {
    const scope = this.ports.context();
    if (event.epoch === scope.epoch && event.project === scope.project && event.capability.startsWith("workspace.") && terminal(event.status)) this.invalidate();
  }
  invalidate() {
    this.dirtyValue = true; this.staleValue = true; this.invalidation++;
    // An expired observation stays pinned until an explicit Refresh.
    this.publish(); this.ports.schedule();
  }
  requestRefresh() {
    this.expiredValue = false; this.error = ""; this.retryRead = null; this.detailRequests.clear();
    this.invalidate();
  }
  select(filter: string, mode: PackageView = this.modeValue, offset = 0) {
    this.filterValue = filter; this.modeValue = mode; this.offsetValue = Math.max(0, offset); this.scroll = 0; this.publish();
    if (this.selectedName && !this.filtered.some((group) => group.name === this.selectedName)) {
      this.selectedName = null; this.inspection = "overview"; this.selectedCopy = null; this.publish();
    }
    this.ports.changed();
  }
  setDescending(value: boolean) { this.descendingValue = value; this.select(this.filterValue); }
  setScroll(value: number) { this.scroll = value; this.publish(); this.ports.changed(); }
  showSource(copy: string | null = null) { this.selectedCopy = copy; this.inspection = "source"; this.publish(); this.ports.changed(); }
  showOverview() { this.inspection = "overview"; this.publish(); this.ports.changed(); }
  pick(name: string, toggle = false) {
    this.selectedName = toggle && this.selectedName === name ? null : name;
    this.inspection = "overview"; this.selectedCopy = null; this.publish(); this.ports.changed();
    if (this.selectedName) this.inspect(this.selectedName);
  }
  inspect(name: string, more = false) {
    const previous = this.copyDetails.get(name);
    if (previous?.loading || (previous && !previous.notice && !more)) return;
    if (more && previous?.next === null) return;
    this.detailRequests.set(name, { offset: more ? previous?.next ?? 0 : 0 });
    this.ports.schedule();
  }
  retry() { if (!this.expiredValue) this.ports.schedule(); }
  private request(session: string): PackageRead | null {
    if (this.retryRead) return this.retryRead;
    const fresh = this.dirtyValue || !this.dataValue;
    let name: string | null = null, offset = fresh ? 0 : this.nextOffset;
    if (!fresh && this.detailRequests.size) {
      const first = this.detailRequests.entries().next().value!; name = first[0]; offset = first[1].offset;
    }
    if (!fresh && offset === null) return null;
    return { fresh, invalidation: this.invalidation, args: {
      expected_session: session, filter: "", mode: "installed", grouped: true,
      observation_id: fresh ? null : this.dataValue!.observation_id, package_name: name,
      offset: offset ?? 0, limit: name ? 20 : 200,
    } };
  }
  /** One page per coordinator slice. A failed read retains the exact request. */
  async observe() {
    const identity = { ...this.ports.context() };
    if (this.stopped || !this.visible || this.flight || this.expiredValue || !identity.connected || !identity.project || !identity.session || identity.runtimeState !== "idle") return;
    if (!identity.capabilities.includes("workspace.packages")) {
      this.error = "Package observation is unavailable for this Host."; this.dirtyValue = false; this.publish(); return;
    }
    const request = this.request(identity.session); if (!request) return;
    const flight = { revision: this.revision, generation: ++this.generation, request };
    const name = request.args.package_name, previous = name ? this.copyDetails.get(name) : undefined;
    this.flight = flight; this.error = "";
    if (name) this.copyDetails.set(name, immutable({ copies: previous?.copies ?? [], total: previous?.total ?? 0,
      next: previous?.next ?? null, loading: true, notice: "" }));
    this.publish();
    const current = () => !this.stopped && this.flight === flight && flight.revision === this.revision && sameScope(identity, this.ports.context(), true);
    try {
      const result = await this.ports.query(identity.project, "workspace.packages", request.args);
      if (!current()) return;
      if (result.target.identity !== identity.session) throw new Error("The package observation belongs to another R session.");
      if (result.status !== "ready" || !result.data) {
        const notice = result.notices.join("\n") || `Packages ${result.status}.`;
        if (result.status === "busy") { this.error = notice; this.staleValue = true; this.retryRead = request; return; }
        throw new Error(notice);
      }
      const data = result.data as PackageSnapshotData;
      if (!data.observation_id || !Array.isArray(data.groups) || !Array.isArray(data.packages) || data.offset !== request.args.offset)
        throw new Error("The package observation response is incomplete.");
      if ((!request.fresh && data.observation_id !== request.args.observation_id) || data.package_name !== name)
        throw new Error("Package details do not match this observation. Refresh to read it again.");
      if (data.next_offset !== null && (!Number.isSafeInteger(data.next_offset) || data.next_offset <= data.offset))
        throw new Error("The package observation page made no progress.");
      if (name) {
        const copies = request.args.offset ? [...previous?.copies ?? [], ...data.packages] : data.packages;
        this.copyDetails.set(name, immutable({ copies: [...new Map(copies.map((copy) => [packageCopyKey(copy), copy])).values()],
          total: data.total_matches, next: data.next_offset, loading: false, notice: "" }));
        this.detailRequests.delete(name);
      } else {
        if (request.fresh) {
          this.groupIndex.clear(); this.copyDetails.clear(); this.detailRequests.clear();
          this.dataValue = immutable(data); this.sessionValue = identity.session; this.time = data.observed_at_ms || result.observed_at_ms;
          if (this.selectedName) this.detailRequests.set(this.selectedName, { offset: 0 });
        }
        for (const group of data.groups) this.groupIndex.set(group.name, immutable(group));
        this.nextOffset = data.next_offset;
        this.dirtyValue = request.invalidation !== this.invalidation;
        this.staleValue = this.dirtyValue;
      }
      this.retryRead = null; this.error = "";
    } catch (error) {
      if (!current()) return;
      const notice = message(error);
      this.error = notice; this.staleValue = true; this.retryRead = request;
      this.expiredValue = /observation[^\n]*(?:expired|evicted|no longer|not found|changed)|(?:expired|evicted)[^\n]*observation|do not match this observation/i.test(notice);
      if (name) this.copyDetails.set(name, immutable({ copies: previous?.copies ?? [], total: previous?.total ?? 0,
        next: previous?.next ?? null, loading: false, notice }));
      if (!this.expiredValue) throw error;
    } finally {
      if (current()) {
        if (name) { const detail = this.copyDetails.get(name); if (detail?.loading) this.copyDetails.set(name, immutable({ ...detail, loading: false })); }
        this.flight = null; this.publish(); if (this.needsObservation) this.ports.schedule();
      }
    }
  }
}
