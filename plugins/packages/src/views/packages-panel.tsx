import { useEffect, useId, useRef, useState } from "react";
import { usePackages, useSession, useNavigation } from "../view-services.js";
import { Icon } from "../icons.js";
import { Modal } from "../primitives.js";
import type { PackageView } from "../packages.js";
import { PackageInspector, packageState } from "./package-inspector.js";

export function PackagesPanel({ viewId = "packages" }: { viewId?: string }) {
  const p = usePackages(), session = useSession(), navigation = useNavigation(), instance = useId();
  const root = useRef<HTMLDivElement>(null),
    body = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [wide, setWide] = useState(false),
    [librariesOpen, setLibrariesOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const busy = session.runtime?.state === "busy",
    unavailable = !session.runtime || session.runtime.state === "unavailable",
    data = p.data;
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      p.setVisible(`${viewId}:${instance}`, entry.isIntersecting, viewId);
    });
    const resize = new ResizeObserver(([entry]) =>
      setWide(entry.contentRect.width >= 1000),
    );
    if (root.current) {
      observer.observe(root.current);
      resize.observe(root.current);
    }
    return () => {
      observer.disconnect();
      resize.disconnect();
      p.setVisible(`${viewId}:${instance}`, false, viewId);
    };
  }, [p, viewId, instance]);
  useEffect(() => {
    if (body.current) body.current.scrollTop = p.scrollTop;
  }, [p, p.offset, p.filter, p.mode]);
  const filtered = p.filtered,
    groups = p.page,
    selected = p.selected ? p.groups.get(p.selected) : undefined;
  const select = (mode: PackageView) => p.select(p.filter, mode);
  function openLibraries(target: HTMLElement) {
    returnFocus.current = target;
    setLibrariesOpen(true);
  }
  const count = (n?: number) =>
    n === undefined ? "" : `${n}${data?.scan_complete ? "" : "+"}`;
  const tabs: [PackageView, string, number | undefined][] = [
    ["installed", "All", data?.counts.all],
    ["loaded", "Loaded", data?.counts.loaded],
    ["attached", "Attached", data?.counts.attached],
  ];
  const modeSelector = (
    <select
      className="package-view-select"
      aria-label="Package View"
      value={p.mode}
      onChange={(event) => select(event.target.value as PackageView)}
    >
      {[
        ...tabs,
        [
          "multiple",
          "Multiple copies",
          data?.counts.multiple,
        ] as (typeof tabs)[number],
      ].map(([mode, label, value]) => (
        <option key={mode} value={mode}>
          {label} {count(value)}
        </option>
      ))}
    </select>
  );
  return (
    <div
      className={`panel packages-panel ${wide ? "packages-wide" : "packages-compact"}`}
      ref={root}
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          search.current?.focus();
          search.current?.select();
        }
        if (
          event.key === "Escape" &&
          p.selected &&
          !(event.target as HTMLElement).closest("input,select,[role=dialog]")
        ) {
          event.preventDefault();
          const name = p.selected;
          p.pick(name, true);
          rows.current.get(name)?.focus();
        }
      }}
    >
      <div className="package-toolbar">
        <div className="package-search">
          <Icon name="search" />
          <input
            ref={search}
            aria-label="Search Packages"
            placeholder={
              wide ? "Find a package or search its purpose…" : "Find packages…"
            }
            value={p.filter}
            maxLength={128}
            onChange={(event) => p.select(event.target.value)}
          />
          <span className="package-search-shortcut" aria-hidden="true">
            ⌘ F
          </span>
        </div>
        {modeSelector}
        <div className="package-toolbar-spacer" />
        {wide && (
          <button
            className="package-runtime-button"
            disabled={!data}
            onClick={(event) => openLibraries(event.currentTarget)}
          >
            R {data?.r_version ?? "—"} · {data?.library_paths.length ?? 0}{" "}
            libraries <span aria-hidden="true">⌄</span>
          </button>
        )}
        <button
          className="package-refresh"
          aria-label="Refresh Packages"
          title={
            busy ? "R busy; showing the last observation" : "Refresh Packages"
          }
          disabled={p.loading || busy || unavailable}
          onClick={() => {
            p.requestRefresh();
          }}
        >
          <Icon name="reset" />
          <span>{p.loading ? "Reading…" : "Refresh"}</span>
        </button>
      </div>
      <div className="package-filter-bar">
        <div className="package-tabs" role="group" aria-label="Package views">
          {tabs.map(([mode, label, value]) => (
            <button
              key={mode}
              aria-label={`${label} ${count(value)}`}
              aria-pressed={p.mode === mode}
              onClick={() => select(mode)}
            >
              {label} <span>{count(value)}</span>
            </button>
          ))}
        </div>
        <button
          className={`package-multiple ${p.mode === "multiple" ? "selected" : ""}`}
          aria-pressed={p.mode === "multiple"}
          onClick={() =>
            select(p.mode === "multiple" ? "installed" : "multiple")
          }
        >
          Multiple copies <span>{count(data?.counts.multiple)}</span>
        </button>
        <label className="package-sort">
          <select
            aria-label="Package Order"
            value={p.descending ? "desc" : "asc"}
            onChange={(event) => {
              p.setDescending(event.target.value === "desc");
            }}
          >
            <option value="asc">Name A–Z</option>
            <option value="desc">Name Z–A</option>
          </select>
        </label>
      </div>
      {busy && (
        <div className="package-busy">
          <span className="package-busy-dot" />
          <strong>R busy</strong>
          <span>
            {p.observedAt
              ? `Showing the ${new Date(p.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} observation`
              : "Package observation will resume when idle."}
          </span>
        </div>
      )}
      {unavailable && data && (
        <div className="package-notice">
          R unavailable · Showing the last observation
        </div>
      )}
      {p.notice && (
        <div className="package-notice" role="alert">
          {p.notice}
          {!p.expired && <button onClick={() => p.retry()} disabled={p.loading || busy}>Retry</button>}
        </div>
      )}
      {data && !data.scan_complete && (
        <div className="package-notice package-warning">
          <strong>Incomplete library observation</strong>
          <details>
            <summary>Review library status</summary>
            {data.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
            <button
              className="text-button"
              onClick={(event) => openLibraries(event.currentTarget)}
            >
              View library paths
            </button>
          </details>
        </div>
      )}
      {data && !p.completeIndex && (
        <div className="package-index-status">
          {p.loading ? "Reading package index" : "Searching cached packages"} ·{" "}
          {p.groups.size} of {data.counts.all}
          {busy ? " · Results cover cached rows only" : ""}
        </div>
      )}
      <div className="package-workspace">
        <div className="package-directory">
          {wide && (
            <div className="package-columns" aria-hidden="true">
              <span>Package / purpose</span>
              <span>Version</span>
              <span>Source</span>
              <span>Session</span>
              <span>Copies</span>
              <span />
            </div>
          )}
          <div
            className="package-scroll"
            ref={body}
            onScroll={(event) => {
              p.setScroll(event.currentTarget.scrollTop);
            }}
          >
            {!session.runtime ? (
              <div className="package-empty">
                <h3>No R session</h3>
                <p>Connect an R session to inspect its packages.</p>

              </div>
            ) : !data ? (
              <div className="package-empty">
                <h3>
                  {p.loading
                    ? "Reading package metadata…"
                    : "Packages not observed"}
                </h3>
                <p>
                  The current session's library paths and loaded namespaces will
                  appear here.
                </p>
              </div>
            ) : !filtered.length ? (
              <div className="package-empty">
                <h3>
                  {p.filter
                    ? `No matches for “${p.filter}”`
                    : p.mode === "multiple"
                      ? "No multiple installations observed"
                      : "No packages match this view"}
                </h3>
                <p>
                  {!p.completeIndex
                    ? `Only ${p.groups.size} of ${data.counts.all} package rows are cached.`
                    : !data.scan_complete
                      ? "Some libraries could not be read. A package may exist outside this observation."
                      : p.mode === "installed"
                        ? `Not found in the ${data.library_paths.length} library paths visible to this R session. Other R environments were not checked.`
                        : `No matching ${p.mode === "loaded" ? "loaded namespaces" : p.mode === "attached" ? "attached packages" : "multiple installations"} in this observation.`}
                </p>
                {p.mode !== "installed" && (
                  <button
                    className="text-button"
                    onClick={() => select("installed")}
                  >
                    Search all packages
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={(event) => openLibraries(event.currentTarget)}
                >
                  View library paths ›
                </button>
              </div>
            ) : (
              <div
                className="package-list"
                role="list"
                aria-label="Package list"
              >
                {groups.map((group, index) => (
                  <div
                    className="package-item"
                    role="listitem"
                    key={group.name}
                  >
                    <button
                      ref={(element) => {
                        if (element) rows.current.set(group.name, element);
                        else rows.current.delete(group.name);
                      }}
                      className={`package-row ${p.selected === group.name ? "selected" : ""}`}
                      aria-label={`${group.name}, ${group.version}, ${packageState(group)}, ${group.copy_count} installed ${group.copy_count === 1 ? "copy" : "copies"}`}
                      aria-expanded={p.selected === group.name}
                      onClick={() => p.pick(group.name, !wide)}
                      onKeyDown={(event) => {
                        if (
                          ["ArrowDown", "ArrowUp", "Home", "End"].includes(
                            event.key,
                          )
                        ) {
                          event.preventDefault();
                          const next =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? groups.length - 1
                                : Math.max(
                                    0,
                                    Math.min(
                                      groups.length - 1,
                                      index +
                                        (event.key === "ArrowDown" ? 1 : -1),
                                    ),
                                  );
                          rows.current.get(groups[next].name)?.focus();
                        }
                        if (event.key === "ArrowRight") {
                          event.preventDefault();
                          p.pick(group.name);
                        }
                        if (
                          event.key === "ArrowLeft" &&
                          p.selected === group.name
                        ) {
                          event.preventDefault();
                          p.pick(group.name, true);
                        }
                      }}
                    >
                      <span
                        className={`package-dot ${group.attached ? "attached" : group.loaded_version ? "loaded" : ""}`}
                        aria-hidden="true"
                      />
                      <span className="package-description">
                        <span className="package-name-line">
                          <strong>{group.name}</strong>
                          {group.copy_count > 1 && (
                            <span className="package-inline-copies">
                              {group.copy_count} copies
                            </span>
                          )}
                        </span>
                        <span
                          className="package-row-purpose"
                          title={group.title ?? "Purpose not recorded"}
                        >
                          {group.title ?? "Purpose not recorded"}
                        </span>
                      </span>
                      <span
                        className="package-version"
                        title={
                          group.loaded_version
                            ? "Loaded version"
                            : "Version first in library order"
                        }
                      >
                        {group.version}
                      </span>
                      <span
                        className="package-row-source"
                        title={
                          group.source_count > 1
                            ? "Sources differ across observed copies"
                            : "Source from the identified loaded copy, otherwise the first installed copy"
                        }
                      >
                        {group.source_kind}
                        {group.source_count > 1
                          ? ` +${group.source_count - 1}`
                          : ""}
                      </span>
                      <span
                        className={`package-session-label ${group.attached ? "attached" : group.loaded_version ? "loaded" : ""}`}
                      >
                        {group.attached
                          ? "Attached"
                          : group.loaded_version
                            ? "Loaded"
                            : "—"}
                      </span>
                      <span className="package-row-copies">
                        {group.copy_count > 1
                          ? `${group.copy_count} copies`
                          : group.copy_count || "Outside paths"}
                      </span>
                      <span className="package-row-arrow" aria-hidden="true">
                        ›
                      </span>
                    </button>
                    {!wide && p.selected === group.name && (
                      <PackageInspector group={group} inline />
                    )}
                  </div>
                ))}
              </div>
            )}
            {filtered.length > 100 && (
              <nav className="package-pagination" aria-label="Package pages">
                <span>
                  {p.offset + 1}–{Math.min(p.offset + 100, filtered.length)} of{" "}
                  {filtered.length} matches
                </span>
                <button
                  disabled={p.offset === 0}
                  onClick={() => p.select(p.filter, p.mode, p.offset - 100)}
                >
                  Previous
                </button>
                <button
                  disabled={p.offset + 100 >= filtered.length}
                  onClick={() => p.select(p.filter, p.mode, p.offset + 100)}
                >
                  Next
                </button>
              </nav>
            )}
          </div>
        </div>
        {wide && (
          <aside className="package-inspector-scroll">
            {selected ? (
              <PackageInspector group={selected} />
            ) : (
              <div className="package-empty package-inspector-empty">
                <h3>Inspect a package</h3>
                <p>
                  Select a row to compare installed copies, the loaded version
                  and recorded source.
                </p>
              </div>
            )}
          </aside>
        )}
      </div>
      <footer className="package-footer" role="status">
        {wide ? (
          <span>
            {data
              ? `${count(data.counts.all)} packages · ${count(data.counts.installations)} installations`
              : "No package observation"}
          </span>
        ) : (
          <button
            className="package-runtime-button"
            disabled={!data}
            onClick={(event) => openLibraries(event.currentTarget)}
          >
            R {data?.r_version ?? "—"} · {data?.library_paths.length ?? 0}{" "}
            libraries <span aria-hidden="true">⌄</span>
          </button>
        )}
        <span
          title={
            p.observedAt ? new Date(p.observedAt).toLocaleString() : undefined
          }
        >
          {p.observedAt
            ? `Observed ${new Date(p.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Not observed"}
          {p.stale && data && !busy ? " · Refresh pending" : wide ? (busy ? " · R busy" : " · R idle") : ""}
        </span>
      </footer>
      {librariesOpen && data && (
        <Modal
          title="R & libraries"
          description="The active session's R installation and library search order."
          onClose={() => {
            setLibrariesOpen(false);
            requestAnimationFrame(() => returnFocus.current?.focus());
          }}
        >
          <div className="package-library-details">
            <div className="package-detail-line">
              <h3>R {data.r_version}</h3>
              <span className="muted">{data.platform}</span>
            </div>
            <dl className="package-facts">
              <dt>R home</dt>
              <dd>{data.r_home}</dd>
            </dl>
            <h4>Library search order</h4>
            {data.libraries.map((lib) => (
              <div className="package-library-info" key={lib.index}>
                <span className="package-library-index">{lib.index}</span>
                <div>
                  <p>{lib.path}</p>
                  {lib.status !== "readable" && (
                    <p className="package-warning">
                      {lib.notice ?? lib.status}
                    </p>
                  )}
                </div>
              </div>
            ))}
            <p className="muted">
              Read from the active R session at{" "}
              {new Date(p.observedAt!).toLocaleTimeString()}.
              {busy
                ? " R is now busy; these paths are the last observation."
                : ""}
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
