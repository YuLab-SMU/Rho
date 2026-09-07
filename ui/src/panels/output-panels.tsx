import { useEffect, useRef, useState } from "react";
import { useStudio } from "../context";
import { message } from "../host-client";
import type { MediaReference } from "../generated/MediaReference";
import type { RunROutput } from "../generated/RunROutput";

const statuses: Record<string, string> = {
  accepted: "已接受",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已中断",
  uncertain: "结果未确认",
  reconciling: "核对中",
};
export function MediaImage({
  reference,
  className,
}: {
  reference: MediaReference;
  className?: string;
}) {
  const s = useStudio(),
    key = s.mediaKey(reference);
  useEffect(() => {
    void s.loadMedia(reference);
  }, [s, key]);
  const url = s.mediaUrls.get(key),
    error = s.mediaErrors.get(key);
  return url && !error ? (
    <img
      className={className}
      src={url}
      alt={`R 图形 ${reference.sequence}`}
      draggable={false}
      onError={() => {
        s.mediaErrors.set(key, "浏览器无法解码原始图形；仍可导出原始字节。");
        s.emit();
      }}
    />
  ) : (
    <span className={error ? "error" : "muted"}>
      {error ?? "读取原始图形…"}
    </span>
  );
}
export function ConsolePanel() {
  const s = useStudio(),
    history = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    lastHeight = useRef(0),
    [hiddenBefore, setHiddenBefore] = useState(0);
  const records = [...s.records.values()]
    .filter((r) => r.operation.capability.id.startsWith("workspace."))
    .sort((a, b) => a.operation.accepted_at_ms - b.operation.accepted_at_ms);
  useEffect(() => {
    const el = history.current;
    if (!el) return;
    lastHeight.current = el.clientHeight;
    const observer = new ResizeObserver(() => {
      lastHeight.current = el.clientHeight;
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const outputCount = [...s.outputEvents.values()].reduce(
    (sum, events) => sum + events.length,
    0,
  );
  useEffect(() => {
    if (follow.current && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [outputCount, records.length, s.busy]);
  async function run() {
    const code = s.consoleInput;
    if (!s.canRun || !code.trim()) return;
    s.consoleInput = "";
    s.persist();
    s.emit();
    try {
      await s.run(code);
    } catch (e) {
      s.error = message(e);
      s.emit();
    }
  }
  const visible = records.filter(
    (r) => r.operation.accepted_at_ms >= hiddenBefore,
  );
  return (
    <section className="panel console-panel">
      <div className="console-status">
        <span>
          {s.pending.some((p) => p.error)
            ? "请求未确认"
            : s.busy
              ? "R 运行中"
              : s.runtime?.state === "idle"
                ? "R 已就绪"
                : "R 不可用"}
        </span>
        <button
          disabled={!s.busy}
          onClick={() =>
            void s.cancel().catch((e) => {
              s.error = message(e);
              s.emit();
            })
          }
        >
          中断运行
        </button>
      </div>
      <div
        className="console-history"
        ref={history}
        onScroll={() => {
          const el = history.current!;
          if (el.clientHeight === lastHeight.current)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {s.recentCursor !== null && (
          <button onClick={() => void s.loadRecent(true)}>更早的运行</button>
        )}
        {hiddenBefore > 0 && (
          <button onClick={() => setHiddenBefore(0)}>显示已清除的历史</button>
        )}
        {!visible.length && (
          <p className="muted">
            {s.info?.runtime === "ark"
              ? "本机 R 已就绪。输入代码，按 ⌘ Enter 执行。"
              : "配置本机 R 后开始执行。"}
          </p>
        )}
        {visible.map((r) => {
          const id = r.operation.operation_id,
            out = r.output as RunROutput | null,
            args = r.operation.normalized_arguments as { code?: string };
          const events = s.outputEvents.get(id) ?? [];
          return (
            <div
              className="run"
              key={id}
              data-operation-id={id}
              data-status={r.status}
            >
              <div className="run-meta">
                <span className={r.status === "failed" ? "error" : ""}>
                  {statuses[r.status] ?? r.status} · {id.slice(-8)}
                </span>
                <time>
                  {new Date(r.operation.accepted_at_ms).toLocaleTimeString()}
                </time>
              </div>
              {args.code && <pre className="input-code">{args.code}</pre>}
              <div className="stream-output">
                {events.map((event) =>
                  event.media ? (
                    <button
                      className="media-card"
                      key={event.sequence}
                      onClick={() => s.locatePlot(event.media!)}
                    >
                      <div className="thumbnail">
                        <MediaImage reference={event.media} />
                      </div>
                      <span>
                        图 {event.sequence} ·{" "}
                        {event.media.mime_type
                          .replace("image/", "")
                          .toUpperCase()}
                        <small>在图表组件中定位 →</small>
                      </span>
                    </button>
                  ) : event.text ? (
                    <pre
                      key={event.sequence}
                      className={
                        event.kind === "stderr"
                          ? "error"
                          : event.kind === "truncated" ||
                              event.kind === "unsupported"
                            ? "muted"
                            : ""
                      }
                    >
                      {event.text}
                    </pre>
                  ) : null,
                )}
              </div>
              {!events.length && out?.stdout && <pre>{out.stdout}</pre>}
              {!events.length && out?.stderr && (
                <pre className="error">{out.stderr}</pre>
              )}
              {out?.value != null && (
                <pre className="return-value">
                  {typeof out.value === "string"
                    ? out.value
                    : JSON.stringify(out.value, null, 2)}
                </pre>
              )}
              {out?.conditions.map((c, i) => (
                <pre className="condition" key={i}>
                  {typeof c === "object" && c && "message" in c
                    ? String(c.message)
                    : JSON.stringify(c)}
                </pre>
              ))}
              {r.error && <pre className="error">{r.error}</pre>}
              {s.outputNotices.has(id) && (
                <p className="observation-notice">{s.outputNotices.get(id)}</p>
              )}
            </div>
          );
        })}
        {s.pending
          .filter((p) => p.error)
          .map((p) => (
            <div className="error" key={p.invocation.client_request_id}>
              请求 {p.invocation.client_request_id}：{p.error}
              <button onClick={() => void s.observe()}>核对原请求</button>
              <button
                disabled={!s.connected}
                onClick={() => void s.retryPending(p)}
              >
                重试原请求（同一 ID）
              </button>
              {!p.ignored && (
                <button
                  onClick={() => {
                    p.ignored = true;
                    s.persist();
                    s.emit();
                  }}
                >
                  继续工作，保留原请求待核对
                </button>
              )}
            </div>
          ))}
      </div>
      <form
        className="console-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <span>&gt;</span>
        <textarea
          aria-label="R Console 输入"
          value={s.consoleInput}
          onChange={(e) => {
            s.consoleInput = e.target.value;
            s.persist();
            s.emit();
          }}
          onKeyDown={(e) => {
            if (
              (e.metaKey || e.ctrlKey) &&
              e.key === "Enter" &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <button
          className="primary"
          disabled={!s.canRun || !s.consoleInput.trim()}
        >
          执行
        </button>
      </form>
      <div className="panel-footer">
        <span>当前会话：本机 R</span>
        <button onClick={() => setHiddenBefore(Date.now())}>清空显示</button>
      </div>
    </section>
  );
}
export function PlotPanel() {
  const s = useStudio(),
    images = s.media,
    selected = images.find((r) => s.mediaKey(r) === s.selectedPlot),
    index = selected ? images.indexOf(selected) : -1;
  const [preview, setPreview] = useState(false),
    container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver((entries) => {
      const size = entries[0].contentRect;
      setPreview(size.width < 280 || size.height < 150);
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  function step(delta: number) {
    const reference = images[index + delta];
    if (reference) s.selectPlot(reference);
  }
  const url = selected ? s.mediaUrls.get(s.mediaKey(selected)) : null;
  return (
    <section className="panel plot-panel">
      <div className="plot-toolbar">
        <button
          className="icon-button"
          aria-label="上一张图"
          disabled={index <= 0}
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <span>
          {index < 0 ? 0 : index + 1} / {images.length}
        </span>
        <button
          className="icon-button"
          aria-label="下一张图"
          disabled={index < 0 || index >= images.length - 1}
          onClick={() => step(1)}
        >
          ›
        </button>
        <div className="spacer" />
        <select
          aria-label="图形缩放"
          value={s.plotZoom ?? "fit"}
          onChange={(e) => {
            s.plotZoom =
              e.target.value === "fit" ? null : Number(e.target.value);
            s.persist();
            s.emit();
          }}
        >
          <option value="fit">适应面板</option>
          <option value="0.5">50%</option>
          <option value="1">100% 原图</option>
          <option value="2">200%</option>
        </select>
        {selected && url && (
          <a
            className="button-link"
            href={url}
            download={`${selected.operation_id}-${selected.sequence}.${selected.mime_type === "image/svg+xml" ? "svg" : selected.mime_type === "image/jpeg" ? "jpg" : "png"}`}
          >
            ↓ 导出
          </a>
        )}
      </div>
      <div
        ref={container}
        className={`plot-canvas ${s.plotZoom === null ? "fit" : "zoomed"} ${preview ? "preview" : ""}`}
      >
        {selected ? (
          <div
            className="plot-image"
            style={s.plotZoom === null ? undefined : { zoom: s.plotZoom }}
          >
            <MediaImage reference={selected} />
          </div>
        ) : (
          <div className="empty">
            <p>
              {s.selectedPlot
                ? "所选历史图尚未读取。请加载对应的更早运行。"
                : "R 产生的图形将在这里显示。"}
            </p>
            <p>PNG、JPEG、SVG · 查看不会重新运行代码</p>
          </div>
        )}
      </div>
      <div className="panel-footer">
        <span>
          {selected
            ? `${selected.operation_id.slice(-8)} · 图 ${selected.sequence}`
            : "暂无图形"}
        </span>
        <span>
          {preview
            ? "预览 · 可切换原图并导出"
            : selected?.mime_type.replace("image/", "").toUpperCase()}
        </span>
      </div>
    </section>
  );
}
