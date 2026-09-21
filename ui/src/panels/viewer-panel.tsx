import { useViewer, useOutputs } from "../context";
import { useState, useEffect } from "react";
import type { MediaReference } from "../generated/MediaReference";
import { mediaKey } from "../output-ports";

export function ViewerPanel() {
  const viewer = useViewer();
  const outputs = useOutputs();
  const snapshot = viewer.getSnapshot();
  const outputSnapshot = outputs.getSnapshot();
  const { selected, history } = snapshot;
  const html = outputSnapshot.html;
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reference = viewer.selectedReference();

  useEffect(() => {
    if (!reference) {
      setIframeSrc(null);
      return;
    }
    const token = (window as any).__rho_bearer;
    if (!token) {
      setError("No authentication token available");
      return;
    }
    const params = new URLSearchParams({
      operation_id: reference.operation_id.toString(),
      sequence: reference.sequence.toString(),
      sha256: reference.sha256,
      mime_type: reference.mime_type,
    });
    setIframeSrc(`/api/html-view?${params}&bearer=${encodeURIComponent(token)}`);
    setError(null);
  }, [reference]);

  if (!selected || !reference) {
    return (
      <div className="panel-empty">
        <div className="panel-empty-icon">🌐</div>
        <div className="panel-empty-message">No HTML output selected</div>
        <div className="panel-empty-hint">Run code that produces HTML output</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel-error">
        <div className="panel-error-icon">⚠</div>
        <div className="panel-error-message">{error}</div>
      </div>
    );
  }

  return (
    <div className="viewer-panel">
      <div className="viewer-toolbar">
        <button
          className="viewer-history-toggle"
          onClick={() => viewer.toggleHistory()}
          title={history ? "Hide history" : "Show history"}
        >
          {history ? "Hide" : "History"}
        </button>
        <div className="viewer-identity">
          Output {reference.sequence} · Run {reference.operation_id.toString().slice(0, 8)}
        </div>
        <button
          className="viewer-open"
          onClick={() => viewer.openInNewWindow(reference)}
          title="Open in new window"
        >
          Open
        </button>
        <button
          className="viewer-refresh"
          onClick={() => {
            const iframe = document.querySelector(".viewer-frame") as HTMLIFrameElement;
            if (iframe) iframe.src = iframe.src;
          }}
          title="Refresh"
        >
          Refresh
        </button>
      </div>
      {history && html.length > 1 && (
        <div className="viewer-history">
          {html.map((ref: MediaReference, idx: number) => {
            const key = mediaKey(ref);
            const active = key === selected;
            return (
              <button
                key={key}
                className={`viewer-history-item ${active ? "active" : ""}`}
                onClick={() => viewer.selectByIndex(idx)}
                title={`Output ${ref.sequence}`}
              >
                {ref.sequence}
              </button>
            );
          })}
        </div>
      )}
      {iframeSrc && (
        <iframe
          className="viewer-frame"
          src={iframeSrc}
          sandbox="allow-scripts allow-same-origin"
          title="HTML Viewer"
        />
      )}
    </div>
  );
}
