import { useEffect, useMemo, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { ObjectMetadata } from "../../public/r-protocol/index.js";
import type { ObjectPathElement } from "../../public/r-protocol/index.js";
import { colorValue, numberLabel, scalarText } from "../object-values";
import { completePalette, serializeVector } from "../object-vector";
import type { VectorCopyFormat } from "../object-vector";
import { useClipboard, useObjects, useNavigation, useSession } from "../view-services";
import {
  ScalarValue,
  TextDetail,
  useObjectView,
  usePage,
} from "./object-common";

type VectorMode = "palette" | "values" | "r" | "advanced";
export function VectorInspector({
  name,
  viewId,
  path,
  metadata,
  inline,
}: {
  name: string;
  viewId: string;
  path: ObjectPathElement[];
  metadata: ObjectMetadata;
  inline: boolean;
}) {
  const clipboard = useClipboard();
  const o = useObjects(),
    nav = useNavigation(),
    session = useSession(),
    key = `${viewId}:${name}:${JSON.stringify(path)}:vector`;
  const [preference, setPreference] = useObjectView<VectorMode | null>(
      key + ":mode",
      null,
    ),
    [basis, setBasis] = useObjectView<"values" | "levels">(
      key + ":basis",
      "values",
    );
  const readKind = metadata.classes.includes("factor") ? basis : "values";
  const [start, setStart] = useObjectView(key + ":start", 1),
    [arrangement, setArrangement] = useObjectView<"strip" | "tiles" | null>(
      key + ":arrangement",
      null,
    );
  const [selected, setSelected] = useState<number | null>(null),
    [inspect, setInspect] = useState(false),
    [jump, setJump] = useState("1");
  const [status, setStatus] = useState(""),
    [copying, setCopying] = useState(false),
    [code, setCode] = useState(""),
    [codeError, setCodeError] = useState("");
  const cancelled = useRef(false);
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );
  const options = useMemo(
    () => ({
      kind: readKind,
      path,
      start,
      limit: preference === "palette" ? 24 : inline ? 20 : 100,
    }),
    [readKind, JSON.stringify(path), start, preference, inline],
  );
  const result = usePage(name, options, inline),
    page = result.page;
  const namesResult = usePage(
    name,
    { kind: "names", path, start, limit: page?.values.length || options.limit },
    false,
    !!page &&
      readKind === "values" &&
      metadata.supported_reads.includes("names"),
  );
  const count =
    readKind === "levels"
      ? (metadata.level_count ??
        (page?.next_start === null
          ? page.start - 1 + page.values.length
          : null))
      : metadata.length;
  const m = useMemo(
    () =>
      readKind === "levels"
        ? {
            ...metadata,
            object_type: "character",
            classes: [],
            attributes: [],
            length: count,
          }
        : metadata,
    [metadata, readKind, count],
  );
  const isPalette = completePalette(m, page),
    canColors = m.object_type === "character";
  const mode: VectorMode =
    preference && (preference !== "palette" || canColors)
      ? preference
      : isPalette
        ? "palette"
        : "values";
  const values = page?.values ?? [],
    offset = page?.start ?? start,
    end = offset + values.length - 1;
  const hasNames =
    readKind === "values" && metadata.supported_reads.includes("names");
  const names =
    namesResult.page?.object_ref === page?.object_ref
      ? namesResult.page?.values
      : undefined;
  const active =
    selected !== null && selected >= offset && selected <= end
      ? values[selected - offset]
      : undefined;
  const activeColor = colorValue(active),
    displayColor =
      activeColor?.length === 9 && /ff$/i.test(activeColor)
        ? activeColor.slice(0, 7)
        : activeColor;
  const opacity = activeColor
    ? activeColor.length === 9
      ? Math.round((parseInt(activeColor.slice(7), 16) / 255) * 1000) / 10
      : 100
    : null;
  const layout = arrangement ?? (values.length <= 12 ? "strip" : "tiles");
  const stale =
    !!o.inspectors.get(name)?.stale || session.runtime?.state !== "idle";
  const whole =
    offset === 1 &&
    page?.next_start === null &&
    count === values.length &&
    page.complete;
  const invalidColor = values.some(
    (v) => v.kind !== "missing" && !colorValue(v),
  );
  useEffect(() => {
    setSelected(null);
    setInspect(false);
    setStatus("");
  }, [page?.object_ref, offset, readKind]);
  const rawPreview = useMemo(() => {
    if (!page || (hasNames && !names)) return "";
    try {
      return serializeVector({
        values,
        names,
        metadata: m,
        objectRef: page.object_ref,
        start: offset,
      });
    } catch {
      return "";
    }
  }, [page, names, m, hasNames]);
  useEffect(() => {
    let active = true;
    setCode("");
    setCodeError("");
    if (mode !== "r" || !page) return;
    o.collectVector(name, path, {
      reference: page.object_ref,
      basis: readKind,
      range: { start: offset, count: values.length },
      cancelled: () => !active,
    }).then(
      (data) => {
        if (active) {
          try {
            setCode(serializeVector(data));
          } catch (error) {
            setCodeError(
              error instanceof Error ? error.message : "Vector unavailable.",
            );
          }
        }
      },
      (error) => {
        if (active) setCodeError(error.message);
      },
    );
    return () => {
      active = false;
    };
  }, [
    mode,
    page?.object_ref,
    offset,
    values.length,
    readKind,
    JSON.stringify(path),
    o,
    name,
  ]);
  async function copy(
    format: VectorCopyFormat = "r",
    scope: "all" | "shown" | "selected" = "all",
  ) {
    if (!page || copying) return;
    cancelled.current = false;
    setCopying(true);
    setStatus(scope === "all" ? "Reading complete vector…" : "Preparing copy…");
    try {
      const range =
        scope === "shown"
          ? { start: offset, count: values.length }
          : scope === "selected" && selected !== null
            ? { start: selected, count: 1 }
            : undefined;
      let count = 0;
      await clipboard.copyText(async () => {
        const data = await o.collectVector(name, path, {
          reference: page.object_ref,
          basis: readKind,
          range,
          cancelled: () => cancelled.current,
        });
        const text = serializeVector(data, format);
        if (cancelled.current) throw new Error("Copy cancelled.");
        count = data.values.length;
        return text;
      });
      setStatus(
        `Copied ${numberLabel(count)} ${count === 1 ? "value" : "values"}`,
      );
    } catch (error) {
      if (!cancelled.current)
        setStatus(error instanceof Error ? error.message : "Copy failed.");
    } finally {
      setCopying(false);
    }
  }
  async function copyColor(hex: boolean) {
    if (!active) return;
    try {
      await clipboard.copyText(
        hex ? activeColor! : (active.text ?? scalarText(active, m, true)),
      );
      setStatus("Color copied");
    } catch {
      setStatus("Clipboard unavailable");
    }
  }
  function setMode(next: VectorMode) {
    setPreference(next);
    setInspect(false);
  }
  function choose(index: number, open = false) {
    setSelected(index);
    setInspect(open);
  }
  function turnPage(next: number) {
    setStart(next);
    setJump(String(next));
    setSelected(null);
    setInspect(false);
  }
  const modes: { id: VectorMode; label: string }[] = [
    ...(canColors
      ? [{ id: "palette" as const, label: isPalette ? "Palette" : "Colors" }]
      : []),
    { id: "values", label: "Values" },
    { id: "r", label: "R vector" },
    { id: "advanced", label: "Advanced" },
  ];
  const copyActions = (
    <div className="vector-copy-actions">
      <button disabled={!page || copying || stale} onClick={() => void copy()}>
        {readKind === "levels" ? "Copy levels" : "Copy vector"}
      </button>
      <Menu.Root>
        <Menu.Trigger
          aria-label="Vector copy options"
          disabled={!page || copying}
        >
          ▾
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="menu"
            align="end"
            sideOffset={5}
            collisionPadding={12}
          >
            <Menu.Label className="menu-label">
              Entire {readKind === "levels" ? "level vector" : "vector"}
              {count != null ? ` · ${numberLabel(count)}` : ""}
            </Menu.Label>
            <Menu.Item disabled={stale} onSelect={() => void copy("r")}>
              Original R vector
            </Menu.Item>
            {canColors && (
              <>
                <Menu.Item
                  disabled={stale || invalidColor}
                  onSelect={() => void copy("hex-r")}
                >
                  Hex R vector
                </Menu.Item>
                <Menu.Item
                  disabled={stale || invalidColor}
                  onSelect={() => void copy("hex-lines")}
                >
                  Hex lines
                </Menu.Item>
              </>
            )}
            <Menu.Separator className="menu-separator" />
            <Menu.Item
              disabled={stale}
              onSelect={() => void copy("r", "shown")}
            >
              Shown range · {values.length}
            </Menu.Item>
            <Menu.Item
              disabled={stale || selected === null}
              onSelect={() => void copy("r", "selected")}
            >
              Selected value
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
  return (
    <div className={`object-vector-view ${inline ? "vector-inline" : ""}`}>
      <div className="vector-toolbar">
        <select
          className={inline ? "" : "vector-compact-mode"}
          aria-label="Vector view"
          value={mode}
          onChange={(e) => setMode(e.target.value as VectorMode)}
        >
          {modes.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
        {!inline && (
          <div className="object-read-tabs">
            {modes.map((v) => (
              <button
                key={v.id}
                aria-pressed={mode === v.id}
                onClick={() => setMode(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {copyActions}
      </div>
      {metadata.classes.includes("factor") && (
        <div className="vector-basis">
          <button
            aria-pressed={readKind === "values"}
            onClick={() => {
              setBasis("values");
              turnPage(1);
            }}
          >
            Values
          </button>
          <button
            aria-pressed={readKind === "levels"}
            onClick={() => {
              setBasis("levels");
              turnPage(1);
            }}
          >
            Levels
            {metadata.level_count != null ? ` · ${metadata.level_count}` : ""}
          </button>
        </div>
      )}
      {page && (
        <>
          <div className="vector-body">
            {mode === "palette" ? (
              <>
                <div className="palette-toolbar">
                  <span>
                    {whole && isPalette
                      ? `${values.length} colors`
                      : values.length
                        ? `Showing ${offset}–${end}`
                        : "0 values"}
                  </span>
                  {!whole && count !== null && (
                    <small>{numberLabel(count)} values in vector</small>
                  )}
                  <div className="spacer" />
                  <button
                    aria-pressed={layout === "strip"}
                    onClick={() => setArrangement("strip")}
                  >
                    Strip
                  </button>
                  <button
                    aria-pressed={layout === "tiles"}
                    onClick={() => setArrangement("tiles")}
                  >
                    Tiles
                  </button>
                </div>
                <div
                  className={`palette-colors palette-${layout}`}
                  role="listbox"
                  aria-label="Palette colors"
                  aria-orientation="horizontal"
                >
                  {values.map((v, i) => {
                    const c = colorValue(v),
                      index = offset + i,
                      n = names?.[i];
                    return (
                      <button
                        key={index}
                        role="option"
                        aria-selected={selected === index}
                        aria-label={`${index}: ${n?.text ? n.text + " · " : ""}${scalarText(v, null, true)}`}
                        tabIndex={
                          selected === index || (selected === null && i === 0)
                            ? 0
                            : -1
                        }
                        onClick={() => choose(index)}
                        onKeyDown={(e) => {
                          if (
                            ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                              e.key,
                            )
                          ) {
                            e.preventDefault();
                            const next =
                              e.key === "Home"
                                ? 0
                                : e.key === "End"
                                  ? values.length - 1
                                  : Math.max(
                                      0,
                                      Math.min(
                                        values.length - 1,
                                        i + (e.key === "ArrowRight" ? 1 : -1),
                                      ),
                                    );
                            choose(offset + next);
                            e.currentTarget.parentElement
                              ?.querySelectorAll<HTMLButtonElement>("button")
                              [next]?.focus();
                          }
                        }}
                      >
                        <span
                          className={`palette-color ${!c ? "not-color" : ""}`}
                        >
                          {c ? (
                            <span style={{ backgroundColor: c }} />
                          ) : (
                            <span>
                              {v.kind === "missing" ? "NA" : "Not a color"}
                            </span>
                          )}
                        </span>
                        <span className="palette-caption">
                          <small>{index}</small>
                          <code title={v.text ?? v.label ?? ""}>
                            {n?.text ?? scalarText(v, null, true)}
                          </code>
                        </span>
                        {n?.text && (
                          <code className="palette-original">
                            {scalarText(v, null, true)}
                          </code>
                        )}
                      </button>
                    );
                  })}
                </div>
                {active && (
                  <div className="palette-selected">
                    <span
                      className="palette-selected-chip"
                      style={
                        activeColor
                          ? { backgroundColor: activeColor }
                          : undefined
                      }
                    />
                    <code>{scalarText(active, null, true)}</code>
                    <small>
                      {selected}
                      {count !== null ? ` of ${count}` : ""}
                    </small>
                    {activeColor ? (
                      <>
                        <span className="palette-rendered">
                          Rendered <code>{displayColor}</code>
                        </span>
                        <small>{opacity}% opacity</small>
                      </>
                    ) : (
                      <small>
                        {active.kind === "missing"
                          ? "Missing value"
                          : "Not a color"}
                      </small>
                    )}
                    <div className="spacer" />
                    <Menu.Root>
                      <Menu.Trigger>Copy color ▾</Menu.Trigger>
                      <Menu.Portal>
                        <Menu.Content className="menu" align="end">
                          <Menu.Item onSelect={() => void copyColor(false)}>
                            Original value
                          </Menu.Item>
                          <Menu.Item
                            disabled={!activeColor}
                            onSelect={() => void copyColor(true)}
                          >
                            Rendered hex
                          </Menu.Item>
                        </Menu.Content>
                      </Menu.Portal>
                    </Menu.Root>
                  </div>
                )}
                {!inline && rawPreview && (
                  <div className="vector-code-preview">
                    <small>
                      {whole
                        ? "Original R vector"
                        : `R vector · shown range ${offset}–${end}`}
                    </small>
                    <pre>{rawPreview}</pre>
                  </div>
                )}
              </>
            ) : mode === "values" ? (
              <div className="object-values-list vector-values-list">
                {values.map((v, i) => (
                  <div
                    className={`vector-value-row ${selected === offset + i ? "selected" : ""}`}
                    key={offset + i}
                  >
                    <button
                      className="vector-select-value"
                      aria-label={`Select value ${offset + i}`}
                      onClick={() => choose(offset + i)}
                      onDoubleClick={() => choose(offset + i, true)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          choose(offset + i, true);
                        }
                      }}
                    >
                      <span className="object-index">{offset + i}</span>
                      {names?.[i]?.text && (
                        <code className="vector-value-name">
                          {names[i].text}
                        </code>
                      )}
                      <ScalarValue value={v} metadata={m} />
                      {v.kind === "factor" && <small>code {v.number}</small>}
                    </button>
                    <button
                      className="vector-inspect-value"
                      aria-label={`Inspect value ${offset + i}`}
                      onClick={() => choose(offset + i, true)}
                    >
                      ›
                    </button>
                  </div>
                ))}
              </div>
            ) : mode === "r" ? (
              <div className="vector-code-preview">
                <small>
                  {whole ? "Original R vector" : `Shown range ${offset}–${end}`}
                </small>
                <pre>
                  {codeError || code || "Reading complete values and names…"}
                </pre>
              </div>
            ) : (
              <div className="object-attributes">
                <p>
                  <span>Type</span>
                  <code>{metadata.object_type}</code>
                </p>
                <p>
                  <span>Class</span>
                  <code>{metadata.classes.join(", ") || "—"}</code>
                </p>
                {metadata.attributes.map((a) => (
                  <p key={a.name}>
                    <span>{a.name}</span>
                    <code>{a.values.join(", ")}</code>
                  </p>
                ))}
              </div>
            )}
            {mode === "values" && inspect && active && (
              <div className="vector-item-details">
                <div className="vector-detail-heading">
                  <strong>Value {selected}</strong>
                  <button onClick={() => setInspect(false)}>
                    Close details
                  </button>
                </div>
                {active.text !== null ? (
                  <TextDetail
                    key={`${page.object_ref}:${selected}`}
                    name={name}
                    path={path}
                    index={selected!}
                    value={active}
                    baseKey={key}
                    textAttribute={readKind === "levels" ? "levels" : undefined}
                  />
                ) : (
                  <div className="vector-raw-value">
                    <ScalarValue value={active} metadata={m} raw />
                  </div>
                )}
              </div>
            )}
            {!values.length && (
              <div className="empty-message muted">
                Empty {m.object_type} vector
              </div>
            )}
          </div>
          <div className="object-preview-footer vector-footer">
            <span>
              {values.length ? `${offset}–${end}` : "0"} of{" "}
              {count !== null ? numberLabel(count) : "?"} values
              {whole ? " · All shown" : ""}
            </span>
            {offset > 1 && (
              <button
                disabled={stale}
                onClick={() => turnPage(Math.max(1, offset - options.limit))}
              >
                Previous page
              </button>
            )}
            {page.next_start !== null && (
              <button
                disabled={stale}
                onClick={() => turnPage(page.next_start!)}
              >
                Next page
              </button>
            )}
            {!inline && (page.next_start !== null || offset > 1) && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  turnPage(
                    Math.max(
                      1,
                      Math.min(
                        count ?? Number.MAX_SAFE_INTEGER,
                        Number(jump) || 1,
                      ),
                    ),
                  );
                }}
              >
                <input
                  aria-label="Go to vector index"
                  type="number"
                  min={1}
                  max={count ?? undefined}
                  value={jump}
                  onChange={(e) => setJump(e.target.value)}
                />
                <button disabled={stale}>Go</button>
              </form>
            )}
            {inline && (
              <button onClick={() => nav.openObject(name, path)}>
                Open in New Tab
              </button>
            )}
          </div>
        </>
      )}
      {(!page || result.error) && (
        <p className="object-read-notice" role="status">
          {result.error ??
            (stale ? "Refresh this object to load values." : "Loading vector…")}
        </p>
      )}
      {stale && page && (
        <div className="object-read-notice">
          Cached observation · Refresh to read current values
        </div>
      )}
      {status && (
        <div className="object-read-notice" role="status">
          {status}
          {copying && (
            <button
              onClick={() => {
                cancelled.current = true;
                setStatus("Copy cancelled.");
              }}
            >
              Cancel copy
            </button>
          )}
        </div>
      )}
    </div>
  );
}
