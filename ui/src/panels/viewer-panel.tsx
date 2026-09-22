import { useViewer, useOutputs } from "../context";
import { useEffect } from "react";
import type { MediaReference } from "../generated/MediaReference";
import { mediaKey } from "../output-ports";

export function ViewerPanel() {
  const viewer = useViewer();
  const outputs = useOutputs();
  const viewerSnapshot = viewer.getSnapshot();
  const html = outputs.getSnapshot().html;
  const { selected, history, path, loading, error } = viewerSnapshot;
  const reference = viewer.selectedReference();
  const referenceKey = reference ? mediaKey(reference) : null;

  useEffect(() => {
    if (reference) void viewer.ensurePath(reference);
  }, [viewer, referenceKey]);

  if (!selected || !reference) {
    return (
      <div className="panel-empty">
        <div className="panel-empty-icon">🌐</div>
        <div className="panel-empty-message">No HTML output selected</div>
        <div className="panel-empty-hint">Run code that produces HTML output</div>
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
          onClick={() => viewer.refresh(reference)}
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
      {error && <div className="panel-error viewer-error"><div className="panel-error-icon">⚠</div><div className="panel-error-message">{error}</div></div>}
      {!error && loading && <div className="panel-empty viewer-loading">Opening HTML output…</div>}
      {path && !error && (
        <iframe
          className="viewer-frame"
          src={path}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title="HTML Viewer"
        />
      )}
    </div>
  );
}
