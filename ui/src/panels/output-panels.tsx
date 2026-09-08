import { useEffect, useRef, useState } from "react";
import { useStudio } from "../context";
import type { MediaReference } from "../generated/MediaReference";
export { ConsolePanel } from "./console-panel";
export { PlotPanel } from "./plot-panel";
export function MediaImage({
  reference,
  className,
  onLoad,
  priority = false,
}: {
  reference: MediaReference;
  className?: string;
  onLoad?: (image: HTMLImageElement) => void;
  priority?: boolean;
}) {
  const s = useStudio("media"),
    key = s.mediaKey(reference),
    parent = useRef<HTMLSpanElement>(null),
    [visible, setVisible] = useState(priority);
  useEffect(() => {
    if (priority) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "100px" },
    );
    if (parent.current) observer.observe(parent.current);
    return () => observer.disconnect();
  }, [key, priority]);
  useEffect(() => {
    if (visible) void s.loadMedia(reference);
  }, [key, visible, s]);
  const url = s.mediaUrls.get(key),
    error = s.mediaErrors.get(key);
  return (
    <span ref={parent} className={`media-image ${className ?? ""}`}>
      {url && !error ? (
        <img
          src={url}
          alt={`R Plot ${reference.sequence}`}
          draggable={false}
          onLoad={(e) => onLoad?.(e.currentTarget)}
          onError={() => {
            s.mediaErrors.set(
              key,
              "The browser could not decode this original. Export Original is still available.",
            );
            s.emit("media");
          }}
        />
      ) : (
        <span className={error ? "error" : "muted"}>
          {error ?? "Loading original plot…"}
          {error && (
            <button
              onClick={() => {
                s.mediaErrors.delete(key);
                void s.loadMedia(reference);
                s.emit("media");
              }}
            >
              Retry
            </button>
          )}
        </span>
      )}
    </span>
  );
}
