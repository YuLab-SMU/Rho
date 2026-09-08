import { Model, immutable, readonlyMap, readonlySet } from "./shared/model";
import { message, sameScope, terminal } from "./shared/ports";
import type { OperationChange, DomainEvents } from "./shared/events";
import type { ResourcePorts } from "./resource-ports";
import type { DirectoryPage } from "./generated/DirectoryPage";
import type { FileSearchResult } from "./generated/FileSearchResult";

interface FilesSnapshot {
  readonly directories: ReadonlyMap<string, DirectoryPage>;
  readonly expanded: ReadonlySet<string>;
  readonly showHidden: boolean;
  readonly scrollTop: number;
  readonly error: string;
  readonly loading: boolean;
  readonly searching: boolean;
  readonly results: FileSearchResult | null;
  readonly filter: string;
  readonly scope: string;
  readonly searchMode: boolean;
  readonly selected: string;
  readonly stale: boolean;
}
interface DirectoryRead { path: string; after: string | null; generation: number; }
interface SearchRead { text: string; showHidden: boolean; generation: number; }
/** Files owns directory and search state; views register intent and never own reads. */
export class Files extends Model<FilesSnapshot> {
  private pages = new Map<string, DirectoryPage>();
  private expandedPaths = new Set<string>([""]);
  private hidden = false;
  private scroll = 0;
  private errorValue = "";
  private resultsValue: FileSearchResult | null = null;
  private filterValue = "";
  private scopeValue = "";
  private mode = false;
  private selectedValue = "";
  private staleValue = true;
  private queued = new Map<string, DirectoryRead>();
  private searchRead: SearchRead | null = null;
  private searchGeneration = 0;
  private directoryGenerations = new Map<string, number>();
  private flight: { revision: number; directory?: DirectoryRead; search?: SearchRead } | null = null;
  private revision = 0;
  private stopped = false;
  constructor(private readonly ports: ResourcePorts) { super(); }
  protected readSnapshot(): FilesSnapshot {
    return { directories: readonlyMap(this.pages), expanded: readonlySet(this.expandedPaths), showHidden: this.hidden,
      scrollTop: this.scroll, error: this.errorValue, loading: !!this.flight, searching: !!this.searchRead || !!this.flight?.search,
      results: this.resultsValue, filter: this.filterValue, scope: this.scopeValue, searchMode: this.mode, selected: this.selectedValue, stale: this.staleValue };
  }
  get directories() { return this.getSnapshot().directories; }
  get expanded() { return this.getSnapshot().expanded; }
  get showHidden() { return this.hidden; }
  get scrollTop() { return this.scroll; }
  get error() { return this.errorValue; }
  get loading() { return !!this.flight; }
  get searching() { return this.getSnapshot().searching; }
  get results() { return this.resultsValue; }
  get filter() { return this.filterValue; }
  get scope() { return this.scopeValue; }
  get searchMode() { return this.mode; }
  get selected() { return this.selectedValue; }
  get needsObservation() { const scope = this.ports.context(); return !this.stopped && !!scope.project && scope.connected && (!!this.searchRead || this.queued.size > 0); }
  serialize() {
    return { expandedDirectories: [...this.expandedPaths], filesScrollTop: this.scroll, showHiddenFiles: this.hidden,
      fileSearch: { filter: this.filterValue, scope: this.scopeValue, mode: this.mode, selected: this.selectedValue } };
  }
  restore(value: unknown) {
    this.reset();
    const data = value as { expandedDirectories?: unknown; filesScrollTop?: unknown; showHiddenFiles?: unknown;
      fileSearch?: { filter?: unknown; scope?: unknown; mode?: unknown; selected?: unknown } } | null;
    if (Array.isArray(data?.expandedDirectories)) for (const path of data.expandedDirectories) if (typeof path === "string") this.expandedPaths.add(path);
    this.hidden = data?.showHiddenFiles === true;
    this.scroll = typeof data?.filesScrollTop === "number" && Number.isFinite(data.filesScrollTop) ? Math.max(0, data.filesScrollTop) : 0;
    const search = data?.fileSearch;
    this.filterValue = typeof search?.filter === "string" ? search.filter : "";
    this.scopeValue = typeof search?.scope === "string" ? search.scope : "";
    this.mode = search?.mode === true;
    this.selectedValue = typeof search?.selected === "string" ? search.selected : "";
    this.refresh();
  }
  reset() {
    this.revision++; this.stopped = false; this.flight = null; this.pages.clear(); this.queued.clear();
    this.expandedPaths = new Set([""]); this.searchRead = null; this.searchGeneration++;
    this.directoryGenerations.clear(); this.resultsValue = null; this.errorValue = ""; this.staleValue = true;
    this.filterValue = ""; this.scopeValue = ""; this.mode = false; this.selectedValue = ""; this.scroll = 0; this.hidden = false;
    this.publish();
  }
  stop() { this.revision++; this.stopped = true; this.flight = null; this.queued.clear(); this.searchRead = null; this.publish(); this.dispose(); }
  private changed() { this.publish(); this.ports.changed(); }
  setFilter(value: string) { this.filterValue = value; this.changed(); }
  setScope(value: string) { this.scopeValue = value; this.changed(); }
  select(path: string) { this.selectedValue = path; this.changed(); }
  setSearchMode(value: boolean) {
    this.mode = value; this.resultsValue = null; this.searchRead = null; this.searchGeneration++; this.changed();
  }
  setScroll(value: number) { this.scroll = value; this.publish(); this.ports.changed(); }
  setShowHidden(value: boolean) { this.hidden = value; this.resultsValue = null; this.searchRead = null; this.searchGeneration++; this.changed(); }
  setError(error: unknown) { this.errorValue = message(error); this.publish(); }
  toggleDirectory(path: string) {
    if (this.expandedPaths.has(path)) this.expandedPaths.delete(path);
    else { this.expandedPaths.add(path); if (!this.pages.has(path)) this.listDirectory(path); }
    this.changed();
  }
  listDirectory(path = "", append = false) { this.queueDirectory(path, append, false); }
  private queueDirectory(path: string, append: boolean, force: boolean) {
    const generation = (this.directoryGenerations.get(path) ?? 0) + 1;
    const after = append ? this.pages.get(path)?.next_name ?? null : null;
    const queued = this.queued.get(path), underway = this.flight?.directory;
    if (!force && (queued?.after === after || (underway?.path === path && underway.after === after))) return;
    this.directoryGenerations.set(path, generation);
    this.queued.set(path, { path, after, generation });
    this.publish(); this.ports.schedule();
  }
  refresh() {
    this.staleValue = true;
    for (const path of this.expandedPaths) this.queueDirectory(path, false, true);
    this.publish();
  }
  search() {
    if (!this.mode || !this.filterValue.trim()) return;
    this.searchRead = { text: this.filterValue, showHidden: this.hidden, generation: ++this.searchGeneration };
    this.errorValue = ""; this.publish(); this.ports.schedule();
  }
  operationChanged(event: OperationChange) {
    const scope = this.ports.context();
    if (event.epoch === scope.epoch && event.project === scope.project && (event.capability.startsWith("workspace.") || event.capability.startsWith("project.")) && terminal(event.status)) this.refresh();
  }
  fileSaved(event: DomainEvents["fileSaved"]) {
    const scope = this.ports.context();
    if (event.epoch !== scope.epoch || event.project !== scope.project) return;
    const directory = event.path.includes("/") ? event.path.slice(0, event.path.lastIndexOf("/")) : "";
    if (this.expandedPaths.has(directory) || this.pages.has(directory)) this.queueDirectory(directory, false, true);
    if (this.mode && this.filterValue.trim()) this.search();
  }
  async observe() {
    const identity = { ...this.ports.context() };
    if (this.stopped || this.flight || !identity.connected || !identity.project) return;
    const search = this.searchRead ?? undefined;
    const directory = search ? undefined : this.queued.values().next().value as DirectoryRead | undefined;
    if (!search && !directory) return;
    const flight = { revision: this.revision, search, directory };
    this.flight = flight; this.errorValue = ""; this.publish();
    const current = () => !this.stopped && this.flight === flight && this.revision === flight.revision && sameScope(identity, this.ports.context());
    const latest = () => current() && (search ? search.generation === this.searchGeneration : directory!.generation === this.directoryGenerations.get(directory!.path));
    try {
      const response = await this.ports.query(identity.project, search ? "project.search_files" : "project.list_directory",
        search ? { text: search.text, show_hidden: search.showHidden } : { path: directory!.path, after_name: directory!.after, limit: 200 });
      if (!latest()) return;
      if (response.status !== "ready" || !response.data) throw new Error(response.notices.join("\n") || "The file observation could not be read.");
      if (search) {
        const result = response.data as FileSearchResult;
        if (!Array.isArray(result.entries)) throw new Error("The file search response is incomplete.");
        this.resultsValue = immutable(result); if (this.searchRead === search) this.searchRead = null;
      } else {
        const page = response.data as DirectoryPage;
        if (page.path !== directory!.path || !Array.isArray(page.entries)) throw new Error("The directory observation identity does not match.");
        const entries = directory!.after ? [...(this.pages.get(page.path)?.entries ?? []), ...page.entries] : page.entries;
        this.pages.set(page.path, immutable({ ...page, entries: [...new Map(entries.map((entry) => [entry.path, entry])).values()] }));
        if (this.queued.get(directory!.path) === directory) this.queued.delete(directory!.path);
      }
      this.staleValue = this.queued.size > 0;
    } catch (error) { if (latest()) { this.errorValue = message(error); throw error; } }
    finally { if (current()) { this.flight = null; this.publish(); if (this.needsObservation) this.ports.schedule(); } }
  }
}
