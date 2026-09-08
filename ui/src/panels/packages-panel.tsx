import { useEffect, useRef, useState } from "react";
import { useStudio } from "../context";
import type { PackageQueryMode } from "../generated/PackageQueryMode";
import type { PackageEntry } from "../generated/PackageEntry";

export function PackagesPanel() {
  const s = useStudio("packages", "runtime"),
    p = s.packages;
  const root = useRef<HTMLDivElement>(null),
    body = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState(p.filter);
  const [expanded, setExpanded] = useState<string | null>(null);
  const busy = s.runtime?.state === "busy";
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      p.visible = entry.isIntersecting;
      if (p.visible && p.dirty) void p.refresh();
    });
    if (root.current) observer.observe(root.current);
    return () => {
      observer.disconnect();
      p.visible = false;
    };
  }, [p]);
  useEffect(() => {
    if (filter === p.filter) return;
    const timer = setTimeout(() => {
      p.select(filter);
      void p.refresh();
    }, 250);
    return () => clearTimeout(timer);
  }, [filter, p]);
  useEffect(() => {
    if (body.current) body.current.scrollTop = p.scrollTop;
  }, [p, p.data]);
  const select = (mode: PackageQueryMode, offset = 0) => {
    p.select(filter, mode, offset);
    setExpanded(null);
    void p.refresh();
  };
  const data = p.data;
  function details(row: PackageEntry) {
    return (
      <dl className="package-details">
        {row.title && (
          <>
            <dt>Title</dt>
            <dd>{row.title}</dd>
          </>
        )}
        <dt>Library</dt>
        <dd>{row.library_path ?? "Unknown"}</dd>
        <dt>Library order</dt>
        <dd>
          {row.library_index === null
            ? "Outside current library paths"
            : `#${row.library_index}`}
        </dd>
        {p.mode === "installed" && (
          <>
            <dt>Lookup</dt>
            <dd>
              {row.first_in_library_path
                ? "First installed copy in library order"
                : "An earlier library contains this package"}
            </dd>
          </>
        )}
        {row.built && (
          <>
            <dt>Built</dt>
            <dd>{row.built}</dd>
          </>
        )}
        <dt>Loaded version</dt>
        <dd>{row.loaded_version ?? "Not loaded"}</dd>
        {row.loaded_path && (
          <>
            <dt>Loaded from</dt>
            <dd>{row.loaded_path}</dd>
          </>
        )}
        <dt>Attached</dt>
        <dd>{row.attached ? "Yes — on the R search path" : "No"}</dd>
        {p.mode === "installed" && (
          <p className="muted">
            Installed metadata does not confirm that a package can load. An
            already loaded namespace may use a different copy.
          </p>
        )}
      </dl>
    );
  }
  return (
    <div className="panel packages-panel" ref={root}>
      <div className="panel-toolbar">
        <input
          aria-label="Search Packages"
          placeholder="Search packages…"
          value={filter}
          maxLength={128}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          disabled={p.loading || busy || !s.runtime}
          onClick={() => {
            p.invalidate();
            void p.refresh();
          }}
          title="Refresh Packages"
        >
          {p.loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      <div className="package-controls">
        <select
          aria-label="Package View"
          value={p.mode}
          onChange={(e) => select(e.target.value as PackageQueryMode)}
        >
          <option value="installed">Installed in library paths</option>
          <option value="loaded">Loaded namespaces</option>
          <option value="attached">Attached packages</option>
        </select>
        <span className="muted">Read only</span>
      </div>
      <div
        className="package-scroll"
        ref={body}
        onScroll={(e) => {
          p.scrollTop = e.currentTarget.scrollTop;
        }}
      >
        {data && (
          <details className="package-runtime">
            <summary>
              R {data.r_version} · {data.library_paths.length} library paths
            </summary>
            <dl>
              <dt>R home</dt>
              <dd>{data.r_home}</dd>
              <dt>Platform</dt>
              <dd>{data.platform}</dd>
            </dl>
            <p className="muted">Current session library search order</p>
            <ol>
              {data.library_paths.map((path, i) => (
                <li key={`${i}:${path}`}>{path}</li>
              ))}
            </ol>
            <p className="muted">
              Paths reflect the active R session. Environment management is not
              inferred from directory names.
            </p>
          </details>
        )}
        {p.notice && <p className="notice">{p.notice}</p>}
        {!s.runtime && (
          <p className="empty">Connect an R session to inspect its packages.</p>
        )}
        {data && (
          <>
            {data.notices.map((text) => (
              <p className="notice" key={text}>
                {text}
              </p>
            ))}
            {!data.packages.length && (
              <p className="package-count muted">
                No matches in the observed metadata
              </p>
            )}
            {!data.scan_complete && <p className="notice">Incomplete scan</p>}
            <div className="package-list" aria-label="Package list">
              {data.packages.map((row) => {
                const id = `${row.library_path}:${row.name}`;
                const loadedCopy =
                  p.mode !== "installed" ||
                  (row.loaded_from_library &&
                    row.loaded_version === row.version);
                return (
                  <div className="package-item" key={id}>
                    <button
                      className="package-row"
                      aria-expanded={expanded === id}
                      onClick={() => setExpanded(expanded === id ? null : id)}
                    >
                      <span className="package-name">
                        <span aria-hidden="true">
                          {expanded === id ? "▾" : "▸"}
                        </span>{" "}
                        {row.name}
                      </span>
                      <span className="package-version">{row.version}</span>
                      <span className="package-state">
                        {loadedCopy
                          ? row.attached
                            ? "Attached"
                            : "Loaded"
                          : row.loaded_from_library
                            ? `Loaded ${row.loaded_version ?? "version unknown"}`
                            : p.mode === "installed" &&
                                !row.first_in_library_path
                              ? "Later copy"
                              : "Installed"}
                      </span>
                      <span
                        className="package-library"
                        title={row.library_path ?? "Unknown"}
                      >
                        {row.library_index === null
                          ? "Outside paths"
                          : `Library ${row.library_index}`}{" "}
                        · {row.library_path ?? "Unknown path"}
                      </span>
                    </button>
                    {expanded === id && details(row)}
                  </div>
                );
              })}
            </div>
            {(data.offset > 0 || data.next_offset !== null) && (
              <div className="package-pagination">
                <button
                  disabled={p.loading || busy || !data.offset}
                  onClick={() => select(p.mode, Math.max(0, data.offset - 100))}
                >
                  Previous
                </button>
                <button
                  disabled={p.loading || busy || data.next_offset === null}
                  onClick={() => select(p.mode, data.next_offset!)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="package-footer muted" role="status">
        <span
          title={
            p.observedAt ? new Date(p.observedAt).toLocaleString() : undefined
          }
        >
          {p.observedAt
            ? `Last observed ${new Date(p.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : "No package observation yet"}
          {busy ? " · R busy" : p.loading ? " · Reading…" : ""}
        </span>
        {data && (
          <span
            title={`Showing ${data.packages.length} of ${data.total_matches} matches${data.scan_complete ? "" : " in an incomplete scan"}`}
          >
            {data.packages.length
              ? `${data.offset + 1}–${data.offset + data.packages.length}`
              : "0"}{" "}
            / {data.total_matches}
            {!data.scan_complete ? "+" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
