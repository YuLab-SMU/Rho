import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Actions, Layout } from "flexlayout-react";
import type { Action, Model } from "flexlayout-react";
import { PluginFrameLayer } from "./plugin-frame-layer";
import type { PluginFrameContent, PluginFrameRegion } from "./plugin-frame-layer";

/** Docking owns empty slots; the stable sibling layer owns live iframe DOM. All
 * lifecycle decisions (including saved state before close) belong to the caller. */
export function PluginLayoutHost({ model, frames, changed, close }: {
  model: Model;
  frames: readonly PluginFrameContent[];
  changed(action: Action): void;
  close(view: string): void;
}) {
  const container = useRef<HTMLDivElement>(null), dock = useRef<HTMLDivElement>(null);
  const [regions, setRegions] = useState<ReadonlyMap<string, PluginFrameRegion>>(new Map());
  const [dragging, setDragging] = useState(false);
  const schedule = useRef(() => {});
  useLayoutEffect(() => {
    let frame = 0, stopped = false;
    const measure = () => {
      frame = 0;
      if (stopped || !container.current || !dock.current) return;
      const origin = container.current.getBoundingClientRect(), next = new Map<string, PluginFrameRegion>();
      for (const element of dock.current.querySelectorAll<HTMLElement>("[data-plugin-slot]")) {
        const rect = element.getBoundingClientRect();
        // Hidden tabs have no client rect. Their frames stay mounted and inert.
        if (rect.width > 0 && rect.height > 0 && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden")
          next.set(element.dataset.pluginSlot!, { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height });
      }
      setRegions(previous => previous.size === next.size && [...next].every(([id, rect]) => {
        const before = previous.get(id);
        return before && before.x === rect.x && before.y === rect.y && before.width === rect.width && before.height === rect.height;
      }) ? previous : next);
    };
    schedule.current = () => { if (!stopped && !frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(() => schedule.current());
    if (container.current) resize.observe(container.current);
    // Docking positions panels imperatively, including same-size tab moves that
    // do not trigger ResizeObserver. Observe only its tree, never plugin DOM.
    const position = new MutationObserver(() => schedule.current());
    if (dock.current) position.observe(dock.current, { childList: true, attributes: true, subtree: true, attributeFilter: ["style", "class"] });
    schedule.current();
    return () => { stopped = true; cancelAnimationFrame(frame); resize.disconnect(); position.disconnect(); schedule.current = () => {}; };
  }, []);
  useLayoutEffect(() => { schedule.current(); }, [model]);
  const factory = useCallback((node: { getId(): string }) => <div data-plugin-slot={node.getId()} style={{ width: "100%", height: "100%" }} />, []);
  return <div ref={container} style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
    onDragStartCapture={() => setDragging(true)} onDragEnd={() => setDragging(false)} onDrop={() => setDragging(false)}>
    <div ref={dock} style={{ position: "absolute", inset: 0 }}>
      <Layout model={model} factory={factory} realtimeResize tabDragSpeed={0} invalidateTabContentOnParentRender={false}
        keyMap={{ closeTab: undefined }} onAction={action => {
          if (action.type === Actions.DELETE_TAB) { close(action.data.node); return undefined; }
          // Group deletion would bypass each view's close handshake. Normal tab
          // movement, selection and resizing affect presentation only.
          if (action.type === Actions.DELETE_TABSET) return undefined;
          return action;
        }} onModelChange={(_model, action) => { schedule.current(); changed(action); }} />
    </div>
    <PluginFrameLayer frames={frames} regions={regions} dragging={dragging} />
  </div>;
}
