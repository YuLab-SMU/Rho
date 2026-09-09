import { useEffect, useMemo, useRef, useState } from "react";
import { DataGrid, type Column, type SortColumn } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import type { ObjectMetadata } from "../generated/ObjectMetadata";
import type { ObjectPathElement } from "../generated/ObjectPathElement";
import type { ObjectReadPage } from "../generated/ObjectReadPage";
import { numberLabel, scalarText } from "../object-values";
import { useObjects, useSession, useNavigation } from "../context";
import {
  ScalarValue,
  TextDetail,
  useObjectView,
  usePage,
} from "./object-common";
type GridRow = { index: number; position: number };
type Point = { row: number; col: number };
export function ObjectGrid({
  name,
  viewId,
  path,
  metadata: m,
  inline,
  initial,
}: {
  name: string;
  viewId: string;
  path: ObjectPathElement[];
  metadata: ObjectMetadata | null;
  inline: boolean;
  initial?: ObjectReadPage;
}) {
  const o = useObjects(),
    session = useSession(),
    nav = useNavigation(),
    key = `grid:${viewId}:${name}:${JSON.stringify(path)}`;
  const [start, setStart] = useObjectView(key + ":start", 1),
    [cs, setCs] = useObjectView(key + ":column", 1);
  const [sort, setSort] = useObjectView<SortColumn[]>(key + ":sort", []),
    [filter, setFilter] = useObjectView(key + ":filter", {
      column: 1,
      text: "",
    });
  const [filterDraft, setFilterDraft] = useState(filter.text),
    [showFilter, setShowFilter] = useState(false);
  const [slice, setSlice] = useObjectView<number[]>(key + ":slice", []),
    [hidden, setHidden] = useObjectView<number[]>(key + ":hidden", []),
    [order, setOrder] = useObjectView<number[]>(key + ":order", []);
  const [widths, setWidths] = useObjectView<Record<string, number>>(
      key + ":widths",
      {},
    ),
    [showColumns, setShowColumns] = useObjectView(key + ":show-columns", false);
  const [range, setRange] = useObjectView(key + ":range", {
    anchor: { row: 0, col: 1 },
    end: { row: 0, col: 1 },
  });
  const [showText, setShowText] = useState(false);
  const [notice, setNotice] = useState(""),
    [go, setGo] = useState("1");
  const dragging = useRef(false),
    extending = useRef(false);
  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);
  const options = useMemo(
    () => ({
      kind: "table" as const,
      path,
      start,
      column_start: cs,
      limit: inline ? 5 : 100,
      column_limit: inline ? 4 : 20,
      slice,
      sort_column: sort.length ? Number(sort[0].columnKey) : null,
      sort_descending: sort[0]?.direction === "DESC",
      filter_column: filter.text ? filter.column : null,
      filter_text: filter.text || null,
    }),
    [
      JSON.stringify(path),
      start,
      cs,
      inline,
      JSON.stringify(slice),
      JSON.stringify(sort),
      filter,
    ],
  );
  const result = usePage(name, options, inline),
    p = result.page ?? initial,
    total = p?.total_rows ?? m?.dimensions[0] ?? 0;
  const dataColumns = (p?.columns ?? []).slice(0, inline ? 4 : 20);
  const visible = [...dataColumns]
    .sort(
      (a, b) =>
        (order.indexOf(a.index) < 0
          ? a.index + 10000
          : order.indexOf(a.index)) -
        (order.indexOf(b.index) < 0 ? b.index + 10000 : order.indexOf(b.index)),
    )
    .filter((c) => !hidden.includes(c.index));
  const rows = useMemo(
    () =>
      Array.from(
        {
          length: Math.min(
            inline ? 5 : 200,
            p?.row_indices?.length ?? p?.columns[0]?.values.length ?? 0,
          ),
        },
        (_, i) => ({ index: p?.row_indices?.[i] ?? start + i, position: i }),
      ),
    [p, inline, start],
  );
  const selected = (r: number, c: number) =>
    r >= Math.min(range.anchor.row, range.end.row) &&
    r <= Math.max(range.anchor.row, range.end.row) &&
    c >= Math.min(range.anchor.col, range.end.col) &&
    c <= Math.max(range.anchor.col, range.end.col);
  const columns: Column<GridRow>[] = [
    {
      key: "__row",
      name: p?.row_names?.length ? "Row" : "",
      width: p?.row_names?.length ? 155 : 48,
      frozen: "start",
      resizable: false,
      renderCell: ({ row }) => (
        <span className="object-index">
          {p?.row_names?.[row.position] ?? numberLabel(row.index)}
        </span>
      ),
    },
    ...visible.map(
      (c, index): Column<GridRow> => ({
        key: String(c.index),
        name: (
          <span className="object-grid-header">
            {c.name ?? `Column ${c.index}`}
            <small>{c.metadata.classes[0] ?? c.metadata.object_type}</small>
          </span>
        ),
        width:
          widths[c.index] ??
          (index === visible.length - 1 && !inline
            ? "minmax(150px, 1fr)"
            : c.metadata.object_type === "character"
              ? 190
              : 125),
        minWidth: 80,
        frozen: index === 0 ? "start" : undefined,
        resizable: true,
        sortable:
          !inline &&
          (m?.table_features ?? []).includes("sort") &&
          total <= 1000000 &&
          c.metadata.supported_reads.includes("values") &&
          c.metadata.object_type !== "complex",
        draggable: !inline,
        cellClass: (row) =>
          `${selected(row.position, index + 1) && !inline ? "object-range-cell" : ""} ${["double", "integer"].includes(c.metadata.object_type ?? "") && !c.metadata.classes.includes("factor") ? "object-number-cell" : ""}`,
        renderCell: ({ row }) => (
          <div
            className="object-grid-cell"
            onPointerEnter={() => {
              if (dragging.current && !inline)
                setRange({
                  ...range,
                  end: { row: row.position, col: index + 1 },
                });
            }}
          >
            <ScalarValue value={c.values[row.position]} metadata={c.metadata} />
          </div>
        ),
      }),
    ),
  ];
  const activeColumn = visible[range.end.col - 1],
    activeRow = rows[range.end.row],
    activeValue = activeColumn?.values[range.end.row];
  function valueLocation(column: number, row: number) {
    return m?.supported_reads.includes("children")
      ? {
          path: [...path, { kind: "index" as const, index: column }],
          start: row,
        }
      : {
          path,
          start:
            row +
            (column - 1) * (m?.dimensions[0] ?? 0) +
            slice.reduce(
              (a, v, i) =>
                a +
                (v - 1) *
                  (m?.dimensions.slice(0, i + 2).reduce((x, y) => x * y, 1) ??
                    0),
              0,
            ),
        };
  }
  async function fullText(column: (typeof dataColumns)[number], row: GridRow) {
    const value = column.values[row.position];
    if (!value)
      throw new Error("Selected cells include values that are not available.");
    if (value.text === null) return scalarText(value, column.metadata);
    let text = value.text,
      next = value.next_text_start;
    while (next) {
      const part = await o.readPage(name, {
        kind: "text",
        ...valueLocation(column.index, row.index),
        text_start: next,
        text_limit_bytes: 16384,
      });
      if (part.object_ref !== p?.object_ref)
        throw new Error(
          "The object changed while copying. Select current values again.",
        );
      text += part.values[0]?.text ?? "";
      next = part.next_text_start;
      if (text.length > 1048576)
        throw new Error(
          "This copy exceeds the 1 MiB text limit. Use a smaller selection.",
        );
    }
    return text;
  }
  async function copySelection() {
    setNotice("Copying selection…");
    try {
      const top = Math.max(0, Math.min(range.anchor.row, range.end.row)),
        bottom = Math.min(
          rows.length - 1,
          Math.max(range.anchor.row, range.end.row),
        );
      const left = Math.max(1, Math.min(range.anchor.col, range.end.col)),
        right = Math.min(
          visible.length,
          Math.max(range.anchor.col, range.end.col),
        );
      const lines: string[] = [];
      let size = 0;
      for (const row of rows.slice(top, bottom + 1)) {
        const cells: string[] = [];
        for (const column of visible.slice(left - 1, right)) {
          const text = await fullText(column, row);
          size += new TextEncoder().encode(text).length;
          if (size > 1048576)
            throw new Error(
              "This copy exceeds 1 MiB. Use a smaller selection.",
            );
          cells.push(
            /[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text,
          );
        }
        lines.push(cells.join("\t"));
      }
      await navigator.clipboard.writeText(lines.join("\n"));
      setNotice("Copied");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Clipboard unavailable",
      );
    }
  }
  function copy(text: string) {
    void navigator.clipboard.writeText(text).then(
      () => setNotice("Copied"),
      () => setNotice("Clipboard unavailable"),
    );
  }
  function point(p: Point, extend: boolean) {
    setRange({ anchor: extend ? range.anchor : p, end: p });
  }
  const stale =
    o.inspectors.get(name)?.stale || session.runtime?.state !== "idle";
  return (
    <div className={`object-table ${inline ? "is-inline" : ""}`}>
      {!inline && (
        <div className="object-grid-tools">
          <button
            disabled={!(m?.table_features ?? []).includes("filter")}
            title={
              (m?.table_features ?? []).includes("filter")
                ? "Filter the whole table"
                : "Requires an updated Rho Host"
            }
            aria-pressed={showFilter}
            onClick={() => setShowFilter(!showFilter)}
          >
            Filter rows{filter.text ? " · 1" : ""}
          </button>
          <span>
            {numberLabel(total)}
            {filter.text
              ? ` of ${numberLabel(m?.dimensions[0] ?? 0)}`
              : ""}{" "}
            rows
          </span>
          <div className="spacer" />
          <button disabled={!rows.length || range.end.col === 0} onClick={() => void copySelection()}>
            Copy selection
          </button>
          <button
            aria-pressed={showColumns}
            onClick={() => setShowColumns(!showColumns)}
          >
            Columns · {m?.dimensions[1] ?? dataColumns.length}
          </button>
        </div>
      )}
      {showFilter && !inline && (
        <form
          className="object-filter"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ ...filter, text: filterDraft });
            setStart(1);
          }}
        >
          <select
            aria-label="Filter column"
            value={filter.column}
            onChange={(e) =>
              setFilter({ ...filter, column: Number(e.target.value) })
            }
          >
            {dataColumns
              .filter(
                (c) =>
                  c.metadata.supported_reads.includes("values") &&
                  !c.metadata.classes.some((x) =>
                    ["Date", "POSIXct", "difftime"].includes(x),
                  ),
              )
              .map((c) => (
                <option value={c.index} key={c.index}>
                  {c.name ?? c.index}
                </option>
              ))}
          </select>
          <span>contains</span>
          <input
            aria-label="Filter text"
            maxLength={256}
            value={filterDraft}
            onChange={(e) => setFilterDraft(e.target.value)}
          />
          <button disabled={stale}>Apply to all rows</button>
          <button
            type="button"
            onClick={() => {
              setFilter({ column: 1, text: "" });
              setFilterDraft("");
              setStart(1);
            }}
          >
            Clear
          </button>
        </form>
      )}
      {!!(m?.dimensions.length && m.dimensions.length > 2) && (
        <div className="object-array-slices">
          {m.dimensions.slice(2).map((n, i) => (
            <label key={i}>
              Dimension {i + 3}
              <input
                aria-label={`Dimension ${i + 3} slice`}
                type="number"
                min={1}
                max={n}
                value={slice[i] ?? 1}
                onChange={(e) => {
                  const next = m.dimensions
                    .slice(2)
                    .map((_, j) => slice[j] ?? 1);
                  next[i] = Math.max(
                    1,
                    Math.min(n, Number(e.target.value) || 1),
                  );
                  setSlice(next);
                  setStart(1);
                }}
              />
              <small>of {numberLabel(n)}</small>
            </label>
          ))}
        </div>
      )}
      <div className="object-grid-body">
        <DataGrid
          className="rdg-light object-data-grid"
          aria-label={`${name} data table`}
          columns={columns}
          rows={rows}
          rowKeyGetter={(r) => r.index}
          rowHeight={32}
          headerRowHeight={inline ? 36 : 46}
          sortColumns={sort}
          onSortColumnsChange={(s) => {
            setSort(s.slice(-1));
            setStart(1);
          }}
          onColumnResize={(c, width) =>
            setWidths({ ...widths, [c.key]: width })
          }
          onColumnsReorder={(source, target) => {
            const next = visible.map((c) => c.index),
              from = next.indexOf(Number(source)),
              to = next.indexOf(Number(target));
            if (from >= 0 && to >= 0) {
              next.splice(from, 1);
              next.splice(to, 0, Number(source));
              setOrder(next);
            }
          }}
          onCellMouseDown={(args, event) => {
            dragging.current = !inline;
            extending.current = event.shiftKey;
            point(
              { row: args.row.position, col: args.column.idx },
              event.shiftKey,
            );
          }}
          onActivePositionChange={(args) => {
            if (args.row && args.column && !dragging.current)
              point(
                { row: args.row.position, col: args.column.idx },
                extending.current,
              );
            extending.current = false;
          }}
          onCellKeyDown={(args, event) => {
            extending.current = event.shiftKey;
            if (["Delete", "Backspace"].includes(event.key))
              event.preventGridDefault();
            if (
              args.mode === "ACTIVE" &&
              event.shiftKey &&
              ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
                event.key,
              )
            ) {
              event.preventGridDefault();
              event.preventDefault();
              const p = {
                row: Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    range.end.row +
                      (event.key === "ArrowDown"
                        ? 1
                        : event.key === "ArrowUp"
                          ? -1
                          : 0),
                  ),
                ),
                col: Math.max(
                  1,
                  Math.min(
                    visible.length,
                    range.end.col +
                      (event.key === "ArrowRight"
                        ? 1
                        : event.key === "ArrowLeft"
                          ? -1
                          : 0),
                  ),
                ),
              };
              point(p, true);
            }
          }}
          onCellCopy={(_args, event) => {
            event.preventDefault();
            void copySelection();
          }}
          style={{
            height: inline ? 36 + rows.length * 32 + 2 : "100%",
            minHeight: inline ? 70 : 180,
          }}
        />
        {showColumns && !inline && (
          <aside className="object-column-inspector">
            <strong>Columns</strong>
            {dataColumns.map((c) => (
              <label key={c.index}>
                <input
                  type="checkbox"
                  checked={!hidden.includes(c.index)}
                  onChange={(e) =>
                    setHidden(
                      e.target.checked
                        ? hidden.filter((x) => x !== c.index)
                        : [...hidden, c.index],
                    )
                  }
                />
                <code>{c.name ?? c.index}</code>
                <small>{c.metadata.classes[0] ?? c.metadata.object_type}</small>
              </label>
            ))}
            <small>
              Drag headers to reorder. First visible column stays pinned.
            </small>
          </aside>
        )}
      </div>
      {!inline && activeColumn && activeRow && (
        <div className="object-active-cell">
          <div>
            <small>Active cell · row {numberLabel(activeRow.index)}</small>
            <code>{activeColumn.name ?? `Column ${activeColumn.index}`}</code>
          </div>
          <ScalarValue
            value={activeValue}
            metadata={activeColumn.metadata}
            raw
          />
          <div className="spacer" />
          <small>
            {(Math.abs(range.end.row - range.anchor.row) + 1) *
              (Math.abs(range.end.col - range.anchor.col) + 1)}{" "}
            cells selected
          </small>
          <button
            onClick={() =>
              copy(scalarText(activeValue, activeColumn.metadata, true))
            }
          >
            {activeValue?.next_text_start ? "Copy preview" : "Copy value"}
          </button>
          {activeValue?.text != null && (
            <button
              aria-pressed={showText}
              onClick={() => setShowText(!showText)}
            >
              Text details
            </button>
          )}
        </div>
      )}
      {!inline &&
        showText &&
        activeValue?.text != null &&
        activeRow &&
        activeColumn && (
          <TextDetail
            name={name}
            path={
              m?.supported_reads.includes("children")
                ? [...path, { kind: "index", index: activeColumn.index }]
                : path
            }
            index={
              m?.supported_reads.includes("children")
                ? activeRow.index
                : activeRow.index +
                  (activeColumn.index - 1) * (m?.dimensions[0] ?? 0) +
                  slice.reduce(
                    (a, v, i) =>
                      a +
                      (v - 1) *
                        (m?.dimensions
                          .slice(0, i + 2)
                          .reduce((x, y) => x * y, 1) ?? 0),
                    0,
                  )
            }
            value={activeValue}
            baseKey={key}
          />
        )}
      <div className="object-preview-footer">
        <span>
          {rows.length
            ? `Rows ${numberLabel(start)}–${numberLabel(start + rows.length - 1)}`
            : "No rows"}{" "}
          of {numberLabel(total)} · {dataColumns.length} of{" "}
          {numberLabel(m?.dimensions[1] ?? 0)} columns
        </span>
        {inline ? (
          <button onClick={() => nav.openObject(name, path)}>Open table</button>
        ) : (
          <>
            <button
              disabled={stale || start === 1}
              onClick={() => setStart(Math.max(1, start - 100))}
            >
              Previous
            </button>
            <button
              disabled={stale || !p?.next_start}
              onClick={() => setStart(p!.next_start!)}
            >
              Next
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setStart(Math.max(1, Math.min(total || 1, Number(go) || 1)));
              }}
            >
              <input
                aria-label="Go to row"
                type="number"
                min={1}
                max={total || 1}
                value={go}
                onChange={(e) => setGo(e.target.value)}
              />
              <button disabled={stale}>Go</button>
            </form>
            {(m?.dimensions[1] ?? 0) > 20 && (
              <label>
                First column
                <input
                  aria-label="First column"
                  type="number"
                  min={1}
                  max={m?.dimensions[1]}
                  value={cs}
                  onChange={(e) =>
                    setCs(
                      Math.max(
                        1,
                        Math.min(
                          m?.dimensions[1] ?? 1,
                          Number(e.target.value) || 1,
                        ),
                      ),
                    )
                  }
                />
              </label>
            )}
          </>
        )}
      </div>
      {(result.error || result.loading || notice) && (
        <div className="object-read-notice" role="status">
          {result.error || (result.loading ? "Loading table…" : notice)}
        </div>
      )}
    </div>
  );
}
