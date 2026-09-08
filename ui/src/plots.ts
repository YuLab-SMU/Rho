import type { MediaReference } from "./generated/MediaReference";
import { immutable, Model } from "./shared/model";
import { mediaKey } from "./output-ports";
import type { PlotsDependencies } from "./output-ports";
import { constrain, newPlotView, zoomAt } from "./plot-viewport";
import type { PlotTransform, PlotView, Size } from "./plot-viewport";

export interface PlotsSnapshot {
  readonly views: Readonly<Record<string, PlotView>>;
}
const initialView = immutable(newPlotView());

/** Plot selection and transforms survive the lifetime of every mounted viewer. */
export class Plots extends Model<PlotsSnapshot> {
  private views: Record<string, PlotView> = { plots: initialView };
  private unsubscribe: () => void;
  constructor(private deps: PlotsDependencies) {
    super();
    this.unsubscribe = deps.outputs.subscribe(() => this.outputChanged());
  }
  protected readSnapshot(): PlotsSnapshot { return { views: Object.freeze({ ...this.views }) }; }
  view(id: string): PlotView { return this.views[id] ?? initialView; }
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
      }
    if (changed) this.changed();
  }
  select(id: string, index: number) {
    const reference = this.deps.outputs.getSnapshot().media[index];
    if (reference) this.update(id, { selected: mediaKey(reference) }, true);
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
  locate(reference: MediaReference) {
    this.update("plots", { selected: mediaKey(reference) }, true);
    this.deps.showPlots?.();
  }
  newView(reference: MediaReference) {
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
    const main = this.view("plots");
    return { plotViews: structuredClone(this.views), selectedPlot: main.selected, plotZoom: main.selected ? main.transforms[main.selected]?.zoom ?? null : null };
  }
  restore(data: unknown) {
    const value = data as { plotViews?: Record<string, PlotView>; selectedPlot?: string | null; plotZoom?: number | null } | null;
    this.views = {};
    for (const [id, saved] of Object.entries(value?.plotViews ?? {})) {
      if (!saved || typeof saved !== "object") continue;
      const transforms: Record<string, PlotTransform> = {};
      for (const [key, transform] of Object.entries(saved.transforms ?? {}))
        if (transform && (transform.zoom === null || Number.isFinite(transform.zoom)) && Number.isFinite(transform.x) && Number.isFinite(transform.y))
          transforms[key] = { zoom: transform.zoom === null ? null : Math.min(8, Math.max(0.01, transform.zoom)), x: transform.x, y: transform.y };
      this.views[id] = immutable({ selected: typeof saved.selected === "string" ? saved.selected : null, follow: saved.follow !== false, pinned: saved.pinned === true, history: saved.history !== false, seen: Math.max(0, Number(saved.seen) || 0), transforms });
    }
    if (!this.views.plots) {
      const selected = typeof value?.selectedPlot === "string" ? value.selectedPlot : null;
      this.views.plots = immutable({ ...newPlotView(), selected, follow: !selected, transforms: selected && Number.isFinite(value?.plotZoom) ? { [selected]: { zoom: Math.min(8, Math.max(0.01, value!.plotZoom!)), x: 0, y: 0 } } : {} });
    }
    this.publish();
  }
  reset() { this.restore(null); }
  stop() { this.unsubscribe(); this.dispose(); }
}
