import { useHelp } from "../context";
import { useEffect, useState } from "react";

export function HelpPanel() {
  const help = useHelp();
  const { topic, page, loading, error } = help.getSnapshot();
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (!page && !loading && !error && topic) {
      help.observe();
    }
  }, [help, page, loading, error, topic]);

  if (!topic) {
    return (
      <div className="panel-empty">
        <div className="panel-empty-icon">📖</div>
        <div className="panel-empty-message">No help topic selected</div>
        <div className="panel-empty-hint">Open a help topic from Packages</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="panel-loading">
        <div className="spinner" />
        <div className="panel-loading-message">Loading help…</div>
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

  if (!page || !page.found) {
    return (
      <div className="panel-empty">
        <div className="panel-empty-icon">📖</div>
        <div className="panel-empty-message">Help topic not found</div>
      </div>
    );
  }

  return (
    <div className="help-panel">
      <div className="help-toolbar">
        <div className="help-identity">
          <span className="help-package">{page.package}</span>
          <span className="help-separator">::</span>
          <span className="help-topic">{page.topic}</span>
        </div>
        <div className="help-version">{page.version}</div>
        <button
          className="help-toggle-raw"
          onClick={() => setShowRaw(!showRaw)}
          title={showRaw ? "Show formatted" : "Show raw text"}
        >
          {showRaw ? "Format" : "Raw"}
        </button>
      </div>
      {!page.complete && (
        <div className="help-notice">
          This help page is truncated. View the full documentation in the installed package.
        </div>
      )}
      {showRaw ? (
        <pre className="help-raw">{page.text}</pre>
      ) : (
        <div
          className="help-content"
          dangerouslySetInnerHTML={{ __html: page.text }}
        />
      )}
    </div>
  );
}
