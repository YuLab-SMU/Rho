import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

import type { StudioDropTarget, StudioDropZone } from "../transport/studio-model";

const DRAG_THRESHOLD_PX = 6;
const PANE_TARGET_SELECTOR = "[data-studio-drop-node-id][data-studio-drop-instance-id]";
const TAB_TARGET_SELECTOR = "[data-studio-tab-node-id][data-studio-tab-instance-id]";

interface StudioDropHit {
  readonly target: StudioDropTarget;
  readonly instruction: string;
}

export interface StudioDragVisual {
  readonly instanceId: string;
  readonly label: string;
  readonly initialX: number;
  readonly initialY: number;
  readonly target: StudioDropTarget | null;
  readonly instruction: string;
}

export interface StudioPointerDragController {
  readonly visual: StudioDragVisual | null;
  readonly ghostRef: RefObject<HTMLDivElement | null>;
  readonly begin: (
    event: ReactPointerEvent<HTMLElement>,
    instanceId: string,
    label: string,
  ) => void;
  readonly consumeSuppressedClick: (element: HTMLElement) => boolean;
}

interface PendingDrag {
  readonly pointerId: number;
  readonly instanceId: string;
  readonly label: string;
  readonly startX: number;
  readonly startY: number;
  readonly source: HTMLElement;
  active: boolean;
  target: StudioDropTarget | null;
  targetKey: string;
  frame: number | null;
  latestX: number;
  latestY: number;
}

function paneZone(rect: DOMRect, clientX: number, clientY: number): StudioDropZone {
  const x = rect.width <= 0 ? 0.5 : (clientX - rect.left) / rect.width;
  const y = rect.height <= 0 ? 0.5 : (clientY - rect.top) / rect.height;
  const edge = 0.25;
  if (x < edge) return "left";
  if (x > 1 - edge) return "right";
  if (y < edge) return "top";
  if (y > 1 - edge) return "bottom";
  return "center";
}

function directionLabel(zone: StudioDropZone): string {
  switch (zone) {
    case "left": return "Dock left";
    case "right": return "Dock right";
    case "top": return "Dock above";
    case "bottom": return "Dock below";
    case "center": return "Add to stack";
    case "tab-before": return "Insert tab before";
    case "tab-after": return "Insert tab after";
  }
}

function elementsAtPoint(clientX: number, clientY: number): readonly Element[] {
  if (typeof document.elementsFromPoint === "function") {
    return document.elementsFromPoint(clientX, clientY);
  }
  const element = document.elementFromPoint?.(clientX, clientY) ?? null;
  return element == null ? [] : [element];
}

function resolveDropHit(clientX: number, clientY: number, dragInstanceId: string): StudioDropHit | null {
  const elements = elementsAtPoint(clientX, clientY);
  for (const element of elements) {
    const tab = element.closest<HTMLElement>(TAB_TARGET_SELECTOR);
    if (tab == null) continue;
    const nodeId = tab.dataset.studioTabNodeId;
    const instanceId = tab.dataset.studioTabInstanceId;
    if (nodeId == null || instanceId == null || instanceId === dragInstanceId) return null;
    const rect = tab.getBoundingClientRect();
    const zone: StudioDropZone = clientX < rect.left + rect.width / 2
      ? "tab-before"
      : "tab-after";
    const label = tab.dataset.studioDropLabel ?? instanceId;
    return {
      target: { nodeId, instanceId, zone },
      instruction: `${directionLabel(zone)} ${label}`,
    };
  }
  for (const element of elements) {
    const pane = element.closest<HTMLElement>(PANE_TARGET_SELECTOR);
    if (pane == null) continue;
    const nodeId = pane.dataset.studioDropNodeId;
    const instanceId = pane.dataset.studioDropInstanceId;
    if (nodeId == null || instanceId == null) continue;
    const zone = paneZone(pane.getBoundingClientRect(), clientX, clientY);
    const memberCount = Number(pane.dataset.studioDropMemberCount ?? "1");
    if (instanceId === dragInstanceId && (zone === "center" || memberCount < 2)) return null;
    const label = pane.dataset.studioDropLabel ?? instanceId;
    return {
      target: { nodeId, instanceId, zone },
      instruction: `${directionLabel(zone)} · ${label}`,
    };
  }
  return null;
}

function targetKey(target: StudioDropTarget | null): string {
  return target == null ? "" : `${target.nodeId}\u0000${target.instanceId}\u0000${target.zone}`;
}

function ghostTransform(clientX: number, clientY: number): string {
  return `translate3d(calc(${clientX}px + var(--rho-space-5)), calc(${clientY}px + var(--rho-space-5)), 0)`;
}

export function useStudioPointerDrag(
  commit: (dragInstanceId: string, target: StudioDropTarget) => void,
): StudioPointerDragController {
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const pendingRef = useRef<PendingDrag | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [visual, setVisual] = useState<StudioDragVisual | null>(null);

  const clear = useCallback(() => {
    const pending = pendingRef.current;
    if (pending == null) return;
    if (pending.frame != null) cancelAnimationFrame(pending.frame);
    document.documentElement.removeAttribute("data-studio-dragging");
    try {
      if (pending.source.hasPointerCapture?.(pending.pointerId)) {
        pending.source.releasePointerCapture(pending.pointerId);
      }
    } catch {
      // A WebView may have already released capture during cancellation.
    }
    pendingRef.current = null;
    setVisual(null);
  }, []);

  useEffect(() => {
    const scheduleGhost = (pending: PendingDrag, clientX: number, clientY: number) => {
      pending.latestX = clientX;
      pending.latestY = clientY;
      if (pending.frame != null) return;
      pending.frame = requestAnimationFrame(() => {
        pending.frame = null;
        if (ghostRef.current != null) {
          ghostRef.current.style.transform = ghostTransform(pending.latestX, pending.latestY);
        }
      });
    };
    const move = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending == null || event.pointerId !== pending.pointerId) return;
      if (!pending.source.isConnected) {
        clear();
        return;
      }
      if (!pending.active) {
        const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
        if (distance < DRAG_THRESHOLD_PX) return;
        pending.active = true;
        pending.source.dataset.studioDragSuppressClick = "true";
        document.documentElement.dataset.studioDragging = "true";
        setVisual({
          instanceId: pending.instanceId,
          label: pending.label,
          initialX: event.clientX,
          initialY: event.clientY,
          target: null,
          instruction: "Move over a pane or tab",
        });
      }
      if (event.cancelable) event.preventDefault();
      scheduleGhost(pending, event.clientX, event.clientY);
      const hit = resolveDropHit(event.clientX, event.clientY, pending.instanceId);
      const nextKey = targetKey(hit?.target ?? null);
      pending.target = hit?.target ?? null;
      if (nextKey === pending.targetKey) return;
      pending.targetKey = nextKey;
      setVisual((current) => current == null ? current : {
        ...current,
        target: hit?.target ?? null,
        instruction: hit?.instruction ?? "Move over a pane or tab",
      });
    };
    const finish = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending == null || event.pointerId !== pending.pointerId) return;
      const active = pending.active;
      const target = pending.target;
      const instanceId = pending.instanceId;
      if (active && event.cancelable) event.preventDefault();
      clear();
      if (active && target != null) commitRef.current(instanceId, target);
    };
    const cancel = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending == null || event.pointerId !== pending.pointerId) return;
      clear();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || pendingRef.current?.active !== true) return;
      event.preventDefault();
      clear();
    };
    const blur = () => clear();
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", blur);
      const pending = pendingRef.current;
      if (pending?.frame != null) cancelAnimationFrame(pending.frame);
      pendingRef.current = null;
      document.documentElement.removeAttribute("data-studio-dragging");
    };
  }, [clear]);

  const begin = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    instanceId: string,
    label: string,
  ) => {
    if (event.button !== 0 || pendingRef.current != null) return;
    const source = event.currentTarget;
    delete source.dataset.studioDragSuppressClick;
    pendingRef.current = {
      pointerId: event.pointerId,
      instanceId,
      label,
      startX: event.clientX,
      startY: event.clientY,
      source,
      active: false,
      target: null,
      targetKey: "",
      frame: null,
      latestX: event.clientX,
      latestY: event.clientY,
    };
    try {
      source.setPointerCapture?.(event.pointerId);
    } catch {
      // Window-level listeners still own the transaction when capture is unavailable.
    }
  }, []);

  const consumeSuppressedClick = useCallback((element: HTMLElement) => {
    if (element.dataset.studioDragSuppressClick !== "true") return false;
    delete element.dataset.studioDragSuppressClick;
    return true;
  }, []);

  return { visual, ghostRef, begin, consumeSuppressedClick };
}

export function StudioDragLayer({ controller }: { readonly controller: StudioPointerDragController }) {
  const visual = controller.visual;
  if (visual == null) return null;
  return (
    <>
      <div
        ref={controller.ghostRef}
        className="rho-studio-drag-ghost"
        style={{ transform: ghostTransform(visual.initialX, visual.initialY) }}
        aria-hidden="true"
      >
        <span>Moving</span>
        <strong>{visual.label}</strong>
        <small>{visual.instruction}</small>
      </div>
      <div className="rho-visually-hidden" role="status" aria-live="polite">
        Moving {visual.label}. {visual.instruction}.
      </div>
    </>
  );
}
