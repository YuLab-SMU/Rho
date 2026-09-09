import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAgents, useDocuments, useNavigation, useSession } from "./context";
import { Icon } from "./icons";
import { SettingsControls } from "./settings-controls";
import { NativeAgentSettings } from "./native-agent-settings";
import type { AgentConfigurationFormat } from "./agent-ports";
import type { McpSessionObservation } from "./generated/McpSessionObservation";
import "./agent-settings.css";

const basename = (path: string | null) => path?.split(/[\\/]/).filter(Boolean).at(-1) ?? "No project selected";
const time = (value: number | null) => value === null ? "Not observed" : new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const codexClient = (value: string | null) => !!value && /(^|[-_ /])codex($|[-_ /])/i.test(value);
type Section = "general" | "editor" | "runtime" | "agents";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="agent-field"><span className="agent-label">{label}</span><div className="agent-field-value">{children}</div></div>;
}
function AgentMark({ generic = false }: { generic?: boolean }) {
  return <span className={`agent-mark${generic ? " generic" : ""}`}><Icon name={generic ? "link" : "terminal"} size={25} /></span>;
}
function Setup({ format, onDone }: { format: AgentConfigurationFormat; onDone: () => void }) {
  const agents = useAgents(), state = agents.getSnapshot();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  return <section className="agent-setup" aria-label={format === "codex" ? "Codex setup" : "MCP setup"}>
    <div className="agent-section-heading"><h3 ref={title} tabIndex={-1}>{format === "codex" ? "Add Rho to Codex" : "Connect an MCP client"}</h3><button onClick={onDone} aria-label="Close setup">×</button></div>
    {format === "codex" ? <p>Add the configuration to <code>~/.codex/config.toml</code>, then reload MCP servers in Codex. Replace an existing entry with the same name.</p> : <p>Use this endpoint and Authorization header in a client that supports Streamable HTTP. Configuration format varies by client.</p>}
    <div className="agent-actions"><button className="agent-primary" disabled={!agents.canCopy} onClick={() => void agents.copyConfiguration(format)}>Copy {format === "codex" ? "Codex configuration" : "connection details"}</button></div>
    <details><summary>Configuration preview</summary><pre aria-label="Masked configuration">{agents.preview(format) || "Refresh the connection to prepare configuration."}</pre></details>
    <p className="agent-caption">The copied configuration includes a private access token. Keep it in your local user settings.</p>
    <div className="agent-verify"><h3>Verify from your agent</h3><p>Send this read-only check to confirm the project and this Studio window.</p><div className="agent-actions"><button className="agent-secondary" disabled={!agents.canCopy || !agents.window} onClick={() => void agents.copyContext()}>Copy connection check</button><button onClick={onDone}>Done</button></div></div>
    {state.feedback && <p role="status" className="agent-feedback">{state.feedback}</p>}
  </section>;
}

function AgentApps() {
  const agents = useAgents(), session = useSession(), documents = useDocuments();
  const state = agents.getSnapshot(), [expanded, setExpanded] = useState<AgentConfigurationFormat | null>("codex"), [setup, setSetup] = useState<AgentConfigurationFormat | null>(null);
  const connected = !state.stale && state.data?.sessions.some(s => s.closed_at_ms === null && codexClient(s.client_reported_name));
  const label = state.stale ? state.error ? "Unavailable" : "Checking…" : connected ? "Session open" : "Not connected";
  const current = documents.current;
  const toggle = (format: AgentConfigurationFormat) => { setExpanded(expanded === format ? null : format); setSetup(null); };
  return <div className="agent-list">
    <div className="agent-list-heading"><span>Choose an agent</span><span>Local workspace</span></div>
    <article className={`agent-card${expanded === "codex" ? " selected" : ""}`}>
      <button className="agent-row" aria-expanded={expanded === "codex"} aria-controls="codex-options" onClick={() => toggle("codex")}>
        <AgentMark /><span className="agent-name"><strong>Codex</strong><small>OpenAI · Desktop app &amp; CLI</small></span>
        <span className={`agent-badge${connected ? " open" : ""}`}>{label}</span><span className="agent-chevron"><Icon name="chevron" /></span>
      </button>
      {expanded === "codex" && <div id="codex-options" className="agent-options">
        <Field label="Workspace"><Icon name="folder" size={18} /><span className="agent-value" title={session.project ?? undefined}>{basename(session.project)}</span><small>{session.project ? "Current project" : "Open a project first"}</small></Field>
        <Field label="Start with"><span className="agent-value">This window{current ? ` · ${current.name}` : ""}</span><small>{current?.dirty ? "Unsaved changes" : current ? "Saved" : "No active document"}</small></Field>
        <div className="agent-actions"><button className="agent-primary" disabled={!agents.canCopy} onClick={() => setSetup("codex")}>Connect Codex</button><button className="agent-link" disabled={!agents.canCopy} onClick={() => setSetup(setup ? null : "codex")}>Manual setup</button><small className="agent-action-note">Uses your Codex account and settings</small></div>
        {setup === "codex" && <Setup format="codex" onDone={() => setSetup(null)} />}
      </div>}
    </article>
    <article className={`agent-card${expanded === "mcp" ? " selected" : ""}`}>
      <button className="agent-row" aria-expanded={expanded === "mcp"} aria-controls="mcp-options" onClick={() => toggle("mcp")}><AgentMark generic /><span className="agent-name"><strong>Another agent</strong><small>Use a standard MCP connection</small></span><span className="agent-chevron"><Icon name="chevron" /></span></button>
      {expanded === "mcp" && <div id="mcp-options" className="agent-options"><Setup format="mcp" onDone={() => setExpanded(null)} /></div>}
    </article>
    {!session.project && <p className="agent-caption">Open a project to prepare an Agent connection.</p>}
  </div>;
}

function Connection({ row, stale }: { row: McpSessionObservation; stale: boolean }) {
  const agents = useAgents(), session = useSession(), documents = useDocuments();
  const open = row.closed_at_ms === null, [expanded, setExpanded] = useState(open), [details, setDetails] = useState(false);
  const ref = agents.window;
  const served = ref && row.window_contexts.find(w => w.window.window_id === ref.window_id && w.window.incarnation === ref.incarnation);
  const name = row.client_reported_name || "MCP client";
  return <article className={`agent-card${expanded ? " selected" : ""}`}>
    <button className="agent-row" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <AgentMark generic={!codexClient(row.client_reported_name)} /><span className="agent-name"><strong>{name}</strong><small>{open ? "Client-reported" : "Earlier session"}{row.client_reported_version ? ` · ${row.client_reported_version}` : ""}</small></span>
      <span className={`agent-badge${open && !stale ? " open" : ""}`}>{stale ? "Last observed" : open ? "Session open" : `Closed at ${time(row.closed_at_ms)}`}</span><span className="agent-chevron"><Icon name="chevron" /></span>
    </button>
    {expanded && <>
      <div className="agent-shared-context"><div><span className="agent-label">Workspace</span><strong>{basename(session.project)}</strong><small>{session.runtime ? `R session ${session.runtime.state}` : "Live R unavailable"}</small></div><div><span className="agent-label">This window</span><strong>{documents.current?.name ?? "No active document"}</strong><small>{served ? `Window context served at ${time(served.served_at_ms)}` : "Window context not yet observed"}</small></div></div>
      <div className="agent-connection-actions"><button className="agent-primary" disabled={!agents.canCopy || !ref} onClick={() => void agents.copyContext()}>Copy workspace context</button><button className="agent-link" aria-expanded={details} onClick={() => setDetails(!details)}>Connection details</button><small className="agent-action-note">Last request {time(row.last_request_at_ms)}</small></div>
      {details && <div className="agent-connection-details"><dl><dt>Project</dt><dd>{session.project}</dd><dt>Connection</dt><dd>{row.connection_id}</dd><dt>Initialized</dt><dd>{time(row.initialized_at_ms)}</dd><dt>Overview served</dt><dd>{time(row.overview_served_at_ms)}</dd><dt>Window</dt><dd>{ref ? `${ref.window_id} / ${ref.incarnation}` : "Not synchronized"}</dd><dt>Endpoint</dt><dd>{agents.getSnapshot().data?.endpoint}</dd></dl><p>These are server observations. An open MCP session does not mean an Agent task is running, and closing a session does not cancel accepted R work.</p>{row.window_contexts_truncated && <p>Only the latest 16 window references are retained.</p>}</div>}
    </>}
  </article>;
}

function Connections() {
  const agents = useAgents(), state = agents.getSnapshot();
  const active = state.data?.sessions.filter(s => s.closed_at_ms === null) ?? [];
  const closed = state.data?.sessions.filter(s => s.closed_at_ms !== null) ?? [];
  return <div className="agent-list">
    <div className="agent-list-heading"><span>{state.stale ? "Last observed connections" : "Connected to this workspace"}</span><button className="agent-secondary pill" disabled={state.loading} onClick={() => void agents.refresh()}>{state.loading ? "Refreshing…" : "Refresh"}</button></div>
    {active.map(row => <Connection key={row.connection_id} row={row} stale={state.stale} />)}
    {!active.length && <div className="agent-empty"><Icon name="link" size={28} /><h3>{state.stale ? "Connection status unavailable" : "No open MCP sessions"}</h3><p>{state.stale ? "Refresh to check this Workbench." : "Set up your agent, then send the connection check. Its session will appear here."}</p></div>}
    {!!closed.length && <div className="agent-recent-heading">Recent sessions</div>}
    {closed.map(row => <Connection key={row.connection_id} row={row} stale={state.stale} />)}
    {state.data?.history_truncated && <p className="agent-caption">Showing up to 64 retained sessions. {state.data.active_sessions} sessions were open at the last observation.</p>}
    {state.feedback && <p role="status" className="agent-feedback">{state.feedback}</p>}
  </div>;
}

function AgentSettings() {
  const agents = useAgents(), state = agents.getSnapshot(), [tab, setTab] = useState("apps");
  useEffect(() => { agents.show(); return () => agents.hide(); }, [agents]);
  return <>
    <div className="agent-tabs" role="tablist" aria-label="Agent settings" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? "apps" : event.key === "End" ? "connections" : tab === "apps" ? "connections" : "apps";
      setTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#agent-tab-${next}`)?.focus();
    }}>
      {["apps", "connections"].map(value => <button key={value} id={`agent-tab-${value}`} role="tab" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} aria-controls="agent-tab-panel" onClick={() => setTab(value)}>{value === "apps" ? "Agent apps" : "Connections"}{value === "connections" && !state.stale && !!state.data?.active_sessions && <span className="agent-count">{state.data.active_sessions}</span>}</button>)}
    </div>
    {state.error && <div className="agent-error" role="alert"><span>{state.error}{state.stale ? " Previous observations may be stale." : ""}</span><button disabled={state.loading} onClick={() => void agents.refresh()}>Retry</button></div>}
    <div role="tabpanel" id="agent-tab-panel" aria-labelledby={`agent-tab-${tab}`}>{tab === "apps" ? <><NativeAgentSettings /><details className="native-manual"><summary>Advanced: manual MCP setup</summary><AgentApps /></details></> : <Connections />}</div>
  </>;
}

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<Section>("agents"), session = useSession(), navigation = useNavigation();
  const opener = useRef(document.activeElement as HTMLElement | null);
  const sections = [
    { id: "general", name: "General", icon: "settings", description: "Your local scientific workspace." },
    { id: "editor", name: "Editor", icon: "code", description: "Make scripts comfortable to read and edit." },
    { id: "runtime", name: "R session", icon: "terminal", description: "Use an installed R and Ark runtime." },
    { id: "agents", name: "Agents", icon: "agent", description: "Connect the agent you use to your scientific workspace." },
  ] as const;
  const current = sections.find(s => s.id === section)!;
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Content className="settings-page" onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}>
    <header className="settings-chrome"><strong className="settings-wordmark">rho</strong><span className="settings-divider" /><span className="settings-project" title={session.project ?? undefined}>{basename(session.project)}</span><Dialog.Close className="settings-back"><Icon name="back" />Back to workspace</Dialog.Close></header>
    <nav className="settings-sidebar" aria-label="Settings sections"><Dialog.Title className="settings-nav-title">Settings</Dialog.Title>{sections.map(s => <button key={s.id} aria-current={section === s.id ? "page" : undefined} onClick={() => setSection(s.id)}><Icon name={s.icon} size={18} />{s.name}</button>)}</nav>
    <main className="settings-main"><div className="settings-inner"><div className="settings-heading"><h2>{current.name}</h2><Dialog.Description>{current.description}</Dialog.Description></div>
      {section === "agents" ? <AgentSettings /> : section === "general" ? <div className="agent-options"><Field label="Project"><Icon name="folder" /><span className="agent-value">{basename(session.project)}</span></Field><p className="agent-caption break-path">{session.project}</p><button className="agent-secondary" onClick={() => navigation.setDialog("project")}>Open project</button></div> : <SettingsControls key={`${section}:${session.epoch}`} section={section} />}
    </div></main>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
