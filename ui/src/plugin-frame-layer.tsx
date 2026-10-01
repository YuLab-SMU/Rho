import { useRef } from "react";
import type { ReactNode } from "react";

export interface PluginFrameRegion { x: number; y: number; width: number; height: number }
export interface PluginFrameContent { id: string; title: string; content: ReactNode }

/** Iframes never enter the docking library's moveable DOM. Moving a connected
 * iframe with appendChild can reload its document even when React state survives.
 * Keep creation order too: keyed React sibling reordering can move the DOM node. */
export function PluginFrameLayer({ frames, regions, dragging = false }: {
  frames: readonly PluginFrameContent[];
  regions: ReadonlyMap<string, PluginFrameRegion>;
  dragging?: boolean;
}) {
  const order = useRef<string[]>([]);
  const available = new Map(frames.map(frame => [frame.id, frame]));
  order.current = order.current.filter(id => available.has(id));
  const retained = new Set(order.current);
  for (const frame of frames) if (!retained.has(frame.id)) { order.current.push(frame.id); retained.add(frame.id); }
  return <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
    {order.current.map(id => {
      const frame = available.get(id)!, region = regions.get(id);
      const visible = !!region && region.width > 0 && region.height > 0;
      return <div key={id} data-plugin-frame={id} aria-label={frame.title} aria-hidden={!visible} inert={!visible}
        style={{ position: "absolute", display: visible ? "block" : "none", left: region?.x ?? 0, top: region?.y ?? 0,
          width: region?.width ?? 0, height: region?.height ?? 0, pointerEvents: dragging ? "none" : "auto", overflow: "hidden" }}>
        {frame.content}
      </div>;
    })}
  </div>;
}
