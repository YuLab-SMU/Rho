import { useEffect, useId, useState } from "react";

import type {
  PluginSurfaceBlock,
  PluginSurfaceDocumentRequest,
  PluginSurfaceEventKind,
  UiKernelTransport,
} from "../transport";
import { SurfaceTaskState } from "./SurfaceTaskState";

function PluginField({
  block,
  dispatch,
}: {
  readonly block: Extract<PluginSurfaceBlock, { kind: "field" }>;
  readonly dispatch: (controlId: string, kind: PluginSurfaceEventKind, value: string) => void;
}) {
  const [value, setValue] = useState(block.value);
  useEffect(() => setValue(block.value), [block.value]);
  return (
    <label className="rho-plugin-field">
      <span>{block.label}</span>
      <input
        value={value}
        placeholder={block.placeholder ?? ""}
        disabled={block.disabled || block.busy}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value !== block.value) dispatch(block.control_id, "change", value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") dispatch(block.control_id, "submit", value);
        }}
      />
    </label>
  );
}

function PluginTabs({
  block,
  dispatch,
  path,
}: {
  readonly block: Extract<PluginSurfaceBlock, { kind: "tabs" }>;
  readonly dispatch: (controlId: string, kind: PluginSurfaceEventKind, value: string) => void;
  readonly path: string;
}) {
  const [activeTabId, setActiveTabId] = useState(block.active_tab_id);
  const baseId = useId();
  useEffect(() => setActiveTabId(block.active_tab_id), [block.active_tab_id]);
  const active = block.tabs.find((tab) => tab.tab_id === activeTabId) ?? block.tabs[0];
  return <section className="rho-plugin-tabs">
    <div
      role="tablist"
      aria-label="Component sections"
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
      {block.tabs.map((tab) => {
        const selected = tab.tab_id === active?.tab_id;
        return <button
          type="button"
          role="tab"
          aria-selected={selected}
          aria-controls={`${baseId}-panel-${tab.tab_id}`}
          id={`${baseId}-tab-${tab.tab_id}`}
          tabIndex={selected ? 0 : -1}
          key={tab.tab_id}
          onClick={() => setActiveTabId(tab.tab_id)}
        >{tab.label}</button>;
      })}
    </div>
    {active != null && <div
      role="tabpanel"
      id={`${baseId}-panel-${active.tab_id}`}
      aria-labelledby={`${baseId}-tab-${active.tab_id}`}
    >
      <PluginSurfaceBlocks blocks={active.blocks} dispatch={dispatch} path={`${path}:${active.tab_id}`} />
    </div>}
  </section>;
}
function PluginSurfaceBlocks({
  blocks,
  dispatch,
  path = "root",
}: {
  readonly blocks: readonly PluginSurfaceBlock[];
  readonly dispatch: (controlId: string, kind: PluginSurfaceEventKind, value: string) => void;
  readonly path?: string;
}) {
  return <>{blocks.map((block, index) => {
    const key = `${path}:${index}:${block.kind}`;
    switch (block.kind) {
      case "row":
      case "column":
        return <div className={`rho-plugin-${block.kind}`} key={key}><PluginSurfaceBlocks blocks={block.blocks} dispatch={dispatch} path={key} /></div>;
      case "grid":
        return <div className="rho-plugin-grid" style={{ gridTemplateColumns: `repeat(${block.columns}, minmax(0, 1fr))` }} key={key}>{block.blocks.map((item, itemIndex) => <div style={{ gridColumn: `span ${item.column_span}` }} key={`${key}:${itemIndex}`}><PluginSurfaceBlocks blocks={[item.block]} dispatch={dispatch} path={`${key}:${itemIndex}`} /></div>)}</div>;
      case "tabs": return <PluginTabs block={block} dispatch={dispatch} path={key} key={key} />;
      case "group":
        return <section className="rho-plugin-group" key={key}>{block.label != null && <h4>{block.label}</h4>}<PluginSurfaceBlocks blocks={block.blocks} dispatch={dispatch} path={key} /></section>;
      case "text": return <p className="rho-plugin-text" dir="auto" key={key}>{block.text}</p>;
      case "code": return <pre className="rho-plugin-code" dir="auto" data-language={block.language ?? undefined} key={key}><code>{block.code}</code></pre>;
      case "key_value": return <dl className="rho-plugin-key-value" key={key}>{block.items.map((item, itemIndex) => <div dir="auto" key={`${key}:${itemIndex}`}><dt>{item.key}</dt><dd>{item.value}</dd></div>)}</dl>;
      case "table": return <div className="rho-plugin-table-wrap" key={key}><table><thead><tr>{block.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={`${key}:${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${key}:${rowIndex}:${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div>;
      case "notice": return <div className={`rho-plugin-notice rho-plugin-notice-${block.tone}`} role="status" key={key}>{block.text}</div>;
      case "artifact_image_ref": return <figure className="rho-plugin-artifact" key={key}><div aria-hidden="true">Artifact image</div><figcaption>{block.alt} · <code>{block.artifact_id}</code></figcaption></figure>;
      case "field": return <PluginField block={block} dispatch={dispatch} key={key} />;
      case "select": return <label className="rho-plugin-field" key={key}><span>{block.label}</span><select value={block.value} disabled={block.disabled || block.busy} onChange={(event) => dispatch(block.control_id, "change", event.target.value)}>{block.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
      case "command_button": return <button className="rho-plugin-command" type="button" disabled={block.disabled || block.busy} onClick={() => dispatch(block.control_id, "activate", "")} key={key}>{block.label}</button>;
    }
  })}</>;
}

export function PluginSurfaceView({
  request,
  transport,
  close,
  reportError,
}: {
  readonly request: PluginSurfaceDocumentRequest;
  readonly transport: UiKernelTransport;
  readonly close: () => void;
  readonly reportError: (error: unknown) => void;
}) {
  const [document, setDocument] = useState<Awaited<ReturnType<UiKernelTransport["loadPluginSurfaceDocument"]>>["document"] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "busy" | "failed">("loading");
  const load = () => {
    setStatus((current) => current === "busy" ? current : "loading");
    void transport.loadPluginSurfaceDocument(request).then((view) => {
      setDocument(view.document);
      setStatus("ready");
    }).catch((error: unknown) => {
      setStatus("failed");
      reportError(error);
    });
  };
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) load();
    };
    refresh();
    const unsubscribe = transport.subscribePluginSurfacesInvalidated(refresh);
    return () => { active = false; unsubscribe(); };
  }, [
    request.target.instance_id,
    request.target.expected_project_revision,
    request.target.expected_surface_revision,
    request.expected_layout_revision,
    request.expected_page_revision,
    transport,
  ]);
  const dispatch = (controlId: string, eventKind: PluginSurfaceEventKind, value: string) => {
    if (document == null || status === "busy") return;
    setStatus("busy");
    void transport.dispatchPluginSurfaceEvent({
      ...request,
      expected_document_revision: document.revision,
      control_id: controlId,
      event_kind: eventKind,
      value,
    }).then((result) => {
      if (result.document != null) setDocument(result.document);
      setStatus(result.status === "queued" ? "loading" : "ready");
    }).catch((error: unknown) => {
      setStatus("failed");
      reportError(error);
    });
  };
  if (document == null) {
    if (status === "failed") {
      return (
        <SurfaceTaskState
          tone="error"
          title="Project component unavailable"
          detail="Its workspace plugin is disabled or incompatible. Placement and bindings are preserved."
          role="alert"
          className="rho-plugin-surface-state rho-plugin-surface-failed"
        >
          <button type="button" onClick={load}>Try again</button>
          <button type="button" onClick={close}>Close component</button>
        </SurfaceTaskState>
      );
    }
    return <SurfaceTaskState
      tone="loading"
      title="Loading project component…"
      detail="The workspace plugin is preparing its current document."
      role="status"
      busy
      className={`rho-plugin-surface-state rho-plugin-surface-${status}`}
    />;
  }
  return <section className={`rho-plugin-surface-document rho-plugin-surface-${status}`} aria-busy={status === "busy"}>
    {status === "busy" && <div className="rho-plugin-surface-progress" role="status">Updating project component…</div>}
    <header>
      <span>Project component</span><strong>{document.title}</strong>
      <details className="rho-plugin-document-meta"><summary>Document details</summary><small>Workspace plugin · document revision {document.revision}</small></details>
    </header>
    {document.blocks.length === 0
      ? <SurfaceTaskState tone="empty" title="Nothing to show yet" detail="This project component returned an empty document." role="status" />
      : <PluginSurfaceBlocks blocks={document.blocks} dispatch={dispatch} />}
  </section>;
}
