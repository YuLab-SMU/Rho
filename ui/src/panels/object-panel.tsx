import { useEffect, useId, useMemo, useState, useRef } from "react";
import { useObjects, useSession, useNavigation, useConsole } from "../context";
import type { ObjectMetadata } from "../generated/ObjectMetadata";
import type { ObjectReadPage } from "../generated/ObjectReadPage";
import type { ObjectPathElement } from "../generated/ObjectPathElement";
import type { ObjectReadKind } from "../generated/ObjectReadKind";
import {
  attribute,
  colorValue,
  numberLabel,
  objectExpression,
  objectSize,
  objectType,
} from "../object-values";
import { ObjectGrid } from "./object-grid";
import {
  ScalarValue,
  TextDetail,
  useObjectView,
  usePage,
} from "./object-common";
import "./object-panel.css";
const preferred = (m: ObjectMetadata | null): ObjectReadKind =>
  m?.supported_reads.includes("table")
    ? "table"
    : m?.supported_reads.includes("children")
      ? "children"
      : m?.supported_reads.includes("values")
        ? "values"
        : m?.supported_reads.includes("text")
          ? "text"
          : "structure";
function Sample({ metadata: m }: { metadata: ObjectMetadata | null }) {
  if (!m) return null;
  const values = m.preview ?? [];
  if (values.length && values.every((v) => colorValue(v)))
    return (
      <span className="object-color-sample">
        {values.map((v, i) => (
          <span
            key={i}
            className="object-swatch"
            title={v.text!}
            style={{ backgroundColor: colorValue(v)! }}
          />
        ))}
        {(m.length ?? 0) > values.length && (
          <small>+{numberLabel(m.length! - values.length)}</small>
        )}
      </span>
    );
  if (values.length)
    return (
      <span className="object-sample">
        {values.map((v, i) => (
          <ScalarValue key={i} value={v} metadata={m} raw={m.object_type !== "character" && v.text !== null} />
        ))}
        {(m.length ?? 0) > values.length && <span>…</span>}
      </span>
    );
  if (m.length === 0)
    return (
      <code>{m.object_type === "NULL" ? "NULL" : `${m.object_type}(0)`}</code>
    );
  return (
    <span className="muted">
      {attribute(m, "names").join(", ") ||
        (m.kind !== "value" ? "Not evaluated" : "Open details")}
    </span>
  );
}
export function ObjectsPanel({ viewId = "objects" }: { viewId?: string }) {
  const o = useObjects(),
    session = useSession(),
    nav = useNavigation();
  const [savedFilter, saveFilter] = useObjectView("directory:filter", "");
  const [filter, setFilter] = useState(savedFilter);
  const filterInput = useRef<HTMLInputElement>(null),
    composing = useRef(false);
  useEffect(() => {
    if (!composing.current && document.activeElement !== filterInput.current)
      setFilter(savedFilter);
  }, [savedFilter, session.project]);
  const [type, setType] = useObjectView("directory:type", "");
  const entries = o.data?.objects ?? [],
    types = [
      ...new Set(entries.map((x) => objectType(o.metadata(x.name)))),
    ].sort();
  const visible = entries.filter(
    (x) =>
      x.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) &&
      (!type || objectType(o.metadata(x.name)) === type),
  );
  return (
    <section className="panel objects-panel object-directory">
      <div className="resource-search object-search">
        <input
          ref={filterInput}
          aria-label="Filter Objects"
          placeholder="Find objects…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            if (!(e.nativeEvent as InputEvent).isComposing)
              saveFilter(e.target.value);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            saveFilter(e.currentTarget.value);
          }}
        />
        <select
          aria-label="Object type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">All types</option>
          {types.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <button
          aria-label="Refresh Objects"
          title="Refresh Objects"
          disabled={session.runtime?.state !== "idle"}
          onClick={() => o.refresh()}
        >
          ↻
        </button>
        <button
          aria-label="Collapse All"
          title="Collapse All"
          onClick={() => o.collapseAll()}
        >
          −
        </button>
      </div>
      <div className="object-column-head">
        <span>Name</span>
        <span>Type</span>
        <span>Size</span>
        <span>Value / content</span>
      </div>
      <div className="object-list">
        {visible.map((x) => {
          const m = o.metadata(x.name);
          return (
            <div className="object-entry" key={x.name}>
              <div
                className={`object-row ${m?.preview?.length && !m.dimensions.length && (m.length === 1 || m.preview.every(v => colorValue(v))) ? "has-preview" : ""} ${o.expanded.has(x.name) ? "selected" : ""}`}
              >
                <button
                  className="object-name"
                  aria-expanded={o.expanded.has(x.name)}
                  onClick={() => o.toggleExpanded(x.name)}
                >
                  <span>{o.expanded.has(x.name) ? "⌄" : "›"}</span>
                  <code title={x.name}>{x.name}</code>
                </button>
                <span className="object-type" title={m?.classes.join(", ")}>
                  {objectType(m)}
                  {m?.object_type === "character" &&
                    m.length === 1 &&
                    m.preview?.[0]?.text_characters != null && (
                      <small className="compact-string-length">
                        {" "}
                        · {m.preview[0].text_characters} chars
                      </small>
                    )}
                </span>
                <span className="object-size">{objectSize(m)}</span>
                <div className="object-row-sample">
                  <Sample metadata={m} />
                </div>
                <button
                  className="object-open icon-button"
                  title="Open in New Tab"
                  aria-label={`Open ${x.name} in New Tab`}
                  onClick={() => nav.openObject(x.name)}
                >
                  ↗
                </button>
              </div>
              {o.expanded.has(x.name) && (
                <ObjectInspector name={x.name} viewId={viewId} inline />
              )}
            </div>
          );
        })}
        {!visible.length && (
          <p className="empty-message muted">
            {entries.length
              ? "No matching objects."
              : session.runtime
                ? "No objects observed."
                : "Start R to observe objects."}
          </p>
        )}
        {filter && !entries.some((x) => x.name === filter) && (
          <button onClick={() => o.setExpanded(filter, true)}>
            Inspect Exact Name: {filter}
          </button>
        )}
        {filter &&
          o.expanded.has(filter) &&
          !entries.some((x) => x.name === filter) && (
            <ObjectInspector name={filter} viewId={viewId} inline />
          )}
      </div>
      {(o.notice || o.stale || o.getSnapshot().indexExpired || session.runtime?.state === "busy") && (
        <div className="object-observation-status" role="status">
          {session.runtime?.state === "busy"
            ? "R busy · Showing the last observation"
            : o.getSnapshot().indexExpired
              ? "Last observation retained · Refresh to read current objects"
              : o.notice || "Refreshing objects…"}
        </div>
      )}
      <div className="panel-footer">
        <span>
          {entries.length} of {o.data?.total_bindings ?? 0} objects · .GlobalEnv
        </span>
        {o.data?.truncated && (
          <button disabled={!o.canLoadMore} onClick={() => o.loadMore()}>
            Load More
          </button>
        )}
      </div>
    </section>
  );
}
export function ObjectViewer({
  name,
  viewId = `object:${name}`,
  path = [],
}: {
  name: string;
  viewId?: string;
  path?: ObjectPathElement[];
}) {
  const o = useObjects(),
    session = useSession(),
    m = o.metadata(name);
  return (
    <section className="panel object-viewer">
      <div className="object-viewer-heading">
        <code>{name}</code>
        <span>
          {objectType(m)} · {objectSize(m)}
        </span>
        <div className="spacer" />
        <small>Read only</small>
        <button
          disabled={session.runtime?.state !== "idle"}
          onClick={() => o.inspect(name)}
        >
          Refresh
        </button>
      </div>
      <ObjectInspector name={name} viewId={viewId} path={path} />
    </section>
  );
}
export function ObjectInspector({
  name,
  viewId,
  inline = false,
  path = [],
  metadata,
}: {
  name: string;
  viewId: string;
  inline?: boolean;
  path?: ObjectPathElement[];
  metadata?: ObjectMetadata;
}) {
  const o = useObjects(),
    nav = useNavigation(),
    runtime = useSession(),
    consoleOwner = useConsole(),
    token = useId();
  const metaPage = usePage(
    name,
    { kind: "structure", path },
    false,
    path.length > 0 && !metadata,
  );
  const m =
      metadata ??
      (path.length ? (metaPage.page?.metadata ?? null) : o.metadata(name)),
    baseKey = `${viewId}:${name}:${JSON.stringify(path)}`;
  useEffect(
    () => o.registerDemand(token, name, viewId),
    [o, token, name, viewId],
  );
  const [kind, setKind] = useObjectView<ObjectReadKind | "attributes" | null>(
    baseKey + ":kind",
    null,
  );
  const chosen =
    kind && (kind === "attributes" || m?.supported_reads.includes(kind))
      ? kind
      : preferred(m);
  const [start, setStart] = useObjectView(baseKey + ":start", 1);
  const options = useMemo(
    () => ({
      kind: chosen === "attributes" ? ("structure" as const) : chosen,
      path,
      start,
      limit: inline ? 5 : 100,
      column_limit: inline ? 4 : 20,
    }),
    [chosen, JSON.stringify(path), start, inline],
  );
  const result = usePage(name, options, inline, chosen !== "table"),
    p = result.page;
  const isStale =
    o.inspectors.get(name)?.stale || runtime.runtime?.state !== "idle";
  const [expanded, setExpanded] = useObjectView<number[]>(
    baseKey + ":children",
    [],
  );
  const [selected, setSelected] = useObjectView(baseKey + ":selected", 0);
  const [copyNotice, setCopyNotice] = useState("");
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyNotice("Copied");
    } catch {
      setCopyNotice("Clipboard unavailable");
    }
  }
  const modes =
    m?.supported_reads.filter(
      (x) =>
        !["names", "structure"].includes(x) &&
        (x !== "text" ||
          [
            "character",
            "closure",
            "builtin",
            "special",
            "language",
            "expression",
            "symbol",
          ].includes(m.object_type ?? "")),
    ) ?? [];
  const readPage = p?.kind === chosen ? p : undefined;
  return (
    <div
      className={`object-preview object-inspector ${inline ? "is-inline" : "is-dedicated"}`}
    >
      {(!inline || modes.length > 1) && (
        <div className="object-read-tabs">
          {[...modes, "attributes"].map((mode) => (
            <button
              key={mode}
              aria-pressed={chosen === mode}
              onClick={() => {
                setKind(mode as ObjectReadKind | "attributes");
                setStart(1);
              }}
            >
              {(
                {
                  table: "Table",
                  children: "Contents",
                  values: "Values",
                  levels: "Levels",
                  text: "Text",
                  attributes: "Attributes",
                } as Record<string, string>
              )[mode] ?? mode}
            </button>
          ))}
        </div>
      )}
      {chosen === "table" ? (
        <ObjectGrid
          name={name}
          viewId={viewId}
          path={path}
          metadata={m}
          inline={inline}
          initial={readPage}
        />
      ) : chosen === "attributes" ? (
        <div className="object-attributes">
          <p>
            <span>Type</span>
            <code>{m?.object_type}</code>
          </p>
          <p>
            <span>Class</span>
            <code>{m?.classes.join(", ") || "—"}</code>
          </p>
          {m?.attributes.map((a) => (
            <p key={a.name}>
              <span>{a.name}</span>
              <code>{a.values.join(", ")}</code>
            </p>
          ))}
        </div>
      ) : chosen === "children" && readPage && !inline ? (
        <ContainerView
          name={name}
          viewId={viewId}
          path={path}
          page={readPage}
        />
      ) : chosen === "children" && readPage ? (
        <div className="object-children">
          {readPage.children.map((child) => (
            <div key={child.index}>
              <div className="object-child-row">
                <button
                  aria-expanded={expanded.includes(child.index)}
                  onClick={() =>
                    setExpanded(
                      expanded.includes(child.index)
                        ? expanded.filter((x) => x !== child.index)
                        : [...expanded, child.index],
                    )
                  }
                >
                  <span>{expanded.includes(child.index) ? "⌄" : "›"}</span>
                  <code>{child.name ?? `[[${child.index}]]`}</code>
                </button>
                <span>{objectType(child.metadata)}</span>
                <span>{objectSize(child.metadata)}</span>
                <Sample metadata={child.metadata} />
                <button
                  title="Open in New Tab"
                  aria-label={`Open ${child.name ?? child.index} in New Tab`}
                  onClick={() =>
                    nav.openObject(name, [
                      ...path,
                      { kind: "index", index: child.index },
                    ])
                  }
                >
                  ↗
                </button>
              </div>
              {expanded.includes(child.index) && (
                <ObjectInspector
                  name={name}
                  viewId={viewId}
                  inline
                  path={[...path, { kind: "index", index: child.index }]}
                  metadata={child.metadata}
                />
              )}
            </div>
          ))}
        </div>
      ) : (chosen === "values" || chosen === "levels") && readPage ? (
        <>
          <div className="object-values-list">
            {readPage.values.map((v, i) => (
              <button
                key={i}
                className={selected === i ? "selected" : ""}
                onClick={() => setSelected(i)}
              >
                <span className="object-index">{readPage.start + i}</span>
                <ScalarValue
                  value={v}
                  metadata={chosen === "levels" ? null : m}
                />
                <small>
                  {v.kind === "factor"
                    ? `code ${v.number}`
                    : v.text_characters != null
                      ? `${numberLabel(v.text_characters)} chars`
                      : ""}
                </small>
              </button>
            ))}
          </div>
          {!inline && readPage.values[selected]?.text != null && (
            <TextDetail
              name={name}
              path={path}
              index={readPage.start + selected}
              value={readPage.values[selected]}
              baseKey={baseKey}
              textAttribute={chosen === "levels" ? "levels" : undefined}
            />
          )}
        </>
      ) : chosen === "text" && readPage ? (
        <TextDetail
          name={name}
          path={path}
          index={start}
          value={readPage.values[0]}
          baseKey={baseKey}
        />
      ) : chosen === "structure" && m ? (
        <div className="object-metadata-only">
          <strong>Metadata only</strong>
          <p>
            {m.kind !== "value"
              ? "This binding has not been evaluated."
              : "Content preview is not available for this class."}
          </p>
          <button onClick={() => copy(name)}>Copy name</button>
          {m.classes.some((c) => /ggplot/.test(c)) &&
            (path.length === 0 || o.metadata(name)?.object_type !== "S4") && (
              <button
                disabled={runtime.runtime?.state !== "idle"}
                onClick={() => {
                  void consoleOwner
                    .run(`print(${objectExpression(name, path)})`, "console")
                    .catch((e) => setCopyNotice(String(e.message)));
                }}
              >
                Render plot
              </button>
            )}
        </div>
      ) : null}
      {chosen !== "table" && p && (
        <div className="object-preview-footer">
          <span>
            {path.length
              ? path
                  .map((x) => (x.kind === "index" ? `[[${x.index}]]` : x.name))
                  .join("")
              : name}
            {!p.complete && " · Partial preview"}
          </span>
          {p.next_start && (
            <button disabled={isStale} onClick={() => setStart(p.next_start!)}>
              Next {chosen === "children" ? "elements" : "values"}
            </button>
          )}
          {start > 1 && <button onClick={() => setStart(1)}>First</button>}
          {inline && (
            <button onClick={() => nav.openObject(name, path)}>
              Open in New Tab
            </button>
          )}
        </div>
      )}
      {chosen !== "table" && (result.error || (!p && result.loading)) && (
        <p className="object-read-notice">
          {result.error ??
            (runtime.runtime?.state === "busy"
              ? "R busy · No previous preview."
              : "Loading preview…")}
        </p>
      )}
      {m?.notice?.startsWith("Source preview") && (
        <p className="object-read-notice">{m.notice}</p>
      )}
      {isStale && !path.length && o.inspectors.get(name)?.observedAt && (
        <div className="object-read-notice">
          Last observed{" "}
          {new Date(o.inspectors.get(name)!.observedAt).toLocaleTimeString()} ·{" "}
          {runtime.runtime?.state === "busy" ? "R busy" : "Cached preview"}
        </div>
      )}
      {copyNotice && <small role="status">{copyNotice}</small>}
    </div>
  );
}
function ContainerView({
  name,
  viewId,
  path,
  page,
}: {
  name: string;
  viewId: string;
  path: ObjectPathElement[];
  page: ObjectReadPage;
}) {
  const key = `container:${viewId}:${name}:${JSON.stringify(path)}`;
  const [index, setIndex] = useObjectView(key, page.children[0]?.index ?? 1);
  const [subIndex, setSubIndex] = useObjectView<number | null>(
    key + ":sub",
    null,
  );
  const child =
    page.children.find((c) => c.index === index) ?? page.children[0];
  const childPath: ObjectPathElement[] = child
    ? [...path, { kind: "index", index: child.index }]
    : path;
  const isContainer =
    !!child?.metadata.supported_reads.includes("children") &&
    !child.metadata.supported_reads.includes("table");
  const nested = usePage(
    name,
    { kind: "children", path: childPath, limit: 100 },
    false,
    isContainer,
  );
  const sub = isContainer
    ? (nested.page?.children.find((c) => c.index === subIndex) ??
      nested.page?.children[0])
    : undefined;
  const selected = sub ?? child,
    selectedPath: ObjectPathElement[] = sub
      ? [...childPath, { kind: "index", index: sub.index }]
      : childPath;
  return (
    <div className="object-container-view">
      <nav aria-label="Object contents">
        <strong>Contents</strong>
        {page.children.map((c) => (
          <div key={c.index}>
            <button
              aria-pressed={child?.index === c.index}
              onClick={() => {
                setIndex(c.index);
                setSubIndex(null);
              }}
            >
              <code>{c.name ?? `[[${c.index}]]`}</code>
              <small>{objectType(c.metadata)}</small>
            </button>
            {child?.index === c.index &&
              isContainer &&
              nested.page?.children.map((n) => (
                <button
                  key={n.index}
                  className="object-subentry"
                  aria-pressed={sub?.index === n.index}
                  onClick={() => setSubIndex(n.index)}
                >
                  <code>{n.name ?? `[[${n.index}]]`}</code>
                  <small>{objectType(n.metadata)}</small>
                </button>
              ))}
          </div>
        ))}
      </nav>
      <div className="object-container-content">
        {selected && (
          <>
            <div className="object-container-heading">
              <code>
                {child?.name}
                {sub && ` / ${sub.name ?? sub.index}`}
              </code>
              <small>{objectSize(selected.metadata)}</small>
            </div>
            <ObjectInspector
              key={JSON.stringify(selectedPath)}
              name={name}
              viewId={viewId}
              path={selectedPath}
              metadata={selected.metadata}
            />
          </>
        )}
        {nested.error && isContainer && <p role="status">{nested.error}</p>}
      </div>
    </div>
  );
}
