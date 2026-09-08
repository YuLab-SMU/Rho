import { useEffect, useRef, useState } from "react";
import { useMediaCache } from "../context";
import { mediaKey } from "../output-ports";
import type { MediaReference } from "../generated/MediaReference";
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
  const cache = useMediaCache(),
    snapshot = cache.getSnapshot(),
    key = mediaKey(reference),
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
    if (visible) cache.load(reference);
  }, [key, visible, cache]);
  const url = snapshot.urls.get(key),
    error = snapshot.errors.get(key);
  return (
    <span ref={parent} className={`media-image ${className ?? ""}`}>
      {url && !error ? (
        <img
          src={url}
          data-operation-id={reference.operation_id}
          data-output-sequence={reference.sequence}
          alt={`R Plot ${reference.sequence}`}
          draggable={false}
          onLoad={(e) => onLoad?.(e.currentTarget)}
          onError={(event) => cache.reportDecodeError(reference, event.currentTarget.src)}
        />
      ) : (
        <span className={error ? "error" : "muted"}>
          {error ?? "Loading original plot…"}
          {error && (
            <button
              onClick={() => cache.retry(reference)}
            >
              Retry
            </button>
          )}
        </span>
      )}
    </span>
  );
}
