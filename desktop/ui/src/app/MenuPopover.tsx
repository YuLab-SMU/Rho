import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";

export function MenuPopover({
  label,
  glyph,
  children,
  panelClassName = "",
  viewportBound = false,
}: {
  readonly label: string;
  readonly glyph: ReactNode;
  readonly children: ReactNode;
  readonly panelClassName?: string;
  readonly viewportBound?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ readonly top: number; readonly left: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      ) setOpen(false);
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        trigger.current?.focus();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissWithEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !viewportBound || trigger.current == null || panel.current == null) return;
    const triggerBox = trigger.current.getBoundingClientRect();
    const panelBox = panel.current.getBoundingClientRect();
    const tokens = window.getComputedStyle(document.documentElement);
    const parsedInset = Number.parseFloat(tokens.getPropertyValue("--rho-space-3"));
    const parsedGap = Number.parseFloat(tokens.getPropertyValue("--rho-space-2"));
    const inset = Number.isFinite(parsedInset) ? parsedInset : 0;
    const gap = Number.isFinite(parsedGap) ? parsedGap : 0;
    const spaceBelow = window.innerHeight - triggerBox.bottom - inset;
    const spaceAbove = triggerBox.top - inset;
    const preferredTop = spaceBelow >= panelBox.height || spaceBelow >= spaceAbove
      ? triggerBox.bottom + gap
      : triggerBox.top - panelBox.height - gap;
    setPosition({
      top: Math.max(inset, Math.min(preferredTop, window.innerHeight - panelBox.height - inset)),
      left: Math.max(inset, Math.min(triggerBox.right - panelBox.width, window.innerWidth - panelBox.width - inset)),
    });
  }, [open, viewportBound]);

  const menuPanel = open ? (
    <div
      id={panelId}
      ref={panel}
      className={`rho-menu-popover-panel ${viewportBound ? "rho-menu-popover-panel-viewport" : ""} ${panelClassName}`.trim()}
      role="dialog"
      aria-label={label}
      style={viewportBound ? {
        position: "fixed",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        right: "auto",
        visibility: position == null ? "hidden" : "visible",
      } satisfies CSSProperties : undefined}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("[data-menu-close]")) {
          trigger.current?.focus();
          setOpen(false);
        }
      }}
    >{children}</div>
  ) : null;

  return (
    <div className="rho-menu-popover" ref={root}>
      <button
        type="button"
        className="rho-icon-btn"
        ref={trigger}
        aria-label={label}
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => {
          if (!current) setPosition(null);
          return !current;
        })}
      >{glyph}</button>
      {viewportBound && menuPanel != null ? createPortal(menuPanel, document.body) : menuPanel}
    </div>
  );
}
