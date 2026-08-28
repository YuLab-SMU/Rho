import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type {
  DomainSurfaceData,
  ResourceDescriptor,
  ResourceRegistrySnapshot,
  SurfaceInstance,
  UiKernelTransport,
} from "../transport/types";
import { PlotThumbnail } from "./PlotThumbnail";

type NavigatorTab = "files" | "runs";

const NAVIGATOR_TABS: readonly { readonly id: NavigatorTab; readonly label: string }[] = [
  { id: "files", label: "Files" },
  { id: "runs", label: "History" },
];

function fileGlyph(resourceId: string): string {
  const name = resourceId.split("/").pop() ?? resourceId;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "·";
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === "r" || ext === "rmd" || ext === "qmd") return "R";
  return ext.slice(0, 2).toUpperCase();
}

interface FileNode {
  readonly name: string;
  readonly path: string;
  readonly children: FileNode[];
  readonly descriptor: ResourceDescriptor | null;
}

function buildFileTree(resources: readonly ResourceDescriptor[]): FileNode[] {
  const roots: FileNode[] = [];
  const folders = new Map<string, FileNode>();
  const sorted = [...resources].sort((left, right) => left.resource_id.localeCompare(right.resource_id));
  for (const descriptor of sorted) {
    const segments = descriptor.resource_id.split("/").filter(Boolean);
    let siblings = roots;
    let prefix = "";
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      prefix = prefix === "" ? name : `${prefix}/${name}`;
      const leaf = index === segments.length - 1;
      if (leaf) {
        siblings.push({ name, path: prefix, children: [], descriptor });
        continue;
      }
      let folder = folders.get(prefix);
      if (folder == null) {
        folder = { name, path: prefix, children: [], descriptor: null };
        folders.set(prefix, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
  }
  return roots;
}

function filterFileTree(nodes: readonly FileNode[], query: string): FileNode[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...nodes];
  return nodes.flatMap((node) => {
    const matches = node.name.toLocaleLowerCase().includes(needle) ||
      node.path.toLocaleLowerCase().includes(needle);
    if (node.descriptor != null) return matches ? [node] : [];
    const children = matches ? node.children : filterFileTree(node.children, needle);
    return children.length === 0 ? [] : [{ ...node, children }];
  });
}

function FileTreeRows({
  nodes,
  depth,
  openFile,
}: {
  readonly nodes: readonly FileNode[];
  readonly depth: number;
  readonly openFile: (descriptor: ResourceDescriptor) => void;
}) {
  return <>
    {nodes.map((node) => node.descriptor == null ? (
      <details key={node.path} open={depth === 0}>
        <summary className="rho-nav-row rho-nav-folder" style={{ "--rho-nav-depth": depth } as CSSProperties}>
          <span className="rho-nav-row-label">{node.name}/</span>
        </summary>
        <FileTreeRows nodes={node.children} depth={depth + 1} openFile={openFile} />
      </details>
    ) : (
      <button
        type="button"
        className="rho-nav-row"
        data-nav-file={node.path}
        disabled={node.descriptor.status !== "ready"}
        key={node.path}
        onClick={() => openFile(node.descriptor!)}
        style={{ "--rho-nav-depth": depth } as CSSProperties}
      >
        <span className="rho-nav-file-glyph" aria-hidden="true">{fileGlyph(node.path)}</span>
        <span className="rho-nav-row-label">{node.name}</span>
        {node.descriptor.status !== "ready" && <span className="rho-nav-row-modified" aria-label={node.descriptor.status} />}
      </button>
    ))}
  </>;
}

function DomainRows({ data, emptyLabel }: { readonly data: DomainSurfaceData | null; readonly emptyLabel: string }) {
  if (data == null) return <p className="rho-nav-empty">Loading…</p>;
  if (data.items.length === 0) return <p className="rho-nav-empty">{emptyLabel}</p>;
  return <>
    {data.items.map((item) => (
      <div className="rho-nav-record" data-domain-id={item.id} key={item.id}>
        <span className={`rho-domain-state rho-domain-${item.status ?? "neutral"}`}>{item.status ?? "record"}</span>
        <span className="rho-nav-row-label" title={item.subtitle ?? item.title}>{item.title}</span>
        {item.subtitle != null && <small>{item.subtitle}</small>}
      </div>
    ))}
  </>;
}

export function NavigatorSurfaceView({
  instance,
  transport,
  resources,
  openFile,
  persist,
  reportError,
  openSurfaceById,
}: {
  readonly instance: SurfaceInstance;
  readonly transport: UiKernelTransport;
  readonly resources: ResourceRegistrySnapshot | null;
  readonly openFile: (descriptor: ResourceDescriptor) => Promise<void>;
  readonly persist: (viewState: unknown) => Promise<void>;
  readonly reportError: (error: unknown) => void;
  readonly openSurfaceById: (surfaceId: string) => void;
}) {
  const initialTab: NavigatorTab = typeof instance.view_state === "object" && instance.view_state != null &&
      "tab" in instance.view_state &&
      ["files", "runs"].includes(String(instance.view_state.tab))
    ? instance.view_state.tab as NavigatorTab
    : "files";
  const [tab, setTab] = useState<NavigatorTab>(initialTab);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const [domain, setDomain] = useState<DomainSurfaceData | null>(null);
  const [recent, setRecent] = useState<DomainSurfaceData | null>(null);
  const [recentOpen, setRecentOpen] = useState(
    typeof instance.view_state === "object" && instance.view_state != null &&
      "recent_open" in instance.view_state
      ? instance.view_state.recent_open === true
      : initialTab !== "files",
  );
  const selectTab = (next: NavigatorTab) => {
    if (next === tab) return;
    const nextRecentOpen = tab === "files" && next !== "files" ? true : recentOpen;
    setTab(next);
    setRecentOpen(nextRecentOpen);
    void persist({ tab: next, recent_open: nextRecentOpen }).catch(reportError);
  };
  const loadDomain = useCallback(async () => {
    try {
      setDomain(await transport.loadDomainSurface("rho.runs"));
    } catch (cause: unknown) {
      reportError(cause);
    }
  }, [tab, transport, reportError]);
  useEffect(() => {
    if (tab === "files") return;
    void loadDomain();
  }, [loadDomain, tab]);
  useEffect(() => {
    let cancelled = false;
    void transport.loadDomainSurface("rho.plots")
      .then((data) => { if (!cancelled) setRecent(data); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [transport]);
  const files = useMemo(
    () => buildFileTree((resources?.resources ?? []).filter((descriptor) => descriptor.resource_kind === "project_file")),
    [resources],
  );
  const visibleFiles = useMemo(() => filterFileTree(files, query), [files, query]);
  return (
    <section className="rho-navigator" aria-label="Project navigator">
      <div className="rho-navigator-controls">
        <div
          className="rho-navigator-tabs"
          role="tablist"
          aria-label="Navigator sections"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']")];
            const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
            if (current < 0) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0
              : event.key === "End" ? tabs.length - 1
              : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
              : (current + 1) % tabs.length;
            tabs[next]?.focus();
            tabs[next]?.click();
          }}
        >
          {NAVIGATOR_TABS.map((candidate) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === candidate.id}
              aria-controls={`rho-navigator-panel-${instance.instance_id}-${candidate.id}`}
              id={`rho-navigator-tab-${instance.instance_id}-${candidate.id}`}
              tabIndex={tab === candidate.id ? 0 : -1}
              key={candidate.id}
              onClick={() => selectTab(candidate.id)}
            >{candidate.label}</button>
          ))}
        </div>
        {tab === "files" && (
          <button
            type="button"
            className="rho-icon-btn rho-navigator-search-toggle"
            ref={searchToggleRef}
            aria-label={searchOpen ? "Close file search" : "Search project files"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((current) => !current);
              if (searchOpen) setQuery("");
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="m10 10 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {searchOpen && tab === "files" && (
        <div className="rho-navigator-search">
          <input
            autoFocus
            type="search"
            aria-label="Filter project files"
            placeholder="Find a file…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                setSearchOpen(false);
                searchToggleRef.current?.focus();
              }
            }}
          />
        </div>
      )}
      <div
        className="rho-navigator-body"
        id={`rho-navigator-panel-${instance.instance_id}-${tab}`}
        role="tabpanel"
        aria-labelledby={`rho-navigator-tab-${instance.instance_id}-${tab}`}
      >
        {tab === "files" && (
          visibleFiles.length === 0
            ? <p className="rho-nav-empty">{files.length === 0 ? "No project files resolved yet." : "No files match this search."}</p>
            : <FileTreeRows nodes={visibleFiles} depth={0} openFile={(descriptor) => void openFile(descriptor).catch(reportError)} />
        )}
        {tab === "runs" && <DomainRows data={domain} emptyLabel="No history yet." />}
      </div>
      {(recent?.items.length ?? 0) > 0 && (
        <details
          className="rho-navigator-recent"
          open={recentOpen}
          onToggle={(event) => {
            const next = event.currentTarget.open;
            if (next === recentOpen) return;
            setRecentOpen(next);
            void persist({ tab, recent_open: next }).catch(reportError);
          }}
        >
          <summary><span>Recent outputs</span><span>{recent!.items.length}</span></summary>
          {recent!.items.slice(0, 3).map((item) => (
            <div className="rho-nav-record rho-nav-record-output" key={item.id}>
              <PlotThumbnail plotId={item.id} transport={transport} className="rho-nav-output-image" />
              <span className="rho-nav-row-label" title={item.subtitle ?? item.title}>{item.title}</span>
            </div>
          ))}
          <button type="button" className="rho-navigator-open-outputs" onClick={() => openSurfaceById("rho.plots")}>Open Plots</button>
        </details>
      )}
    </section>
  );
}
