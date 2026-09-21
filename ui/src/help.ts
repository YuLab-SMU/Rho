import type { QueryPort, RequestContext } from "./shared/ports";
import { Model } from "./shared/model";
import type { PackageHelpPage } from "./generated/PackageHelpPage";

export interface HelpSnapshot {
  readonly topic: string | null;
  readonly page: PackageHelpPage | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface HelpPorts {
  context(): RequestContext;
  query: QueryPort;
  changed?(): void;
  schedule?(): void;
}

/** Help HTML reader for the current selected topic across all workspace instances. */
export class Help extends Model<HelpSnapshot> {
  private topic: string | null = null;
  private page: PackageHelpPage | null = null;
  private loading = false;
  private error: string | null = null;
  private request: { package: string; topic: string; library: string; session: string } | null = null;

  constructor(private ports: HelpPorts) {
    super();
  }

  protected readSnapshot(): HelpSnapshot {
    return { topic: this.topic, page: this.page, loading: this.loading, error: this.error };
  }

  private changed() {
    this.publish();
    this.ports.changed?.();
  }

  async open(pkg: string, topic: string, libraryPath: string, session: string) {
    const key = `${libraryPath}:${pkg}:${topic}`;
    if (this.topic === key && this.page && this.page.package === pkg && this.page.topic === topic) return;
    this.topic = key;
    this.page = null;
    this.loading = true;
    this.error = null;
    this.request = { package: pkg, topic, library: libraryPath, session };
    this.changed();
    this.ports.schedule?.();
  }

  async observe() {
    if (!this.request || !this.loading) return;
    const { package: pkg, topic, library, session } = this.request;
    const context = this.ports.context();
    if (!context.project || context.session !== session) {
      this.loading = false;
      this.error = "The R session changed; this help topic may be unavailable.";
      this.changed();
      return;
    }
    try {
      const data = await this.ports.query(context.project, "workspace.read_help", {
        package: pkg,
        topic,
        library_path: library,
        expected_session: session,
        format: "html",
        limit_bytes: 524288,
        offset_utf8: 0,
      });
      const page = data.data as PackageHelpPage;
      if (!page.found) {
        this.error = `Help topic ${topic} is not documented in ${pkg}`;
        this.page = null;
      } else {
        this.page = page;
        this.error = null;
      }
      this.loading = false;
      this.changed();
    } catch (e) {
      this.loading = false;
      this.error = e instanceof Error ? e.message : String(e);
      this.changed();
    }
  }

  reset() {
    this.topic = null;
    this.page = null;
    this.loading = false;
    this.error = null;
    this.request = null;
    this.changed();
  }

  stop() {
    this.dispose();
  }
}
