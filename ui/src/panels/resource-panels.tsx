import { useEffect, useRef, useState } from "react";
import { useStudio } from "../context";
import { message } from "../host-client";
import type { BindingSummary } from "../generated/BindingSummary";
import type { JsonValue } from "../generated/serde_json/JsonValue";

const summary = (object: BindingSummary) =>
  object.dimensions.length
    ? object.dimensions.join(" × ")
    : object.length !== null
      ? `${object.length} 项`
      : object.kind === "active_binding"
        ? "活动绑定"
        : object.kind === "promise"
          ? "未求值"
          : "元数据";
export function FilesPanel() {
  const s = useStudio(),
    [path, setPath] = useState(""),
    [filter, setFilter] = useState("");
  useEffect(() => {
    if (!s.directory) void s.listDirectory();
  }, [s, s.project]);
  const entries =
    s.directory?.entries.filter((e) =>
      e.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) ?? [];
  function open(value: string, size?: number) {
    void s.documents.open(value, size).catch((e) => {
      s.directoryError = message(e);
      s.emit();
    });
  }
  return (
    <section className="panel files-panel">
      <div className="resource-toolbar">
        <button onClick={() => s.documents.create()}>＋ 新建</button>
        <button
          disabled={s.directoryLoading}
          onClick={() => void s.listDirectory(s.directory?.path ?? "")}
        >
          刷新
        </button>
        <div className="spacer" />
        <button
          disabled={!s.directory?.path}
          onClick={() =>
            void s.listDirectory(
              s.directory!.path.split("/").slice(0, -1).join("/"),
            )
          }
        >
          上一级
        </button>
      </div>
      <form
        className="file-path"
        onSubmit={(e) => {
          e.preventDefault();
          open(path);
        }}
      >
        <input
          aria-label="打开相对文件路径"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="输入文件相对路径…"
        />
        <button disabled={!path.trim()}>打开</button>
      </form>
      <div className="resource-search">
        <input
          aria-label="筛选文件"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选当前目录"
        />
      </div>
      <div className="directory-path">/{s.directory?.path}</div>
      {s.directoryError && (
        <div className="document-error" role="alert">
          {s.directoryError}
        </div>
      )}
      <div className="file-list">
        {entries.map((entry) => (
          <button
            key={entry.path}
            onClick={() =>
              entry.kind === "directory"
                ? void s.listDirectory(entry.path)
                : entry.kind === "regular"
                  ? open(entry.path, entry.byte_size)
                  : ((s.directoryError =
                      "符号链接或特殊文件仅显示信息，不能通过此路径读取"),
                    s.emit())
            }
            title={entry.path}
          >
            <span className="file-icon">
              {entry.kind === "directory"
                ? "▱"
                : entry.name.toLowerCase().endsWith(".r")
                  ? "R"
                  : "▤"}
            </span>
            <span className="file-name">{entry.name}</span>
            <small>
              {entry.kind === "regular"
                ? `${entry.byte_size.toLocaleString()} B`
                : entry.kind === "directory"
                  ? "目录"
                  : entry.kind}
            </small>
          </button>
        ))}
        {s.directory?.next_name && (
          <button
            disabled={s.directoryLoading}
            onClick={() => void s.listDirectory(s.directory!.path, true)}
          >
            加载更多
          </button>
        )}
        {!entries.length && (
          <p className="muted">
            {s.directoryLoading ? "读取目录…" : "目录中没有匹配文件"}
          </p>
        )}
        {s.directory?.notices.map((notice, i) => (
          <p className="muted" key={i}>
            {notice}
          </p>
        ))}
      </div>
      <div className="panel-footer">
        <span>{s.directory?.entries.length ?? 0} 个条目</span>
        <span>文件系统</span>
      </div>
    </section>
  );
}
export function ObjectsPanel() {
  const s = useStudio(),
    [filter, setFilter] = useState(""),
    selected = useRef<HTMLButtonElement | null>(null),
    body = useRef<HTMLDivElement>(null);
  const objects =
    s.objects?.objects.filter((o) =>
      o.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) ?? [];
  useEffect(() => {
    if (!body.current) return;
    const observer = new ResizeObserver(() => {
      if (body.current!.clientHeight < 96)
        selected.current?.scrollIntoView({ block: "nearest" });
    });
    observer.observe(body.current);
    return () => observer.disconnect();
  }, []);
  return (
    <section className="panel objects-panel">
      <div className="resource-search">
        <input
          aria-label="筛选对象"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="⌕ 筛选对象"
        />
      </div>
      <div className="object-columns">
        <span>名称</span>
        <span>类型</span>
        <span>大小 / 维度</span>
      </div>
      <div className="object-list" ref={body}>
        {objects.map((object) => (
          <button
            key={object.name}
            ref={object.name === s.selectedObject ? selected : undefined}
            className={`object-row ${object.name === s.selectedObject ? "selected" : ""}`}
            onClick={() =>
              void s.inspectObject(object.name).catch((e) => {
                s.objectsNotice = message(e);
                s.emit();
              })
            }
          >
            <span className="object-name">
              › <code>{object.name}</code>
            </span>
            <span className="object-type">
              {object.classes.join(", ") || object.object_type || object.kind}
            </span>
            <span className="object-size">{summary(object)}</span>
          </button>
        ))}
        {!objects.length && (
          <p className="muted empty-message">
            {s.objects ? "暂无对象" : "配置 R 后可查看对象"}
          </p>
        )}
      </div>
      {s.objectsNotice && (
        <div className="object-notice">R 忙或观察不可用，保留上次结果。</div>
      )}
      <div className="panel-footer">
        <span>.GlobalEnv {s.objects?.truncated ? "· 列表已截断" : ""}</span>
        <span>
          {s.objectsObservedAt
            ? `观察于 ${new Date(s.objectsObservedAt).toLocaleTimeString()}`
            : "尚未观察"}
        </span>
      </div>
    </section>
  );
}
function display(value: JsonValue | undefined) {
  return value === null
    ? "NA"
    : value === undefined
      ? "—"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
}
export function ObjectViewer({ name }: { name: string }) {
  const s = useStudio(),
    observation = s.inspectors.get(name),
    object = observation?.binding;
  const columns =
    Array.isArray(object?.preview) &&
    object?.classes.length === 1 &&
    object.classes[0] === "data.frame"
      ? (object.preview as Array<{ name: string; values: JsonValue[] | null }>)
      : null;
  return (
    <section className="panel object-viewer">
      <div className="resource-toolbar">
        <span>{name}</span>
        <div className="spacer" />
        <button
          disabled={s.runtime?.state !== "idle"}
          onClick={() =>
            void s.inspectObject(name).catch((e) => {
              s.objectsNotice = message(e);
              s.emit();
            })
          }
        >
          刷新预览
        </button>
      </div>
      {object ? (
        <div className="object-preview">
          <div className="object-metadata">
            <span>
              {object.classes.join(", ") || object.object_type || object.kind}
            </span>
            <span>{summary(object)}</span>
          </div>
          {columns ? (
            <div className="dataframe-scroll">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    {columns.map((column, index) => (
                      <th key={index}>{column.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from(
                    { length: Math.min(object.dimensions[0] ?? 0, 20) },
                    (_, row) => (
                      <tr key={row}>
                        <th>{row + 1}</th>
                        {columns.map((column, index) => (
                          <td key={index}>
                            {column.values
                              ? display(column.values[row])
                              : "元数据"}
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
                : JSON.stringify(object.preview, null, 2)}
            </pre>
          ) : (
            <p className="muted">仅显示元数据，未对对象求值。</p>
          )}
          {object.notice && <p className="muted">{object.notice}</p>}
          {object.truncated && (
            <p className="observation-notice">预览已截断。</p>
          )}
        </div>
      ) : (
        <div className="empty">
          <p>点击刷新读取有界预览。</p>
        </div>
      )}
      <div className="panel-footer">
        <span>只读 · 最多 20 行 × 10 列</span>
        <span>
          {observation
            ? new Date(observation.observedAt).toLocaleTimeString()
            : "尚未观察"}
        </span>
      </div>
    </section>
  );
}
