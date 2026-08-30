import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import {
  defaultToolbarLayout,
  reorderToolbarComponent,
  setToolbarComponentVisible,
} from "./toolbar-model";
import type {
  ToolbarComponentId,
  ToolbarLayout,
  ToolbarPreferenceStatus,
} from "./toolbar-model";

const FIXED_COMPONENTS = ["Rho menu", "Studio / Vibe"] as const;

const OPTIONAL_LABELS: Readonly<Record<ToolbarComponentId, string>> = {
  command_search: "Command search",
  compose: "Compose",
};

interface ToolbarCustomizerProps {
  readonly layout: ToolbarLayout;
  readonly open: boolean;
  readonly persistenceStatus: ToolbarPreferenceStatus;
  readonly persistenceDetail: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPreview: (layout: ToolbarLayout) => void;
  readonly onCommit: (layout: ToolbarLayout) => void;
  readonly showTrigger?: boolean;
}

interface ReorderGesture {
  readonly pointerId: number;
  readonly sourceId: ToolbarComponentId;
  readonly startX: number;
  readonly startY: number;
  readonly origin: ToolbarLayout;
  readonly handle: HTMLButtonElement;
  active: boolean;
  current: ToolbarLayout;
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="5" cy="4" r="1" /><circle cx="11" cy="4" r="1" />
      <circle cx="5" cy="8" r="1" /><circle cx="11" cy="8" r="1" />
      <circle cx="5" cy="12" r="1" /><circle cx="11" cy="12" r="1" />
    </svg>
  );
}

function TuneIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3 5h8M14 5h1M3 13h2M8 13h7M11 3v4M5 11v4" />
    </svg>
  );
}

function componentIdAtPoint(clientX: number, clientY: number): ToolbarComponentId | null {
  const elements = typeof document.elementsFromPoint === "function"
    ? document.elementsFromPoint(clientX, clientY)
    : [];
  for (const element of elements) {
    const row = element.closest<HTMLElement>("[data-toolbar-option-id]");
    const value = row?.dataset.toolbarOptionId;
    if (value != null && value in OPTIONAL_LABELS) return value as ToolbarComponentId;
  }
  return null;
}

export function ToolbarCustomizer({
  layout,
  open,
  persistenceStatus,
  persistenceDetail,
  onOpenChange,
  onPreview,
  onCommit,
  showTrigger = true,
}: ToolbarCustomizerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<ReorderGesture | null>(null);
  const [draggedId, setDraggedId] = useState<ToolbarComponentId | null>(null);

  const finishGesture = (commit: boolean) => {
    const gesture = gestureRef.current;
    if (gesture == null) return false;
    gestureRef.current = null;
    setDraggedId(null);
    if (gesture.handle.hasPointerCapture?.(gesture.pointerId)) {
      gesture.handle.releasePointerCapture(gesture.pointerId);
    }
    if (gesture.active && commit) onCommit(gesture.current);
    else if (gesture.active) onPreview(gesture.origin);
    return true;
  };

  useEffect(() => {
    if (!open) {
      finishGesture(false);
      return;
    }
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        finishGesture(false);
        onOpenChange(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!finishGesture(false)) onOpenChange(false);
    };
    const cancelOnBlur = () => finishGesture(false);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", cancelOnBlur);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", cancelOnBlur);
    };
  });

  const startPointerReorder = (
    event: ReactPointerEvent<HTMLButtonElement>,
    sourceId: ToolbarComponentId,
  ) => {
    if (event.button !== 0 || gestureRef.current != null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      sourceId,
      startX: event.clientX,
      startY: event.clientY,
      origin: layout,
      handle: event.currentTarget,
      active: false,
      current: layout,
    };
  };

  const updatePointerReorder = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (gesture == null || gesture.pointerId !== event.pointerId) return;
    if (!gesture.active) {
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 4) return;
      gesture.active = true;
      setDraggedId(gesture.sourceId);
    }
    event.preventDefault();
    const targetId = componentIdAtPoint(event.clientX, event.clientY);
    if (targetId == null) return;
    const target = document.querySelector<HTMLElement>(
      `[data-toolbar-option-id="${targetId}"]`,
    );
    const edge = target != null && event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2
      ? "after"
      : "before";
    const next = reorderToolbarComponent(gesture.origin, gesture.sourceId, targetId, edge);
    if (next === gesture.current || next.order.every((id, index) => id === gesture.current.order[index])) return;
    gesture.current = next;
    onPreview(next);
  };

  const reorderFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    componentId: ToolbarComponentId,
  ) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const index = layout.order.indexOf(componentId);
    const targetIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
    const targetId = layout.order[targetIndex];
    if (targetId == null) return;
    onCommit(reorderToolbarComponent(
      layout,
      componentId,
      targetId,
      event.key === "ArrowUp" ? "before" : "after",
    ));
  };

  return (
    <div className="rho-toolbar-customize" data-trigger-visible={showTrigger} ref={rootRef}>
      {showTrigger && <button
        type="button"
        className="rho-toolbar-customize-trigger rho-icon-btn"
        aria-label="Customize toolbar"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      ><TuneIcon /></button>}
      {open && (
        <section className="rho-toolbar-customizer" role="dialog" aria-label="Toolbar components">
          <header><strong>Toolbar components</strong></header>
          <span className="rho-toolbar-group-label">Fixed</span>
          <div className="rho-toolbar-option-list rho-toolbar-fixed-list">
            {FIXED_COMPONENTS.map((label) => (
              <div className="rho-toolbar-option" key={label}>
                <span className="rho-toolbar-lock"><LockIcon /></span>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <span className="rho-toolbar-group-label">Optional — drag to reorder</span>
          <div className="rho-toolbar-option-list">
            {layout.order.map((componentId) => (
              <div
                className="rho-toolbar-option"
                data-toolbar-option-id={componentId}
                data-toolbar-dragging={draggedId === componentId || undefined}
                key={componentId}
              >
                <button
                  type="button"
                  className="rho-toolbar-grip rho-icon-btn"
                  aria-label={`Reorder ${OPTIONAL_LABELS[componentId]}. Use Arrow keys.`}
                  data-dragging={draggedId === componentId || undefined}
                  onKeyDown={(event) => reorderFromKeyboard(event, componentId)}
                  onPointerDown={(event) => startPointerReorder(event, componentId)}
                  onPointerMove={updatePointerReorder}
                  onPointerUp={(event) => {
                    if (gestureRef.current?.pointerId === event.pointerId) finishGesture(true);
                  }}
                  onPointerCancel={(event) => {
                    if (gestureRef.current?.pointerId === event.pointerId) finishGesture(false);
                  }}
                  onLostPointerCapture={() => finishGesture(false)}
                ><GripIcon /></button>
                <label>
                  <input
                    type="checkbox"
                    checked={layout.visible.includes(componentId)}
                    onChange={(event) => onCommit(
                      setToolbarComponentVisible(layout, componentId, event.target.checked),
                    )}
                  />
                  <span>{OPTIONAL_LABELS[componentId]}</span>
                </label>
              </div>
            ))}
          </div>
          {(persistenceStatus === "recovered" || persistenceStatus === "unavailable") && (
            <p className="rho-toolbar-persistence-note" role="status">{persistenceDetail}</p>
          )}
          <footer>
            <button type="button" onClick={() => onCommit(defaultToolbarLayout())}>Reset default</button>
            <button type="button" className="rho-primary-action" onClick={() => onOpenChange(false)}>Done</button>
          </footer>
        </section>
      )}
    </div>
  );
}
