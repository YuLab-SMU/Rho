import { useEffect, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMediaCache, useOutputs, usePlots, usePlotServices } from "./view-services.js";
import { MediaImage } from "./media-image.js";
import { Modal } from "./primitives.js";
import { fitScale } from "./plot-viewport.js";
import type { Size } from "./plot-viewport.js";
import { mediaKey } from "./output-ports.js";
export function PlotPanel({ viewId = "plots" }: { viewId?: string }) {
  const { navigation, connection, agent } = usePlotServices();
  const plots = usePlots(), outputs = useOutputs(), cache = useMediaCache(),
    snapshot = outputs.getSnapshot(),
    view = plots.view(viewId),
    images = snapshot.media,
    selected = images.find((r) => mediaKey(r) === view.selected),
    key = selected ? mediaKey(selected) : "",
    index = selected ? images.indexOf(selected) : -1;
  const canvas = useRef<HTMLDivElement>(null),
    [size, setSize] = useState<Size>({ width: 300, height: 250 }),
    [natural, setNatural] = useState<{ key: string; size: Size } | null>(null),
    [details, setDetails] = useState(false);
  const [compact, setCompact] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
      null,
    ),
    space = useRef(false);
  const image = natural?.key === key ? natural.size : null,
    p = view.transforms[key] ?? { zoom: null, x: 0, y: 0 },
    scale = image ? (p.zoom ?? fitScale(image, size)) : 1,
    original = selected ? outputs.find(selected) : null;
  function select(i: number) {
    plots.select(viewId, i);
  }
  function latest() {
    plots.latest(viewId);
  }
  function zoom(next: number, point = { x: 0, y: 0 }) {
    if (!image) return;
    plots.zoom(viewId, key, next, point, image, size);
  }
  function fit() {
    plots.fit(viewId, key);
  }
  useEffect(() => { plots.ensureView(viewId); }, [plots, viewId]);
  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (entry.target === canvas.current) setSize({ width, height });
        else setCompact(width < 280 || height < 230);
      }
    });
    observer.observe(canvas.current);
    observer.observe(canvas.current.parentElement!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (image && p.zoom !== null) {
      plots.constrain(viewId, key, image, size);
    }
  }, [size.width, size.height, key]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoom(scale * Math.exp(-e.deltaY * 0.002), {
        x: e.clientX - r.left - r.width / 2,
        y: e.clientY - r.top - r.height / 2,
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [key, scale, p.x, p.y, size, image]);
  useEffect(() => {
    cache.protect(new Set(key ? [key] : []));
  }, [cache, key]);
  const small = compact;
  return (
    <section className="panel plot-panel" data-plot-view={viewId}>
      <div className="plot-toolbar">
        <button
          className="icon-button"
          aria-label="Previous Plot"
          disabled={index <= 0}
          onClick={() => select(index - 1)}
        >
          ‹
        </button>
        <span>
          {index < 0 ? 0 : index + 1}/{images.length}
        </span>
        <button
          className="icon-button"
          aria-label="Next Plot"
          disabled={index < 0 || index >= images.length - 1}
          onClick={() => select(index + 1)}
        >
          ›
        </button>
        <button onClick={fit} disabled={!selected}>
          Fit
        </button>
        <button
          className="icon-button"
          aria-label="Zoom Out"
          disabled={!image}
          onClick={() => zoom(scale / 1.25)}
        >
          −
        </button>
        <button
          className="zoom-percent"
          title="100%: one image pixel per CSS pixel"
          disabled={!image}
          onClick={() => zoom(1)}
        >
          {image ? `${Math.round(scale * 100)}%` : "100%"}
        </button>
        <button
          className="icon-button"
          aria-label="Zoom In"
          disabled={!image}
          onClick={() => zoom(scale * 1.25)}
        >
          +
        </button>
        <Menu.Root>
          <Menu.Trigger className="icon-button" aria-label="Plot Actions">
            •••
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu" align="end">
              <Menu.Item
                disabled={index <= 0}
                onSelect={() => select(index - 1)}
              >
                Previous Plot
              </Menu.Item>
              <Menu.Item
                disabled={index < 0 || index >= images.length - 1}
                onSelect={() => select(index + 1)}
              >
                Next Plot
              </Menu.Item>
              <Menu.Item
                disabled={!selected || navigation.blocked}
                onSelect={() => navigation.openComparison(selected!)}
              >
                Open Plot in New View
              </Menu.Item>
              {agent && <Menu.Item disabled={!original || navigation.blocked} onSelect={()=>{if(original)agent.ask([original]);}}>Ask about…</Menu.Item>}
              {agent && <Menu.Item disabled={!original || navigation.blocked || connection.selectedForAgent.length>=2 || connection.selectedForAgent.some(p=>p.reference.resource===original?.reference.resource)}
                onSelect={()=>{if(original)connection.addForAgent(original);}}>Add Plot to Agent Comparison</Menu.Item>}
              <Menu.Item disabled={view.pinned} onSelect={latest}>
                Go to Latest
              </Menu.Item>
              <Menu.Item
                onSelect={() => plots.toggleHistory(viewId)}
              >
                {view.history ? "Hide" : "Show"} Plot History
              </Menu.Item>
              <Menu.Item disabled={!snapshot.hasEarlier && !snapshot.scanning || snapshot.historyLoading} onSelect={() => void outputs.loadEarlier().catch(() => undefined)}>
                Load Earlier Plots
              </Menu.Item>
              <Menu.Item disabled={!selected} onSelect={() => setDetails(true)}>
                Details
              </Menu.Item>
              <Menu.Item disabled={!selected || !navigation.exportAvailable || navigation.blocked} onSelect={() => { if (selected) navigation.exportOriginal(selected); }}>Export Original</Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {agent && (connection.selectedForAgent.length>0 || connection.savedAgent?.pending) && <div className="plot-agent-selection" aria-label="Selected plots for Agent">
        {connection.selectedForAgent.map((plot,index)=><span key={plot.reference.resource}>Plot {index+1} · output {plot.native.sequence}
          <button aria-label={`Remove plot ${index+1} from Agent input`} disabled={navigation.blocked} onClick={()=>connection.removeForAgent(index)}>×</button></span>)}
        <button disabled={navigation.blocked} onClick={()=>agent.ask()}>{connection.savedAgent?.pending?'Recover Agent request':'Ask about selected plots'}</button>
      </div>}
      {(snapshot.historyError || snapshot.scanning || snapshot.limited) && <div className="observation-notice" role="status">
        {snapshot.historyError || (snapshot.scanning ? "Scanning older Operations for retained plots…" : "Showing up to 200 retained plots.")}
        <button disabled={snapshot.historyLoading} onClick={() => { void connection.refresh(true).catch(() => undefined); }}>Read History</button>
      </div>}
      {!view.follow && !view.pinned && (
        <div className="plot-follow">
          <span>
            Inspecting history
            {images.length > view.seen
              ? ` · ${images.length - view.seen} new plots`
              : ""}
          </span>
          <button onClick={latest}>Go to Latest</button>
        </div>
      )}
      <div
        className={`plot-canvas ${small ? "preview" : ""}`}
        ref={canvas}
        tabIndex={0}
        aria-label="Plot Canvas"
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey) return;
          if (e.key === " ") {
            space.current = true;
            e.preventDefault();
          }
          if (e.key === "+" || e.key === "=") {
            e.preventDefault();
            zoom(scale * 1.25);
          }
          if (e.key === "-") {
            e.preventDefault();
            zoom(scale / 1.25);
          }
          if (e.key === "0") {
            e.preventDefault();
            fit();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " ") space.current = false;
        }}
        onBlur={() => {
          space.current = false;
          drag.current = null;
        }}
        onPointerDown={(e) => {
          if (!image || p.zoom === null || e.button !== 0) return;
          canvas.current!.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current || !image) return;
          plots.pan(viewId, key,
            {
              x: drag.current.px + e.clientX - drag.current.x,
              y: drag.current.py + e.clientY - drag.current.y,
            },
            image,
            size,
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {selected ? (
          <div
            className="plot-original"
            style={
              image
                ? {
                    width: image.width * scale,
                    height: image.height * scale,
                    transform: `translate(calc(-50% + ${p.x}px), calc(-50% + ${p.y}px))`,
                  }
                : { width: "100%", height: "100%" }
            }
          >
            <MediaImage
              key={key}
              reference={selected}
              priority
              onLoad={(img) => {
                if (img.naturalWidth && img.naturalHeight)
                  setNatural({
                    key,
                    size: {
                      width: img.naturalWidth,
                      height: img.naturalHeight,
                    },
                  });
              }}
            />
          </div>
        ) : (
          <div className="empty">
            <p>
              {view.selected
                ? "The selected plot has not been loaded."
                : "Your plots appear here."}
            </p>
            {view.selected && (
              <button onClick={() => void outputs.loadEarlier().catch(() => undefined)}>
                Load Earlier Plots
              </button>
            )}
          </div>
        )}
      </div>
      {view.history && !small && (
        <div className="plot-history" aria-label="Plot History">
          {images.map((reference, i) => (
            <button
              key={mediaKey(reference)}
              className={mediaKey(reference) === key ? "selected" : ""}
              aria-label={`Select Plot ${i + 1}`}
              aria-pressed={mediaKey(reference) === key}
              onClick={() => select(i)}
            >
              <MediaImage reference={reference} />
              <small>{i + 1}</small>
            </button>
          ))}
          <button disabled={!snapshot.hasEarlier && !snapshot.scanning || snapshot.historyLoading} onClick={() => void outputs.loadEarlier().catch(() => undefined)}>Earlier…</button>
        </div>
      )}
      <div className="panel-footer">
        <span>
          {view.pinned
            ? "Pinned plot"
            : view.follow
              ? "Following latest"
              : "History"}
          {selected
            ? ` · ${selected.mime_type === "image/svg+xml" ? "SVG" : selected.mime_type.replace("image/", "").toUpperCase()}`
            : ""}
        </span>
        {selected && <button onClick={() => setDetails(true)}>Details</button>}
      </div>
      {details && selected && (
        <Modal
          title="Plot Details"
          description="Original output. Viewing and exporting do not rerun R."
          onClose={() => setDetails(false)}
        >
          <dl>
            <dt>Operation</dt>
            <dd>{selected.operation_id}</dd>
            <dt>Resource</dt><dd>{original?.reference.resource ?? "Unknown"}</dd>
            <dt>Native session</dt><dd>{original?.session ?? "Unknown"}</dd>
            <dt>R provider</dt><dd>{connection.source.instance}</dd>
            <dt>Output</dt>
            <dd>{selected.sequence}</dd>
            <dt>Source</dt>
            <dd>
              {outputs.find(selected)?.inputSource?.label ?? "Unknown"}
            </dd>
            <dt>Run accepted</dt>
            <dd>
              {outputs.find(selected) ? new Date(outputs.find(selected)!.accepted).toLocaleString() : "Unknown"}
            </dd>
            <dt>Format</dt>
            <dd>{selected.mime_type}</dd>
            <dt>Original dimensions</dt>
            <dd>
              {selected.mime_type === "image/svg+xml"
                ? "Scalable SVG"
                : image
                  ? `${image.width} × ${image.height} pixels`
                  : "Unknown"}
            </dd>
            <dt>Bytes</dt>
            <dd>{selected.byte_size.toLocaleString()}</dd>
            <dt>SHA-256</dt>
            <dd>{selected.sha256}</dd>
          </dl>
          <button disabled={!navigation.exportAvailable || navigation.blocked} onClick={() => navigation.exportOriginal(selected)}>Export Original</button>
          {navigation.exportStatus?.busy && <p role="status">Collecting original plot…</p>}
          {navigation.exportStatus?.notice && <p role="status">{navigation.exportStatus.notice}</p>}
          {navigation.exportStatus?.error && <p role="alert">{navigation.exportStatus.error}</p>}
        </Modal>
      )}
    </section>
  );
}
