import type { Studio } from "./studio";
import type { PackageSnapshotData } from "./generated/PackageSnapshotData";
import type { PackageQueryArguments } from "./generated/PackageQueryArguments";
import type { PackageQueryMode } from "./generated/PackageQueryMode";
import { message } from "./host-client";

/** A session-scoped read model; no commands or environment mutations. */
export class Packages {
  data: PackageSnapshotData | null = null;
  observedAt: number | null = null;
  session: string | null = null;
  filter = "";
  mode: PackageQueryMode = "installed";
  offset = 0;
  scrollTop = 0;
  visible = false;
  dirty = true;
  loading = false;
  notice = "";
  private revision = 0;
  private observationGeneration = 0;
  constructor(private studio: Studio) {}
  reset() {
    this.revision++;
    this.data = null;
    this.observedAt = null;
    this.session = null;
    this.offset = 0;
    this.loading = false;
    this.dirty = true;
    this.notice = "";
    this.studio.emit("packages");
  }
  invalidate() {
    this.dirty = true;
    this.observationGeneration++;
  }
  select(filter: string, mode = this.mode, offset = 0) {
    this.reset();
    this.filter = filter;
    this.mode = mode;
    this.offset = offset;
    this.scrollTop = 0;
    this.studio.emit("packages");
  }
  async refresh() {
    const s = this.studio,
      project = s.project,
      session = s.runtime?.session_id;
    if (!project || !session || this.loading) return;
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
    if (s.runtime?.state === "busy") {
      this.notice = "R busy — showing the last observation.";
      s.emit("packages");
      return;
    }
    const revision = this.revision,
      generation = this.observationGeneration;
    this.loading = true;
    s.emit("packages");
    try {
      const arguments_: PackageQueryArguments = {
        expected_session: session,
        filter: this.filter,
        mode: this.mode,
        offset: this.offset,
        limit: 100,
      };
      const result = await s.client.query(
        project,
        "workspace.packages",
        arguments_,
      );
      if (
        revision !== this.revision ||
        project !== s.project ||
        session !== s.runtime?.session_id ||
        result.target.identity !== session
      )
        return;
      if (result.status === "ready" && result.data) {
        this.data = result.data as PackageSnapshotData;
        this.session = session;
        this.observedAt = result.observed_at_ms;
        this.notice = "";
        this.dirty = generation !== this.observationGeneration;
      } else {
        this.notice = result.notices.join("\n") || `Packages ${result.status}.`;
        this.dirty = result.status === "busy";
      }
    } catch (error) {
      if (revision === this.revision) {
        this.notice = message(error);
        this.dirty = false;
      }
    } finally {
      if (revision === this.revision) this.loading = false;
      s.emit("packages");
    }
  }
}
