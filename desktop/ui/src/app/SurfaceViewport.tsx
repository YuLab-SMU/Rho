import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

const DEFAULT_RELEASE_DELAY_MS = 12_000;

export function SurfaceViewport({
  label,
  children,
  releaseDelayMs = DEFAULT_RELEASE_DELAY_MS,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly releaseDelayMs?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const releaseTimer = useRef<number | null>(null);
  const [mounted, setMounted] = useState(
    () => typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    const element = host.current;
    if (element == null || typeof IntersectionObserver === "undefined") return;
    const cancelRelease = () => {
      if (releaseTimer.current != null) window.clearTimeout(releaseTimer.current);
      releaseTimer.current = null;
    };
    const scheduleRelease = () => {
      cancelRelease();
      releaseTimer.current = window.setTimeout(() => {
        if (element.contains(document.activeElement)) {
          scheduleRelease();
          return;
        }
        setMounted(false);
        releaseTimer.current = null;
      }, releaseDelayMs);
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        cancelRelease();
        setMounted(true);
      } else {
        scheduleRelease();
      }
    }, { rootMargin: "800px 0px" });
    observer.observe(element);
    return () => {
      cancelRelease();
      observer.disconnect();
    };
  }, [releaseDelayMs]);

  return (
    <div
      ref={host}
      className="rho-surface-viewport"
      data-viewport-state={mounted ? "mounted" : "released"}
    >
      {mounted ? children : (
        <div className="rho-surface-viewport-placeholder" role="status">
          <span>{label} released while outside the viewport.</span>
          <button type="button" onClick={() => setMounted(true)}>Restore view</button>
        </div>
      )}
    </div>
  );
}
