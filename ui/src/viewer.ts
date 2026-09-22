import type { HtmlViewToken } from "./generated/HtmlViewToken";
import type { MediaReference } from "./generated/MediaReference";
import { Model } from "./shared/model";
import type { OutputReadPort } from "./output-ports";
import { mediaKey } from "./output-ports";
import type { RequestContext } from "./shared/ports";
import { sameScope } from "./shared/ports";

export interface ViewerSnapshot {
  readonly selected: string | null;
  readonly history: boolean;
  readonly path: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface ViewerPorts {
  outputs: OutputReadPort;
  context(): RequestContext;
  htmlViewToken(project: string, reference: MediaReference): Promise<HtmlViewToken>;
  changed?(): void;
  openViewer?(id: string, name: string): void;
  newId?(): string;
}

type ViewPath = { path: string; expiresAt: number };

/** HTML viewer selection, capability delivery, and history visibility. */
export class Viewer extends Model<ViewerSnapshot> {
  private selected: string | null = null;
  private follow = true;
  private history = true;
  private references = new Map<string, MediaReference>();
  private paths = new Map<string, ViewPath>();
  private requests = new Map<string, number>();
  private loadingKey: string | null = null;
  private error: string | null = null;
  private generation = 0;
  private unsubscribe: () => void;

  constructor(private deps: ViewerPorts) {
    super();
    this.unsubscribe = deps.outputs.subscribe(() => this.outputChanged());
  }

  protected readSnapshot(): ViewerSnapshot {
    const path = this.selected ? this.paths.get(this.selected) : undefined;
    return {
      selected: this.selected,
      history: this.history,
      path: path && path.expiresAt > Date.now() ? path.path : null,
      loading: this.loadingKey !== null,
      error: this.error,
    };
  }

  selectedReference(): Readonly<MediaReference> | null {
    if (!this.selected) return null;
    const reference = this.references.get(this.selected) ??
      this.deps.outputs.getSnapshot().html.find((r) => mediaKey(r) === this.selected);
    return reference ? Object.freeze({ ...reference }) : null;
  }

  private rememberReference(reference: MediaReference) {
    const key = mediaKey(reference);
    this.references.delete(key);
    this.references.set(key, Object.freeze({ ...reference }));
    while (this.references.size > 32) this.references.delete(this.references.keys().next().value!);
  }

  private changed() {
    this.publish();
    this.deps.changed?.();
  }

  private outputChanged() {
    const html = this.deps.outputs.getSnapshot().html;
    const latest = html.length ? html.at(-1)! : null;
    if (this.follow && latest && this.selected !== mediaKey(latest)) {
      this.rememberReference(latest);
      this.selected = mediaKey(latest);
      this.error = null;
      this.changed();
    }
  }

  select(reference: MediaReference) {
    if (reference.mime_type !== "text/html") return;
    this.rememberReference(reference);
    this.selected = mediaKey(reference);
    this.follow = false;
    this.error = null;
    this.changed();
  }

  selectByIndex(index: number) {
    const reference = this.deps.outputs.getSnapshot().html[index];
    if (reference) this.select(reference);
  }

  toggleHistory() {
    this.history = !this.history;
    this.changed();
  }

  async ensurePath(reference: MediaReference, refresh = false) {
    const key = mediaKey(reference);
    this.rememberReference(reference);
    const cached = this.paths.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now() + 1000) {
      if (this.selected === key && this.error) { this.error = null; this.changed(); }
      return;
    }
    const current = this.requests.get(key);
    if (current !== undefined && !refresh) return;
    const context = this.deps.context();
    if (!context.project) {
      this.error = "Select a project before opening HTML output.";
      this.changed();
      return;
    }
    const generation = this.generation;
    const request = (this.requests.get(key) ?? 0) + 1;
    this.requests.set(key, request);
    this.loadingKey = key;
    this.error = null;
    this.changed();
    try {
      const token = await this.deps.htmlViewToken(context.project, reference);
      if (generation !== this.generation || !sameScope(context, this.deps.context()) || this.requests.get(key) !== request) return;
      this.paths.set(key, { path: token.path, expiresAt: token.expires_at_ms });
      this.error = null;
    } catch (error) {
      if (generation !== this.generation || !sameScope(context, this.deps.context()) || this.requests.get(key) !== request) return;
      this.paths.delete(key);
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation && this.requests.get(key) === request) {
        this.requests.delete(key);
        if (this.loadingKey === key) this.loadingKey = null;
        this.changed();
      }
    }
  }

  refresh(reference: MediaReference) {
    this.paths.delete(mediaKey(reference));
    void this.ensurePath(reference, true);
  }

  openInNewWindow(reference: MediaReference) {
    this.rememberReference(reference);
    const id = `viewer:${this.deps.newId?.() ?? crypto.randomUUID()}`;
    this.deps.openViewer?.(id, `Viewer ${mediaKey(reference).slice(0, 12)}`);
    return id;
  }

  serialize() {
    return { selected: this.selected, follow: this.follow, history: this.history };
  }

  restore(value: unknown) {
    const saved = value as { selected?: unknown; follow?: unknown; history?: unknown } | null;
    this.selected = typeof saved?.selected === "string" ? saved.selected : null;
    this.follow = saved?.follow !== false;
    this.history = saved?.history !== false;
    this.references.clear();
    this.paths.clear();
    this.error = null;
    this.publish();
  }

  reset() {
    this.generation++;
    this.selected = null;
    this.follow = true;
    this.history = true;
    this.references.clear();
    this.paths.clear();
    this.requests.clear();
    this.loadingKey = null;
    this.error = null;
    this.changed();
  }

  stop() {
    this.generation++;
    this.requests.clear();
    this.unsubscribe();
    this.dispose();
  }
}
