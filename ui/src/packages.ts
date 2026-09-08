import type { Studio } from "./studio";
import type { PackageSnapshotData } from "./generated/PackageSnapshotData";
import type { PackageQueryArguments } from "./generated/PackageQueryArguments";
import type { PackageGroup } from "./generated/PackageGroup";
import type { PackageEntry } from "./generated/PackageEntry";
import { message } from "./host-client";

export type PackageView = "installed" | "loaded" | "attached" | "multiple";
export interface PackageDetails {
  copies: PackageEntry[];
  total: number;
  next: number | null;
  loading: boolean;
  notice: string;
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

/** One session-scoped observation; filtering never changes native state. */
export class Packages {
  data: PackageSnapshotData | null = null;
  observedAt: number | null = null;
  session: string | null = null;
  groups = new Map<string, PackageGroup>();
  details = new Map<string, PackageDetails>();
  filter = "";
  mode: PackageView = "installed";
  descending = false;
  offset = 0;
  scrollTop = 0;
  selected: string | null = null;
  sourceCopy: string | null = null;
  inspectorMode: "overview" | "source" = "overview";
  visible = false;
  dirty = true;
  loading = false;
  notice = "";
  next: number | null = null;
  private revision = 0;
  private observationGeneration = 0;
  constructor(private studio: Studio) {}
  reset() {
    this.revision++;
    this.data = null;
    this.observedAt = null;
    this.session = null;
    this.groups.clear();
    this.details.clear();
    this.selected = null;
    this.sourceCopy = null;
    this.inspectorMode = "overview";
    this.offset = 0;
    this.scrollTop = 0;
    this.next = null;
    this.loading = false;
    this.dirty = true;
    this.notice = "";
    this.studio.emit("packages");
  }
  invalidate() {
    this.dirty = true;
    this.observationGeneration++;
  }
  select(filter: string, mode: PackageView = this.mode, offset = 0) {
    this.filter = filter;
    this.mode = mode;
    this.offset = offset;
    this.scrollTop = 0;
    if (
      this.selected &&
      !this.filtered.some((group) => group.name === this.selected)
    ) {
      this.selected = null;
      this.inspectorMode = "overview";
      this.sourceCopy = null;
    }
    this.studio.emit("packages");
  }
  get filtered(): PackageGroup[] {
    const filter = this.filter.toLocaleLowerCase();
    return [...this.groups.values()]
      .filter(
        (group) =>
          (this.mode === "installed" ||
            (this.mode === "loaded" && group.loaded_version !== null) ||
            (this.mode === "attached" && group.attached) ||
            (this.mode === "multiple" && group.copy_count > 1)) &&
          `${group.name} ${group.title ?? ""}`
            .toLocaleLowerCase()
            .includes(filter),
      )
      .sort(
        (a, b) => (this.descending ? -1 : 1) * a.name.localeCompare(b.name),
      );
  }
  get page() {
    return this.filtered.slice(this.offset, this.offset + 100);
  }
  get completeIndex() {
    return !!this.data && this.groups.size === this.data.counts.all;
  }
  get needsObservation() {
    return (
      this.dirty ||
      this.next !== null ||
      (!!this.selected && !this.details.has(this.selected))
    );
  }
  pick(name: string, toggle = false) {
    this.selected = toggle && this.selected === name ? null : name;
    this.inspectorMode = "overview";
    this.sourceCopy = null;
    this.studio.emit("packages");
    if (this.selected) void this.inspect(this.selected);
  }
  async refresh() {
    const s = this.studio,
      project = s.project,
      session = s.runtime?.session_id;
    if (
      !project ||
      !session ||
      this.loading ||
      s.runtime?.state === "unavailable"
    )
      return;
    if (
      !s.info?.capabilities.some(
        (c) => c.capability.id === "workspace.packages",
      )
    ) {
      this.notice = "Package observation is unavailable for this Host.";
      this.dirty = false;
      s.emit("packages");
      return;
    }
    if (s.runtime?.state === "busy") return;
    const revision = this.revision,
      generation = this.observationGeneration;
    const current = () =>
      revision === this.revision &&
      project === s.project &&
      session === s.runtime?.session_id;
    this.loading = true;
    this.notice = "";
    let fresh = this.dirty || !this.data;
    try {
      if (fresh || this.next !== null) {
        do {
          const args: PackageQueryArguments = {
            expected_session: session,
            filter: "",
            mode: "installed",
            grouped: true,
            observation_id: fresh ? null : this.data!.observation_id,
            package_name: null,
            offset: fresh ? 0 : this.next!,
            limit: 200,
          };
          const result = await s.client.query(
            project,
            "workspace.packages",
            args,
          );
          if (!current() || result.target.identity !== session) return;
          if (result.status !== "ready" || !result.data) {
            this.notice =
              result.notices.join("\n") || `Packages ${result.status}.`;
            if (result.status !== "busy") this.next = null;
            break;
          }
          const data = result.data as PackageSnapshotData;
          if (!data.observation_id || !Array.isArray(data.groups)) {
            this.notice =
              "Restart Workbench with the current build to use this package view.";
            this.dirty = false;
            break;
          }
          if (!fresh && data.observation_id !== this.data!.observation_id)
            throw new Error(
              "The package observation changed. Refresh to read it again.",
            );
          if (fresh) {
            this.groups.clear();
            this.details.clear();
            this.data = data;
            this.session = session;
            this.observedAt = data.observed_at_ms || result.observed_at_ms;
            fresh = false;
          }
          for (const group of data.groups) this.groups.set(group.name, group);
          this.next = data.next_offset;
          this.dirty = generation !== this.observationGeneration;
          s.emit("packages");
          if (this.dirty) break;
        } while (this.next !== null && this.visible);
      }
      if (current() && this.selected && !this.dirty)
        await this.inspect(this.selected);
    } catch (error) {
      if (current()) {
        this.notice = message(error);
        this.next = null;
        this.dirty = false;
      }
    } finally {
      if (revision === this.revision) this.loading = false;
      s.emit("packages");
    }
  }
  async inspect(name: string, more = false) {
    const s = this.studio,
      project = s.project,
      session = this.session,
      observation = this.data?.observation_id;
    const previous = this.details.get(name);
    if (
      !project ||
      !session ||
      !observation ||
      s.runtime?.state === "busy" ||
      previous?.loading ||
      (previous && !more)
    )
      return;
    const revision = this.revision;
    const detail: PackageDetails = {
      copies: more ? (previous?.copies ?? []) : [],
      total: 0,
      next: null,
      loading: true,
      notice: "",
    };
    this.details.set(name, detail);
    s.emit("packages");
    try {
      const args: PackageQueryArguments = {
        expected_session: session,
        filter: "",
        mode: "installed",
        grouped: true,
        observation_id: observation,
        package_name: name,
        offset: more ? (previous?.next ?? 0) : 0,
        limit: 20,
      };
      const result = await s.client.query(project, "workspace.packages", args);
      if (
        revision !== this.revision ||
        observation !== this.data?.observation_id ||
        project !== s.project ||
        session !== s.runtime?.session_id ||
        result.target.identity !== session
      )
        return;
      if (result.status === "ready" && result.data) {
        const data = result.data as PackageSnapshotData;
        if (data.observation_id !== observation || data.package_name !== name)
          throw new Error("Package details do not match this observation.");
        detail.copies = [...detail.copies, ...data.packages];
        detail.total = data.total_matches;
        detail.next = data.next_offset;
      } else if (result.status === "busy") {
        this.details.delete(name);
      } else
        detail.notice =
          result.notices.join("\n") ||
          "Package details unavailable. Refresh to try again.";
    } catch (error) {
      detail.notice = message(error);
    } finally {
      detail.loading = false;
      s.emit("packages");
    }
  }
}
