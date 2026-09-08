import { useEffect, useRef, useState } from "react";
import { useStudio } from "../context";
import { message } from "../host-client";
import type { FileSearchResult } from "../generated/FileSearchResult";
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
  const s = useStudio("files"),
    [filter, setFilter] = useState(""),
    [selected, setSelected] = useState(""),
    body = useRef<HTMLDivElement>(null);
  const [searchMode, setSearchMode] = useState(false),
    [scope, setScope] = useState(""),
    [results, setResults] = useState<FileSearchResult | null>(null),
    [searching, setSearching] = useState(false);
  useEffect(() => {
    for (const path of s.expandedDirectories)
      if (!s.directories.has(path)) void s.listDirectory(path);
  }, [s, s.project]);
  useEffect(() => {
    if (body.current) body.current.scrollTop = s.filesScrollTop;
  }, []);
  const open = (path: string, size?: number) =>
    void s.documents.open(path, size).catch((e) => {
      s.directoryError = message(e);
      s.emit("files");
    });
  function toggle(path: string) {
    if (s.expandedDirectories.has(path)) s.expandedDirectories.delete(path);
    else {
      s.expandedDirectories.add(path);
      if (!s.directories.has(path)) void s.listDirectory(path);
    }
    s.persist();
    s.emit("files");
  }
  function tree(path: string, depth = 0): React.ReactNode {
    const page = s.directories.get(path);
    return (
      <div role="group">
        {page?.entries
          .filter(
            (e) =>
              (s.showHiddenFiles || !e.name.startsWith(".")) &&
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
                  ? s.expandedDirectories.has(e.path)
                  : undefined
              }
              aria-selected={selected === e.path}
            >
              <button
                className={selected === e.path ? "selected" : ""}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={e.path}
                onClick={() => {
                  setSelected(e.path);
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
                    !s.expandedDirectories.has(e.path)
                  ) {
                    event.preventDefault();
                    toggle(e.path);
                  }
                  if (
                    event.key === "ArrowLeft" &&
                    s.expandedDirectories.has(e.path)
                  ) {
                    event.preventDefault();
                    toggle(e.path);
                  }
                }}
              >
                <span className="file-icon">
                  {e.kind === "directory"
                    ? s.expandedDirectories.has(e.path)
                      ? "⌄"
                      : "›"
                    : /\.r$/i.test(e.name)
                      ? "R"
                      : "▤"}
                </span>
                <span className="file-name">{e.name}</span>
              </button>
              {e.kind === "directory" &&
                s.expandedDirectories.has(e.path) &&
                tree(e.path, depth + 1)}
            </div>
          ))}
        {!page && <p className="muted">Loading directory…</p>}
        {page?.next_name && (
          <button onClick={() => void s.listDirectory(path, true)}>
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
          onClick={() => s.documents.create()}
        >
          ＋
        </button>
        <button
          aria-label="Refresh Files"
          title="Refresh Files"
          onClick={() => {
            for (const p of s.expandedDirectories) void s.listDirectory(p);
          }}
        >
          ↻
        </button>
        <button onClick={() => s.openFile?.()}>Open…</button>
      </div>
      <form
        className="resource-search file-search"
        onSubmit={(e) => {
          e.preventDefault();
          if (!searchMode || !s.project || !filter.trim()) return;
          setSearching(true);
          void s.client
            .query(s.project, "project.search_files", {
              text: filter,
              show_hidden: s.showHiddenFiles,
            })
            .then((result) => {
              if (result.status !== "ready")
                throw new Error(result.notices.join("\n"));
              setResults(result.data as FileSearchResult);
            })
            .catch((e) => {
              s.directoryError = message(e);
              s.emit("files");
            })
            .finally(() => setSearching(false));
        }}
      >
        <select
          aria-label="File Search Scope"
          value={searchMode ? "project" : "directory"}
          onChange={(e) => {
            setSearchMode(e.target.value === "project");
            setResults(null);
          }}
        >
          <option value="directory">Filter Directory</option>
          <option value="project">Search Project</option>
        </select>
        {!searchMode && (
          <select
            aria-label="Filter Directory"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            {[...s.expandedDirectories].map((path) => (
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
          onChange={(e) => setFilter(e.target.value)}
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
      {s.directoryError && (
        <div role="alert" className="document-error">
          {s.directoryError}
        </div>
      )}
      <div
        className="file-list"
        role="tree"
        aria-label="Project Files"
        ref={body}
        onScroll={(e) => {
          s.filesScrollTop = e.currentTarget.scrollTop;
          s.persist();
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
                onClick={() => setSelected(entry.path)}
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
            checked={s.showHiddenFiles}
            onChange={(e) => {
              s.showHiddenFiles = e.target.checked;
              s.persist();
              s.emit("files");
            }}
          />{" "}
          Hidden files
        </label>
        <button
          disabled={!selected || s.directories.has(selected)}
          onClick={() => open(selected)}
        >
          Open
        </button>
      </div>
    </section>
  );
}
function ObjectPreview({ name }: { name: string }) {
  const s = useStudio("objects", "runtime"),
    observation = s.inspectors.get(name),
    object = observation?.binding,
    visible = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) s.visibleObjects.add(name);
        else s.visibleObjects.delete(name);
      }
    });
    if (visible.current) observer.observe(visible.current);
    return () => {
      observer.disconnect();
      s.visibleObjects.delete(name);
    };
  }, [s, name, !!object]);
  if (!object)
    return (
      <p className="muted">
        {s.runtime?.state === "busy"
          ? "R busy. No previous preview."
          : "Loading bounded preview…"}
      </p>
    );
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
    <div className="object-preview" ref={visible}>
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
        {s.runtime?.state === "busy" ? " · R busy" : ""}
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
export function ObjectsPanel() {
  const s = useStudio("objects", "runtime"),
    [filter, setFilter] = useState("");
  const objects =
    s.objects?.objects.filter((o) =>
      o.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) ?? [];
  function inspect(name: string) {
    void s.inspectObject(name).catch((e) => {
      s.objectsNotice = message(e);
      s.emit("objects");
    });
  }
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
            s.expandedObjects.clear();
            s.emit("objects");
          }}
        >
          −
        </button>
      </div>
      <div className="object-list">
        {objects.map((object) => (
          <div key={object.name} className="object-entry">
            <div
              className={`object-row ${s.expandedObjects.has(object.name) ? "selected" : ""}`}
            >
              <button
                className="object-name"
                aria-expanded={s.expandedObjects.has(object.name)}
                onClick={() => {
                  if (s.expandedObjects.has(object.name))
                    s.expandedObjects.delete(object.name);
                  else {
                    s.expandedObjects.add(object.name);
                    inspect(object.name);
                  }
                  s.emit("objects");
                }}
              >
                <span>{s.expandedObjects.has(object.name) ? "⌄" : "›"}</span>
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
                  s.showPanel?.(
                    "viewer",
                    `object:${object.name}`,
                    object.name,
                    { name: object.name },
                  );
                  inspect(object.name);
                }}
              >
                ↗
              </button>
            </div>
            {s.expandedObjects.has(object.name) && (
              <ObjectPreview name={object.name} />
            )}
          </div>
        ))}
        {!objects.length && (
          <p className="empty-message muted">
            {s.objects
              ? "No match in the observed objects."
              : "Start R to observe objects."}
          </p>
        )}
        {filter && (
          <button
            onClick={() => {
              s.expandedObjects.add(filter);
              inspect(filter);
            }}
          >
            Inspect Exact Name: {filter}
          </button>
        )}
        {filter &&
          s.expandedObjects.has(filter) &&
          !objects.some((o) => o.name === filter) && (
            <ObjectPreview name={filter} />
          )}
      </div>
      {s.objectsNotice && (
        <div className="object-notice">
          Last observation retained ·{" "}
          {s.runtime?.state === "busy" ? "R busy" : s.objectsNotice}
        </div>
      )}
      <div className="panel-footer">
        <span>
          {s.objects?.truncated
            ? `Showing ${s.objects.objects.length} of ${s.objects.total_bindings}`
            : `${s.objects?.objects.length ?? 0} objects`}{" "}
          · .GlobalEnv
        </span>
      </div>
    </section>
  );
}
export function ObjectViewer({ name }: { name: string }) {
  const s = useStudio("objects", "runtime");
  return (
    <section className="panel object-viewer">
      <div className="resource-toolbar">
        <span>{name}</span>
        <div className="spacer" />
        <button
          disabled={s.runtime?.state !== "idle"}
          onClick={() => void s.inspectObject(name)}
        >
          Refresh Preview
        </button>
      </div>
      <ObjectPreview name={name} />
      <div className="panel-footer">Read only · Up to 20 rows × 10 columns</div>
    </section>
  );
}
