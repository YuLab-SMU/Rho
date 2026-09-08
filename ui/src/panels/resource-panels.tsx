import { useEffect, useId, useRef, useState } from "react";
import { useFiles, useObjects, useSession, useNavigation } from "../context";
import type { BindingSummary } from "../generated/BindingSummary";
import type { JsonValue } from "../generated/serde_json/JsonValue";
const summary = (o: BindingSummary) =>
  o.dimensions.length
    ? o.dimensions.join(" × ")
    : o.length !== null
      ? `${o.length} items`
      : o.kind === "active_binding"
        ? "Active binding"
        : o.kind === "promise"
          ? "Unevaluated"
          : "Metadata";
export function FilesPanel() {
  const f = useFiles(), navigation = useNavigation(),
    body = useRef<HTMLDivElement>(null);
  const { filter, selected, searchMode, scope, results, searching } = f.getSnapshot();
  useEffect(() => {
    if (body.current) body.current.scrollTop = f.scrollTop;
  }, [f]);
  const open = (path: string, size?: number) => navigation.openDocument(path, size);
  const toggle = (path: string) => f.toggleDirectory(path);
  function tree(path: string, depth = 0): React.ReactNode {
    const page = f.directories.get(path);
    return (
      <div role="group">
        {page?.entries
          .filter(
            (e) =>
              (f.showHidden || !e.name.startsWith(".")) &&
              (path !== scope ||
                !filter ||
                e.name
                  .toLocaleLowerCase()
                  .includes(filter.toLocaleLowerCase())),
          )
          .map((e) => (
            <div
              key={e.path}
              role="treeitem"
              aria-expanded={
                e.kind === "directory"
                  ? f.expanded.has(e.path)
                  : undefined
              }
              aria-selected={selected === e.path}
            >
              <button
                className={selected === e.path ? "selected" : ""}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={e.path}
                onClick={() => {
                  f.select(e.path);
                  if (e.kind === "directory") toggle(e.path);
                }}
                onDoubleClick={() => {
                  if (e.kind === "regular") open(e.path, e.byte_size);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && e.kind === "regular") {
                    event.preventDefault();
                    open(e.path, e.byte_size);
                  }
                  if (
                    event.key === "ArrowRight" &&
                    e.kind === "directory" &&
                    !f.expanded.has(e.path)
                  ) {
                    event.preventDefault();
                    toggle(e.path);
                  }
                  if (
                    event.key === "ArrowLeft" &&
                    f.expanded.has(e.path)
                  ) {
                    event.preventDefault();
                    toggle(e.path);
                  }
                }}
              >
                <span className="file-icon">
                  {e.kind === "directory"
                    ? f.expanded.has(e.path)
                      ? "⌄"
                      : "›"
                    : /\.r$/i.test(e.name)
                      ? "R"
                      : "▤"}
                </span>
                <span className="file-name">{e.name}</span>
              </button>
              {e.kind === "directory" &&
                f.expanded.has(e.path) &&
                tree(e.path, depth + 1)}
            </div>
          ))}
        {!page && <p className="muted">Loading directory…</p>}
        {page?.next_name && (
          <button onClick={() => void f.listDirectory(path, true)}>
            Load More · {page.entries.length} shown
          </button>
        )}
        {page?.notices.map((notice, i) => (
          <p className="muted" key={i}>
            {notice}
          </p>
        ))}
      </div>
    );
  }
  return (
    <section className="panel files-panel">
      <div className="resource-toolbar">
        <button
          title="New File"
          aria-label="New File"
          onClick={() => navigation.createDocument()}
        >
          ＋
        </button>
        <button
          aria-label="Refresh Files"
          title="Refresh Files"
          onClick={() => {
            f.refresh();
          }}
        >
          ↻
        </button>
        <button onClick={() => navigation.openFile()}>Open…</button>
      </div>
      <form
        className="resource-search file-search"
        onSubmit={(e) => {
          e.preventDefault();
          f.search();
        }}
      >
        <select
          aria-label="File Search Scope"
          value={searchMode ? "project" : "directory"}
          onChange={(e) => {
            f.setSearchMode(e.target.value === "project");
          }}
        >
          <option value="directory">Filter Directory</option>
          <option value="project">Search Project</option>
        </select>
        {!searchMode && (
          <select
            aria-label="Filter Directory"
            value={scope}
            onChange={(e) => f.setScope(e.target.value)}
          >
            {[...f.expanded].map((path) => (
              <option key={path} value={path}>
                {path || "Project root"}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label={
            searchMode ? "Search Project Files" : "Filter Directory Entries"
          }
          placeholder={
            searchMode ? "Find a name or path…" : "Filter loaded entries…"
          }
          value={filter}
          onChange={(e) => f.setFilter(e.target.value)}
        />
        {searchMode && (
          <button disabled={searching || !filter.trim()}>
            {searching ? "Searching…" : "Search"}
          </button>
        )}
      </form>
      {filter && !searchMode && (
        <p className="filter-notice">
          Filters loaded entries in /{scope}. Folder contents are retained.
        </p>
      )}
      {f.error && (
        <div role="alert" className="document-error">
          {f.error}
        </div>
      )}
      <div
        className="file-list"
        role="tree"
        aria-label="Project Files"
        ref={body}
        onScroll={(e) => {
          f.setScroll(e.currentTarget.scrollTop);
        }}
      >
        {searchMode ? (
          <div>
            {results?.entries.map((entry) => (
              <button
                key={entry.path}
                title={entry.path}
                onDoubleClick={() => {
                  if (entry.kind === "regular")
                    open(entry.path, entry.byte_size);
                }}
                onClick={() => f.select(entry.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && entry.kind === "regular")
                    open(entry.path, entry.byte_size);
                }}
              >
                {entry.path}
              </button>
            ))}
            {results && (
              <p className="filter-notice">
                {results.entries.length} results · {results.scanned_entries}{" "}
                entries observed{results.truncated ? " · Search truncated" : ""}
              </p>
            )}
            {results?.notices.map((n, i) => (
              <p key={i} className="filter-notice">
                {n}
              </p>
            ))}
          </div>
        ) : (
          tree("")
        )}
      </div>
      <div className="panel-footer">
        <label>
          <input
            type="checkbox"
            checked={f.showHidden}
            onChange={(e) => {
              f.setShowHidden(e.target.checked);
            }}
          />{" "}
          Hidden files
        </label>
        <button
          disabled={!selected || f.directories.has(selected)}
          onClick={() => open(selected)}
        >
          Open
        </button>
      </div>
    </section>
  );
}
function ObjectPreview({ name, viewId }: { name: string; viewId: string }) {
  const o = useObjects(), session = useSession(),
    observation = o.inspectors.get(name), object = observation?.binding,
    instance = useId();
  useEffect(() => {
    // Expanding a row requests its bounded content even below the scroll viewport.
    // The Layout view identity gates background reads while retained tabs are hidden.
    return o.registerDemand(`${viewId}:${instance}:${name}`, name, viewId);
  }, [o, name, viewId, instance]);
  if (!object)
    return <div><p className="muted">
      {session.runtime?.state === "busy" ? "R busy. No previous preview." : "Loading bounded preview…"}
      {o.notice && <span role="alert"> {o.notice}</span>}
    </p></div>;
  const columns =
    Array.isArray(object.preview) && object.classes.includes("data.frame")
      ? (object.preview as {
          name: string;
          type?: string;
          classes?: string[];
          values: JsonValue[] | null;
        }[])
      : null;
  return (
    <div className="object-preview">
      <div className="object-metadata">
        <span>
          {object.classes.join(", ") || object.object_type || object.kind}
        </span>
        <span>{summary(object)}</span>
      </div>
      {object.kind === "missing" ? (
        <p>This object no longer exists in the observed session.</p>
      ) : columns ? (
        <div className="dataframe-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                {columns.map((c, i) => (
                  <th
                    key={i}
                    title={[c.type, ...(c.classes ?? [])]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from(
                { length: Math.min(object.dimensions[0] ?? 0, 20) },
                (_, row) => (
                  <tr key={row}>
                    <th>{row + 1}</th>
                    {columns.map((c, i) => (
                      <td key={i}>
                        {c.values ? display(c.values[row]) : "Not previewed"}
                      </td>
                    ))}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : object.preview !== null ? (
        <pre>
          {Array.isArray(object.preview)
            ? object.preview.map(display).join("\n")
            : display(object.preview)}
        </pre>
      ) : (
        <p className="muted">Metadata only. User methods were not called.</p>
      )}
      {object.notice && <p className="muted">{object.notice}</p>}
      {object.truncated && (
        <p className="observation-notice">Preview truncated.</p>
      )}
      <small className="muted">
        Last observed {new Date(observation!.observedAt).toLocaleTimeString()}
        {session.runtime?.state === "busy" ? " · R busy" : observation?.stale ? " · Refresh pending" : ""}
      </small>
    </div>
  );
}
function display(value: JsonValue | undefined): string {
  if (value === undefined) return "Not previewed";
  if (value === null) return "NA";
  if (typeof value === "string" && /^(NA|NaN|[+-]?Inf)$/.test(value))
    return JSON.stringify(value);
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.kind &&
    value.label
  )
    return String(value.label);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
export function ObjectsPanel({ viewId = "objects" }: { viewId?: string }) {
  const o = useObjects(), session = useSession(), navigation = useNavigation(),
    [filter, setFilter] = useState("");
  const objects = o.data?.objects.filter((object) =>
    object.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  return (
    <section className="panel objects-panel">
      <div className="resource-search object-search">
        <input
          aria-label="Filter Objects"
          placeholder="Filter observed objects…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          title="Collapse All"
          aria-label="Collapse All"
          onClick={() => {
            o.collapseAll();
          }}
        >
          −
        </button>
      </div>
      <div className="object-list">
        {objects.map((object) => (
          <div key={object.name} className="object-entry">
            <div
              className={`object-row ${o.expanded.has(object.name) ? "selected" : ""}`}
            >
              <button
                className="object-name"
                aria-expanded={o.expanded.has(object.name)}
                onClick={() => {
                  o.toggleExpanded(object.name);
                }}
              >
                <span>{o.expanded.has(object.name) ? "⌄" : "›"}</span>
                <code>{object.name}</code>
              </button>
              <span className="object-type">
                {object.classes.join(", ") || object.object_type || object.kind}
              </span>
              <span className="object-size">{summary(object)}</span>
              <button
                className="icon-button object-open"
                aria-label={`Open ${object.name} in New Tab`}
                title="Open in New Tab"
                onClick={() => {
                  navigation.openObject(object.name);
                }}
              >
                ↗
              </button>
            </div>
            {o.expanded.has(object.name) && (
              <ObjectPreview name={object.name} viewId={viewId} />
            )}
          </div>
        ))}
        {!objects.length && (
          <p className="empty-message muted">
            {o.data
              ? "No match in the observed objects."
              : "Start R to observe objects."}
          </p>
        )}
        {filter && (
          <button
            onClick={() => {
              o.setExpanded(filter, true);
            }}
          >
            Inspect Exact Name: {filter}
          </button>
        )}
        {filter &&
          o.expanded.has(filter) &&
          !objects.some((o) => o.name === filter) && (
            <ObjectPreview name={filter} viewId={viewId} />
          )}
      </div>
      {(o.notice || (o.data && (o.stale || session.runtime?.state === "busy"))) && (
        <div className="object-notice">
          Last observation retained ·{" "}
          {session.runtime?.state === "busy" ? "R busy" : o.notice || "Refresh pending"}
        </div>
      )}
      <div className="panel-footer">
        <span>
          {o.data?.truncated
            ? `Showing ${o.data.objects.length} of ${o.data.total_bindings}`
            : `${o.data?.objects.length ?? 0} objects`}{" "}
          · .GlobalEnv
        </span>
      </div>
    </section>
  );
}
export function ObjectViewer({ name, viewId = `object:${name}` }: { name: string; viewId?: string }) {
  const o = useObjects(), session = useSession();
  return (
    <section className="panel object-viewer">
      <div className="resource-toolbar">
        <span>{name}</span>
        <div className="spacer" />
        <button
          disabled={session.runtime?.state !== "idle"}
          onClick={() => o.inspect(name)}
        >
          Refresh Preview
        </button>
      </div>
      <ObjectPreview name={name} viewId={viewId} />
      <div className="panel-footer">Read only · Up to 20 rows × 10 columns</div>
    </section>
  );
}
