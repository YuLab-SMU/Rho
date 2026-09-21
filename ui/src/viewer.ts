import type { MediaReference } from "./generated/MediaReference";
import { Model } from "./shared/model";
import type { OutputReadPort } from "./output-ports";
import { mediaKey } from "./output-ports";

export interface ViewerSnapshot {
  readonly selected: string | null;
  readonly history: boolean;
}

export interface ViewerPorts {
  outputs: OutputReadPort;
  changed?(): void;
  openViewer?(id: string, name: string): void;
  newId?(): string;
}

/** HTML viewer selection and history visibility. Follows the last HTML output by default. */
export class Viewer extends Model<ViewerSnapshot> {
  private selected: string | null = null;
  private history = true;
  private references = new Map<string, MediaReference>();
  private unsubscribe: () => void;

  constructor(private deps: ViewerPorts) {
    super();
    this.unsubscribe = deps.outputs.subscribe(() => this.outputChanged());
  }

  protected readSnapshot(): ViewerSnapshot {
    return { selected: this.selected, history: this.history };
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
    while (this.references.size > 32) {
      this.references.delete(this.references.keys().next().value!);
    }
  }

  private changed() {
    this.publish();
    this.deps.changed?.();
  }

  private outputChanged() {
    const html = this.deps.outputs.getSnapshot().html;
    const latest = html.length ? mediaKey(html.at(-1)!) : null;
    if (latest && this.selected !== latest) {
      this.selected = latest;
      this.changed();
    }
  }

  select(reference: MediaReference) {
    this.rememberReference(reference);
    this.selected = mediaKey(reference);
    this.changed();
  }

  selectByIndex(index: number) {
    const reference = this.deps.outputs.getSnapshot().html[index];
    if (reference) {
      this.rememberReference(reference);
      this.selected = mediaKey(reference);
      this.changed();
    }
  }

  toggleHistory() {
    this.history = !this.history;
    this.changed();
  }

  openInNewWindow(reference: MediaReference) {
    this.rememberReference(reference);
    const id = `viewer:${this.deps.newId?.() ?? crypto.randomUUID()}`;
    this.deps.openViewer?.(id, `Viewer ${mediaKey(reference).slice(0, 12)}`);
    return id;
  }

  reset() {
    this.selected = null;
    this.history = true;
    this.references.clear();
    this.changed();
  }

  stop() {
    this.unsubscribe();
    this.dispose();
  }
}
