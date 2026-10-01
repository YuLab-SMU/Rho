import type { HelpFormat, PackageFileIdentity, PackageHelpPage, PackageIndexArguments,
  PackageIndexPage, ReadPackageHelpArguments, RInspection } from "../public/r-protocol/index.js";
import { Model, immutable } from "./shared/model.js";

/** The selected installed copy and observation are immutable for this view. */
export interface HelpCopy {
  nativeSession: string;
  observation: string;
  package: string;
  libraryPath: string;
  version: string;
}
export interface HelpPorts {
  session(): string | null;
  query<T>(id: "r.package_index" | "r.read_help", args: PackageIndexArguments | ReadPackageHelpArguments): Promise<RInspection<T>>;
  schedule(): void;
  changed(): void;
}
export interface HelpChoices { indexKind: "topic" | "alias"; filter: string; topic: string | null; format: HelpFormat; raw: boolean; indexVisible: boolean; scrollTop: number; }
export interface HelpSnapshot extends HelpChoices {
  copy: Readonly<HelpCopy>;
  index: Readonly<PackageIndexPage> | null;
  page: Readonly<PackageHelpPage> | null;
  loading: boolean;
  staleIndex: boolean;
  notice: string;
  requiresNewObservation: boolean;
}
const bytes = (text: string) => new TextEncoder().encode(text).length;
const sameFiles = (a: readonly PackageFileIdentity[], b: readonly PackageFileIdentity[]) =>
  a.length === b.length && a.every((file, index) => file.path === b[index].path && file.digest === b[index].digest);
const validFiles = (files: PackageFileIdentity[]) => Array.isArray(files) && files.length === 4 &&
  files.every(file => file && typeof file.path === "string" && file.path.length > 0 && file.path.length <= 128 &&
    typeof file.digest === "string" && file.digest.length > 0 && file.digest.length <= 32768) &&
  new Set(files.map(file => file.path)).size === 4;
const invalidating = new Set(["observation_expired", "observation_invalid", "content_changed"]);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Exact-copy static reads only. No namespace load, execution, source retargeting
 * or automatic replacement of an expired observation is available here. */
export class Help extends Model<HelpSnapshot> {
  readonly copy: Readonly<HelpCopy>;
  private choices: HelpChoices = { indexKind: "topic", filter: "", topic: null, format: "html", raw: false, indexVisible: true, scrollTop: 0 };
  private index: Readonly<PackageIndexPage> | null = null;
  private page: Readonly<PackageHelpPage> | null = null;
  private indexReference: string | null = null;
  private files: PackageFileIdentity[] | null = null;
  private offset = 0;
  private indexDirty = true;
  private pageDirty = false;
  private indexGeneration = 0;
  private pageGeneration = 0;
  private flight: Promise<void> | null = null;
  private notice = "";
  private requiresNewObservation = false;
  private stopped = false;
  constructor(private readonly ports: HelpPorts, copy: HelpCopy, saved?: unknown) {
    super();
    if (!copy || !/^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(copy.package) ||
      ![copy.nativeSession, copy.observation, copy.libraryPath, copy.version].every(value => typeof value === "string" && value.length > 0 && !value.includes("\0")) ||
      bytes(copy.libraryPath) > 16384 || bytes(copy.nativeSession) > 160 || bytes(copy.observation) > 160 || bytes(copy.version) > 256)
      throw new Error("Help requires one exact observed installed package copy.");
    this.copy = immutable(structuredClone(copy));
    const choices = saved as Partial<HelpChoices> | null;
    if (choices?.indexKind === "alias") this.choices.indexKind = "alias";
    if (typeof choices?.filter === "string" && bytes(choices.filter) <= 128 && !choices.filter.includes("\0")) this.choices.filter = choices.filter;
    if (typeof choices?.topic === "string" && this.validTopic(choices.topic)) { this.choices.topic = choices.topic; this.pageDirty = true; this.choices.indexVisible = false; }
    if (typeof choices?.indexVisible === "boolean") this.choices.indexVisible = choices.indexVisible;
    if (typeof choices?.raw === "boolean") this.choices.raw = choices.raw;
    if (choices?.format === "text") this.choices.format = "text";
    if (typeof choices?.scrollTop === "number" && Number.isFinite(choices.scrollTop) && choices.scrollTop >= 0) this.choices.scrollTop = choices.scrollTop;
  }
  protected readSnapshot(): HelpSnapshot {
    return { ...this.choices, copy: this.copy, index: this.index, page: this.page, loading: this.flight !== null,
      staleIndex: this.indexDirty, notice: this.notice, requiresNewObservation: this.requiresNewObservation };
  }
  serialize(): HelpChoices { return { ...this.choices }; }
  get needsObservation() { return !this.stopped && !this.requiresNewObservation && (this.indexDirty || this.pageDirty); }
  private changed() { this.publish(); this.ports.changed(); }
  private validTopic(topic: string) { return !!topic.trim() && bytes(topic) <= 128 && !/[\u0000-\u001f\u007f]/.test(topic); }
  search(filter: string) {
    if (bytes(filter) > 128 || filter.includes("\0")) throw new Error("Help search exceeds 128 UTF-8 bytes or contains a NUL.");
    if (filter === this.choices.filter) return;
    this.choices.filter = filter; this.offset = 0; this.indexDirty = true; this.indexGeneration++;
    this.changed(); this.ports.schedule();
  }
  setIndexKind(kind: "topic" | "alias") {
    if (!["topic", "alias"].includes(kind) || kind === this.choices.indexKind) return;
    this.choices.indexKind = kind; this.offset = 0; this.indexDirty = true; this.indexGeneration++;
    this.changed(); this.ports.schedule();
  }
  indexPage(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !this.index || offset > this.index.total)
      throw new Error("Select an observed package index page.");
    this.offset = offset; this.indexDirty = true; this.indexGeneration++; this.publish(); this.ports.schedule();
  }
  open(topic: string, format: HelpFormat = this.choices.format) {
    if (!this.validTopic(topic) || !["html", "text"].includes(format)) throw new Error("Select a bounded Help topic and format.");
    if (topic === this.choices.topic && format === this.choices.format && this.page?.complete) { this.setIndexVisible(false); return; }
    this.choices = { ...this.choices, topic, format, indexVisible: false, scrollTop: 0 };
    this.page = null; this.pageDirty = true; this.pageGeneration++;
    if (!this.requiresNewObservation) this.notice = "";
    this.changed(); this.ports.schedule();
  }
  setIndexVisible(visible: boolean) { this.choices.indexVisible = visible; this.changed(); }
  setRaw(raw: boolean) { this.choices.raw = raw; this.changed(); }
  setScroll(top: number) {
    if (!Number.isFinite(top) || top < 0) return;
    this.choices.scrollTop = top; this.changed();
  }
  /** Retry the same original read. An expired copy needs an explicit selection
   * from a new Packages observation, never an implicit same-name lookup. */
  retry() { if (!this.requiresNewObservation) { this.notice = ""; this.publish(); this.ports.schedule(); } }
  private reject(reason: string, invalid = false): never {
    if (invalid) this.requiresNewObservation = true;
    throw new Error(reason);
  }
  private ready<T>(result: RInspection<T>): T | null {
    if (result.session_id !== this.copy.nativeSession) this.reject("Help returned a different native session.", true);
    if (result.status !== "ready" || result.data === null) {
      const code = result.diagnostic?.code;
      if (code && invalidating.has(code)) this.requiresNewObservation = true;
      this.notice = result.diagnostic?.message || result.notices.join("\n") || `Help is ${result.status}.`;
      return null;
    }
    return result.data;
  }
  private identity(result: { observation_id: string; package: string; library_path: string; version: string | null }) {
    if (result.observation_id !== this.copy.observation || result.package !== this.copy.package ||
      result.library_path !== this.copy.libraryPath || result.version !== this.copy.version)
      this.reject("Help no longer matches the original observed package copy.", true);
  }
  /** One bounded read per call. The connection controls polling and busy backoff. */
  observe(): Promise<void> {
    if (this.flight) return this.flight;
    if (!this.needsObservation) return Promise.resolve();
    const task = Promise.resolve().then(async () => {
      if (this.stopped) return;
      if (this.ports.session() !== this.copy.nativeSession) this.reject("The original R session is unavailable. Help was not retargeted.", true);
      if (this.indexDirty) await this.readIndex();
      else if (this.pageDirty) await this.readPage();
    }).catch(error => { if (!this.stopped) this.notice = message(error); })
      .finally(() => { this.flight = null; if (!this.stopped) this.publish(); });
    this.flight = task; this.publish(); return task;
  }
  private async readIndex() {
    const generation = this.indexGeneration, copy = this.copy;
    const args: PackageIndexArguments = { expected_session: copy.nativeSession, observation_id: copy.observation,
      package: copy.package, library_path: copy.libraryPath, index_ref: this.indexReference,
      filter: this.choices.filter, kind: this.choices.indexKind, offset: this.offset, limit: 100 };
    let result: RInspection<PackageIndexPage>;
    try { result = await this.ports.query<PackageIndexPage>("r.package_index", args); }
    catch (error) { if (this.stopped || generation !== this.indexGeneration) return; throw error; }
    if (this.stopped || generation !== this.indexGeneration) return;
    if (this.ports.session() !== copy.nativeSession) this.reject("The R session changed while reading Help.", true);
    const page = this.ready(result); if (!page) return;
    this.identity(page);
    if (typeof page.index_ref !== "string" || !page.index_ref || !validFiles(page.files) ||
      this.indexReference !== null && page.index_ref !== this.indexReference || this.files && !sameFiles(this.files, page.files) ||
      page.offset !== args.offset || !Number.isSafeInteger(page.total) || page.total < page.offset ||
      !Array.isArray(page.entries) || page.entries.length > args.limit || page.offset + page.entries.length > page.total ||
      (page.next_offset === null ? page.offset + page.entries.length !== page.total :
        page.next_offset !== page.offset + page.entries.length || page.entries.length === 0 || page.next_offset >= page.total))
      this.reject("The package index returned inconsistent identities or pagination.", true);
    this.indexReference = page.index_ref; this.files = structuredClone(page.files);
    this.index = immutable(structuredClone(page)); this.indexDirty = false; this.notice = page.notices.join("\n");
  }
  private async readPage() {
    const copy = this.copy, generation = this.pageGeneration, previous = this.page;
    if (!this.files || !this.choices.topic) return;
    const args: ReadPackageHelpArguments = { expected_session: copy.nativeSession, observation_id: copy.observation,
      package: copy.package, library_path: copy.libraryPath, topic: this.choices.topic, expected_index_files: structuredClone(this.files),
      expected_help_files: previous ? structuredClone(previous.help_files) : null,
      offset_utf8: previous?.next_offset_utf8 ?? 0, limit_bytes: 32768, format: this.choices.format };
    let result: RInspection<PackageHelpPage>;
    try { result = await this.ports.query<PackageHelpPage>("r.read_help", args); }
    catch (error) { if (this.stopped || generation !== this.pageGeneration) return; throw error; }
    if (this.stopped || generation !== this.pageGeneration) return;
    if (this.ports.session() !== copy.nativeSession) this.reject("The R session changed while reading Help.", true);
    const page = this.ready(result); if (!page) return;
    this.identity(page);
    const size = typeof page.text === "string" ? bytes(page.text) : -1;
    if (page.topic !== args.topic || page.format !== args.format || !validFiles(page.help_files) ||
      typeof page.found !== "boolean" || !page.found && (page.total_bytes !== 0 || !page.complete || size !== 0) ||
      previous && (!sameFiles(previous.help_files, page.help_files) || page.total_bytes !== previous.total_bytes || page.found !== previous.found) ||
      page.offset_utf8 !== args.offset_utf8 || size < 0 || size > args.limit_bytes || !Number.isSafeInteger(page.total_bytes) ||
      page.total_bytes < args.offset_utf8 + size || page.total_bytes > 16 * 1024 * 1024 ||
      (page.next_offset_utf8 === null ? !page.complete || args.offset_utf8 + size !== page.total_bytes :
        page.complete || size === 0 || page.next_offset_utf8 !== args.offset_utf8 + size || page.next_offset_utf8 >= page.total_bytes))
      this.reject("The Help content changed or returned an invalid UTF-8 continuation.", true);
    // Partial markup is retained as an explicitly incomplete raw document. A
    // renderer must wait for complete before presenting it as formatted HTML.
    this.page = immutable({ ...structuredClone(page), text: (previous?.text ?? "") + page.text, offset_utf8: 0 });
    this.pageDirty = !page.complete;
    this.notice = !page.found ? `No Help topic ${page.topic} in this observed copy.` : page.complete ? "" : "Reading the remaining Help content…";
  }
  stop() { this.stopped = true; this.dispose(); }
}
