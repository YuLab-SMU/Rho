import { useEffect, useRef } from "react";
import { useFiles, useNavigation } from "../context";
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
                entries observed{results.continuation ? " · More pages available" : results.truncated ? " · See observation limits" : ""}
              </p>
            )}
            {f.getSnapshot().resultsStale && <p className="filter-notice">Cached results for “{f.getSnapshot().resultsQuery}”. Search again to refresh.</p>}
            {results?.continuation && <button disabled={!f.canContinueSearch} onClick={() => f.continueSearch()}>
              {searching ? "Searching…" : `Load More · ${results.entries.length} shown`}
            </button>}
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
export { ObjectsPanel, ObjectViewer } from "./object-panel";
