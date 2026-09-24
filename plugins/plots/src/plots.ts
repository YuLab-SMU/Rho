import type { MediaReference } from "../public/r-protocol/index.js";
import { immutable, Model } from "./shared/model.js";
import { mediaKey } from "./output-ports.js";
import type { PlotsDependencies } from "./output-ports.js";
import { constrain, newPlotView, zoomAt } from "./plot-viewport.js";
import type { PlotTransform, PlotView, Size } from "./plot-viewport.js";

export interface PlotsSnapshot {
  readonly views: Readonly<Record<string, PlotView>>;
}
const initialView = immutable(newPlotView());

/** Plot selection and transforms survive the lifetime of every mounted viewer. */
export class Plots extends Model<PlotsSnapshot> {
  private views: Record<string, PlotView> = { plots: initialView };
  private references = new Map<string, MediaReference>();
  private unsubscribe: () => void;
  constructor(private deps: PlotsDependencies) {
    super();
    this.unsubscribe = deps.outputs.subscribe(() => this.outputChanged());
  }
  protected readSnapshot(): PlotsSnapshot { return { views: Object.freeze({ ...this.views }) }; }
  view(id: string): PlotView { return this.views[id] ?? initialView; }
  /** Retain exact identities received from Outputs, including a selection whose
   * history page is still being incorporated by the independent Outputs owner. */
  selectedEvidence(id = "plots"): Readonly<MediaReference> | null {
    const key = this.view(id).selected;
    if (!key) return null;
    const reference = this.references.get(key) ?? this.deps.outputs.getSnapshot().media.find((r) => mediaKey(r) === key);
    return reference ? Object.freeze({ ...reference }) : null;
  }
  private rememberReference(reference: MediaReference) {
    const key = mediaKey(reference);
    this.references.delete(key); this.references.set(key, Object.freeze({ ...reference }));
    while (this.references.size > 64) this.references.delete(this.references.keys().next().value!);
  }
  ensureView(id: string) {
    if (!this.views[id]) {
      const media = this.deps.outputs.getSnapshot().media;
      this.views[id] = immutable({ ...newPlotView(), selected: media.length ? mediaKey(media.at(-1)!) : null, seen: media.length });
      this.changed();
    }
  }
  private changed() { this.publish(); this.deps.changed?.(); }
  private update(id: string, value: Partial<PlotView>, pause = false) {
    this.views[id] = immutable({ ...this.view(id), ...value, ...(pause ? { follow: false, seen: this.deps.outputs.getSnapshot().media.length } : {}) });
    this.changed();
  }
  outputChanged() {
    const media = this.deps.outputs.getSnapshot().media, selected = media.length ? mediaKey(media.at(-1)!) : null;
    let changed = false;
    for (const [id, view] of Object.entries(this.views))
      if (view.follow && !view.pinned && (view.selected !== selected || view.seen !== media.length)) {
        this.views[id] = immutable({ ...view, selected, seen: media.length }); changed = true;
      } else if (view.selected) {
        // A verified Agent selection can arrive before the media index. Once
        // indexed, the selected image is already seen, not a new unread plot.
        const seen = media.findIndex(reference => mediaKey(reference) === view.selected) + 1;
        if (seen > view.seen) { this.views[id] = immutable({ ...view, seen }); changed = true; }
      }
    if (changed) this.changed();
  }
  select(id: string, index: number) {
    const reference = this.deps.outputs.getSnapshot().media[index];
    if (reference) { this.rememberReference(reference); this.update(id, { selected: mediaKey(reference) }, true); }
  }
  latest(id: string) {
    const media = this.deps.outputs.getSnapshot().media;
    if (this.view(id).pinned) return;
    this.update(id, { selected: media.length ? mediaKey(media.at(-1)!) : null, follow: true, seen: media.length });
  }
  toggleHistory(id: string) { this.update(id, { history: !this.view(id).history }); }
  private transform(id: string, key: string, value: PlotTransform, pause = true) {
    this.update(id, { transforms: { ...this.view(id).transforms, [key]: value } }, pause);
  }
  fit(id: string, key: string) { if (key) this.transform(id, key, { zoom: null, x: 0, y: 0 }); }
  zoom(id: string, key: string, scale: number, point: { x: number; y: number }, image: Size, canvas: Size) {
    const current = this.view(id).transforms[key] ?? { zoom: null, x: 0, y: 0 };
    this.transform(id, key, zoomAt(current, scale, point, image, canvas));
  }
  pan(id: string, key: string, point: { x: number; y: number }, image: Size, canvas: Size) {
    const current = this.view(id).transforms[key] ?? { zoom: null, x: 0, y: 0 };
    this.transform(id, key, constrain({ ...current, ...point }, image, canvas));
  }
  constrain(id: string, key: string, image: Size, canvas: Size) {
    const current = this.view(id).transforms[key];
    if (!current || current.zoom === null) return;
    const next = constrain(current, image, canvas);
    if (next.x !== current.x || next.y !== current.y) this.transform(id, key, next, false);
  }
  restoreSelection(reference: MediaReference) {
    this.rememberReference(reference);
    this.update("plots", { selected: mediaKey(reference) }, true);
  }
  pin(reference: MediaReference) {
    this.rememberReference(reference);
    this.update("plots", { selected: mediaKey(reference), follow: false, pinned: true }, true);
  }
  locate(reference: MediaReference) {
    this.restoreSelection(reference);
    this.deps.showPlots?.();
  }
  newView(reference: MediaReference) {
    this.rememberReference(reference);
    const id = `plots:${this.deps.newId?.() ?? crypto.randomUUID()}`;
    this.views[id] = immutable({ ...newPlotView(), selected: mediaKey(reference), follow: false, pinned: true, seen: this.deps.outputs.getSnapshot().media.length });
    this.changed();
    this.deps.openPlot?.(id, `Comparison ${Object.values(this.views).filter((view) => view.pinned).length}`);
    return id;
  }
  protectedMedia(activeViewIds: readonly string[]): ReadonlySet<string> {
    return new Set(activeViewIds.flatMap((id) => this.views[id]?.selected ? [this.views[id].selected!] : []));
  }
  retainedReferences(): readonly string[] { return [...new Set(Object.values(this.views).flatMap((view) => view.selected ? [view.selected] : []))]; }
  serialize() {
    return { plotViews: structuredClone(this.views) };
  }
  restore(data: unknown) {
    this.references.clear();
    const value = data as { plotViews?: Record<string, PlotView> } | null;
    this.views = Object.create(null);
    for (const [id, saved] of Object.entries(value?.plotViews ?? {})) {
      if (!saved || typeof saved !== "object") continue;
      const transforms: Record<string, PlotTransform> = Object.create(null);
      for (const [key, transform] of Object.entries(saved.transforms ?? {}))
        if (transform && (transform.zoom === null || Number.isFinite(transform.zoom)) && Number.isFinite(transform.x) && Number.isFinite(transform.y))
          transforms[key] = { zoom: transform.zoom === null ? null : Math.min(8, Math.max(0.01, transform.zoom)), x: transform.x, y: transform.y };
      this.views[id] = immutable({ selected: typeof saved.selected === "string" ? saved.selected : null, follow: saved.follow !== false, pinned: saved.pinned === true, history: saved.history !== false, seen: Number.isFinite(saved.seen) ? Math.max(0, Math.floor(saved.seen)) : 0, transforms });
    }
    if (!this.views.plots) this.views.plots = immutable(newPlotView());
    this.publish();
  }
  reset() { this.restore(null); }
  stop() { this.unsubscribe(); this.dispose(); }
}
