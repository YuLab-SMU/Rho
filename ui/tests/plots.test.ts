import { expect, it, vi } from "vitest";
import { Plots } from "../src/plots";
import { mediaKey } from "../src/output-ports";
import type { OutputSnapshot } from "../src/output-ports";
import type { MediaReference } from "../src/generated/MediaReference";
const reference = (id: string): MediaReference => ({ operation_id: id, sequence: 1, mime_type: "image/png", byte_size: 2, sha256: `sha256:${"a".repeat(64)}`, display_id: null });
function fixture() {
  let media: readonly MediaReference[] = [], notify = () => {};
  const openPlot = vi.fn(), showPlots = vi.fn(), plots = new Plots({ outputs: { getSnapshot: () => ({ media } as OutputSnapshot), subscribe: (listener) => { notify = listener; return () => {}; } }, newId: () => "comparison", openPlot, showPlots });
  return { plots, openPlot, showPlots, media: (value: MediaReference[]) => { media = value; notify(); } };
}
it("keeps each view's transforms and following independent of mount and layout lifetime", () => {
  const f = fixture(), first = reference("first"), next = reference("next"); f.media([first]);
  const comparison = f.plots.newView(first);
  f.plots.zoom(comparison, mediaKey(first), 2, { x: 0, y: 0 }, { width: 1000, height: 1000 }, { width: 500, height: 500 });
  f.media([first, next]);
  expect(f.plots.view("plots").selected).toBe(mediaKey(next));
  expect(f.plots.view(comparison).selected).toBe(mediaKey(first));
  expect(f.plots.view(comparison).transforms[mediaKey(first)].zoom).toBe(2);
  expect(f.plots.protectedMedia(["plots"])).toEqual(new Set([mediaKey(next)]));
  const saved = f.plots.serialize(); f.plots.restore(saved);
  expect(f.plots.view(comparison).transforms[mediaKey(first)].zoom).toBe(2);
  expect(f.openPlot).toHaveBeenCalledTimes(1);
});
it("restores verified selection without opening a view and keeps explicit Locate behavior", () => {
  const f = fixture(), observed = reference("restored");
  f.plots.restoreSelection(observed);
  expect(f.plots.selectedEvidence()).toEqual(observed); expect(f.showPlots).not.toHaveBeenCalled(); expect(f.openPlot).not.toHaveBeenCalled();
  f.plots.locate(reference("explicitly-located"));
  expect(f.showPlots).toHaveBeenCalledTimes(1); expect(f.plots.selectedEvidence()?.operation_id).toBe("explicitly-located");
});
it("exposes immutable snapshots and does not create state simply by reading a closed view", () => {
  const f = fixture();
  f.plots.view("plots:closed");
  expect(f.plots.getSnapshot().views["plots:closed"]).toBeUndefined();
  expect(() => { (f.plots.view("plots") as { selected: string }).selected = "foreign"; }).toThrow();
  f.plots.ensureView("plots:closed");
  expect(f.plots.getSnapshot().views["plots:closed"]).toBeDefined();
});
it("retains the exact selected evidence while its Outputs history page is still arriving", () => {
  const f = fixture(), observed = reference("queried-original");
  f.plots.locate(observed);
  expect(f.plots.selectedEvidence()).toEqual(observed);
  expect(() => { (f.plots.selectedEvidence() as MediaReference).operation_id = "substitute"; }).toThrow();
  expect(f.plots.selectedEvidence()?.operation_id).toBe("queried-original");
  f.media([observed]);
  expect(f.plots.selectedEvidence()).toEqual(observed);
  f.plots.reset();
  expect(f.plots.selectedEvidence()).toBeNull();
});
