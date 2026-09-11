import { useState } from "react";
import type { ComponentProps, ReactElement } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Icon } from "../icons";
import { builtinPanels } from "../builtin-panels";
import { useAgentTasks, useApplication, useConsole, useDocuments, useFiles, useLayout, useNavigation, useOperations, usePersistence, usePreferences, useRuntimeSessions, useSession } from "../context";
import { message } from "../shared/ports";
import type { EditorPreferences } from "../application-state";
import type { WorkspaceInstance } from "../generated/WorkspaceInstance";

function Tip({ label, children }: { label: string; children: ReactElement }) {
  return <Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="shell-tooltip" side="right" sideOffset={8}>{label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}
const modules = ["files", "editor", "console", "objects", "plots", "packages"] as const;
const icons: Record<typeof modules[number], ComponentProps<typeof Icon>["name"]> = { files: "folder", editor: "code", console: "terminal", objects: "object", plots: "plot", packages: "package" };

export function WorkspaceSidebar() {
  const layout = useLayout(), documents = useDocuments(), preferences = usePreferences(), session = useSession(), navigation = useNavigation(), agents = useAgentTasks();
  const state = layout.getSnapshot(), agent = agents.getSnapshot(), expanded = preferences.getSnapshot().sidebarExpanded;
  const active = state.activeTabId ? state.knownViews[state.activeTabId]?.component : null;
  const focused = active === "document" ? "editor" : active === "viewer" ? "objects" : active;
  const show = (component: typeof modules[number]) => {
    if (component === "editor" && documents.current) documents.focus(documents.current);
    else layout.show(component);
  };
  const update = (patch: Partial<EditorPreferences>) => void preferences.setPreferences(patch).catch(e => session.reportError(message(e)));
  return <Tooltip.Provider delayDuration={350}><nav className={`workspace-sidebar${expanded ? " is-expanded" : ""}`} aria-label="Workspace modules">
    <div className="sidebar-modules">{modules.map(component => {
      const label = builtinPanels[component].name;
      const views = Object.entries(state.knownViews).filter(([, view]) => view.component === component);
      const button = <button type="button" className="sidebar-item" aria-label={label} aria-current={focused === component ? "true" : undefined} disabled={!session.ready} onClick={() => show(component)}><Icon name={icons[component]} size={19} /><span className="sidebar-label">{label}</span></button>;
      return views.length > 1 ? <Menu.Root key={component}><Tip label={label}><Menu.Trigger asChild>{<button type="button" className="sidebar-item" aria-label={label} aria-current={focused === component ? "true" : undefined} disabled={!session.ready}><Icon name={icons[component]} size={19} /><span className="sidebar-label">{label}</span></button>}</Menu.Trigger></Tip><Menu.Portal><Menu.Content className="menu shell-menu sidebar-view-menu" side="right" align="start" sideOffset={8} collisionPadding={8}><Menu.Label className="shell-menu-heading">{label} · {views.length} views</Menu.Label>{views.map(([id, view]) => <Menu.Item key={id} onSelect={() => layout.show(component, id, view.name, view.config)}><span className="menu-check">{state.activeTabId === id && <Icon name="check" size={14} />}</span><span className="shell-view-name">{view.name}</span><small>{state.closedViews.has(id) ? "Closed" : layout.isCollapsed(id) ? "Collapsed" : state.activeTabId === id ? "Current" : ""}</small></Menu.Item>)}</Menu.Content></Menu.Portal></Menu.Root> : <Tip key={component} label={label}>{button}</Tip>;
    })}</div>
    <div className="sidebar-separator" />
    <div className="sidebar-agent at-launcher"><Tip label="Agent"><button type="button" className="sidebar-item" aria-label="Agents" aria-current={focused === "agent" ? "true" : undefined} disabled={!session.ready} onClick={() => layout.show("agent")}><Icon name="agent" size={19} /><span className="sidebar-label">Agent</span>{agent.running > 0 && !agent.permissions && <span className="sidebar-running" aria-label={`${agent.running} Agent tasks running`} />}</button></Tip>
      {agent.permissions > 0 && <Menu.Root><Menu.Trigger asChild><button type="button" className="at-launcher-badge" aria-label={`${agent.permissions} Agent permissions pending`}>{agent.permissions}</button></Menu.Trigger><Menu.Portal><Menu.Content className="menu shell-menu" side="right" sideOffset={8} collisionPadding={8}><Menu.Label className="shell-menu-heading">Agent needs attention</Menu.Label>{agent.attention.map(t => <Menu.Item key={t.task.task_id} onSelect={() => { agents.select(t.task.task_id); layout.show("agent"); }}><Icon name="warning" size={16} /><span className="shell-view-name">{t.task.title}</span></Menu.Item>)}{!agent.attention.length && <Menu.Item onSelect={() => layout.show("agent")}>Open pending task</Menu.Item>}</Menu.Content></Menu.Portal></Menu.Root>}
    </div>
    <div className="sidebar-bottom">
      <Tip label={expanded ? "Collapse sidebar" : "Expand sidebar"}><button type="button" className="sidebar-item" aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"} aria-expanded={expanded} onClick={() => update({ sidebarExpanded: !expanded })}><Icon name="sidebar" size={18} /><span className="sidebar-label">Collapse</span></button></Tip>
      <Menu.Root><Tip label="Settings"><Menu.Trigger asChild><button type="button" className="sidebar-item" aria-label="Settings"><Icon name="settings" size={18} /><span className="sidebar-label">Settings</span></button></Menu.Trigger></Tip><Menu.Portal><Menu.Content className="menu shell-menu sidebar-view-menu" side="right" align="end" sideOffset={8} collisionPadding={8}><Menu.Item onSelect={() => navigation.setDialog("settings")}>R and Editor Settings…</Menu.Item><Menu.Item onSelect={() => navigation.setDialog("agents")}>Agent Settings…</Menu.Item></Menu.Content></Menu.Portal></Menu.Root>
    </div>
  </nav></Tooltip.Provider>;
}

export function ProjectMenu() {
  const session = useSession(), navigation = useNavigation();
  return <Menu.Root><Menu.Trigger className="project-button" title={session.project ?? "Open Project"}><Icon name="folder" /><span>{session.project?.split(/[\\/]/).at(-1) ?? "Open Project"}</span><Icon name="chevron" size={12} /></Menu.Trigger><Menu.Portal><Menu.Content className="menu shell-menu" sideOffset={8} align="start" collisionPadding={8}>
    <Menu.Label className="shell-menu-heading">Project directory</Menu.Label><div className="shell-project-path">{session.project ?? "No project open"}</div>
    <Menu.Item disabled={!session.project} onSelect={() => void navigator.clipboard.writeText(session.project!).catch(e => session.reportError(message(e)))}>Copy path</Menu.Item><Menu.Separator className="shell-menu-separator" />
    <Menu.Item onSelect={() => navigation.setDialog("project")}>Open Project…</Menu.Item>
  </Menu.Content></Menu.Portal></Menu.Root>;
}

export function formatBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"], index = Math.min(4, Math.floor(Math.log2(Math.max(1, bytes)) / 10));
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

export function WorkspaceStatusBar() {
  const session = useSession(), consoleOwner = useConsole(), operations = useOperations(), files = useFiles(), preferences = usePreferences(), persistence = usePersistence(), documents = useDocuments(), navigation = useNavigation(), application = useApplication();
  const [open, setOpen] = useState(false), now = Date.now();
  const prefs = preferences.getSnapshot(), ss = session.getSnapshot(), fs = files.getSnapshot(), cs = consoleOwner.getSnapshot();
  const runtime = ss.runtime, runtimeFresh = ss.connected && !!runtime && !ss.runtimeError && now - runtime.observed_at_ms < 10000;
  const queue = cs.state?.session_id === runtime?.session_id && runtimeFresh && !cs.error ? cs.state : null;
  const input = queue?.input, record = queue?.current ? operations.records.get(queue.current.operation_id) : undefined;
  const status = !ss.connected ? "Connection lost" : !session.r?.current ? "Not configured" : !runtime ? "Not started" : !runtimeFresh ? "R state unknown" : input ? "Waiting for R input" : runtime.state === "busy" || record?.status === "running" ? "Running" : queue?.current ? "Queued" : runtime.state === "idle" ? "Idle" : runtime.state === "starting" ? "Starting R" : "Unavailable";
  const showConsole = () => { const source = queue?.current?.source; navigation.showPanel("console", source?.kind === "console" ? source.view_id : "console", source?.kind === "console" ? source.label : "Console"); };
  const process = runtimeFresh ? runtime?.processes[0] : null;
  const cpu = process?.cpu_percent == null || !Number.isFinite(process.cpu_percent) ? "Unknown" : `${process.cpu_percent.toFixed(1)}%`;
  const memory = formatBytes(process?.memory_bytes);
  const diskFresh = ss.connected && !!fs.storage && !fs.storageError && now - fs.storage.observed_at_ms < 30000;
  const disk = diskFresh ? fs.storage : null;
  const diskValue = disk ? `${Math.round((1 - disk.free_bytes / disk.total_bytes) * 100)}%` : "Unknown";
  const diskSupported = session.context().capabilities.includes("project.storage_status");
  const metrics = [
    { key: "statusCpu", label: "R CPU", value: cpu, detail: "CPU usage of the Ark process that embeds R; can exceed 100% across cores." },
    { key: "statusMemory", label: "R memory", value: memory, detail: "Memory used by the Ark process that embeds R; excludes unrelated child processes." },
    { key: "statusDisk", label: "Project disk", value: diskValue, detail: disk ? `${formatBytes(disk.total_bytes - disk.free_bytes)} used of ${formatBytes(disk.total_bytes)} · ${formatBytes(disk.available_bytes)} available · volume containing ${disk.project}` : diskSupported ? fs.storageError || "Waiting for a disk observation" : "Disk capacity is unavailable from this Host." },
  ] as const;
  const setMetric = (key: typeof metrics[number]["key"], value: boolean) => void preferences.setPreferences({ [key]: value }).catch(e => session.reportError(message(e)));
  const syncError = persistence.syncError || (!application.draftsSynced && application.getSnapshot().error), syncPending = persistence.unsynced || !application.draftsSynced;
  const sync = syncError ? "Draft sync failed" : syncPending ? "Draft sync pending" : "Drafts synced";
  const dirty = [...documents.items.values()].filter(d => d.dirty);
  const retrySync = () => void persistence.flush().then(() => application.flush()).catch(e => session.reportError(message(e)));
  const elapsed = record?.status === "running" ? Math.max(0, Math.floor((now - record.updated_at_ms) / 1000)) : null;
  const freshText = (time: number) => `Observed ${Math.max(0, Math.floor((now - time) / 1000))}s ago`;
  const runtimeSessions = useRuntimeSessions(), rs = runtimeSessions.getSnapshot();
  const sessions = rs.catalogIds.map(id => rs.instances.get(id)).filter((value): value is WorkspaceInstance => !!value);
  const selectedInstance = rs.selectedId ? rs.instances.get(rs.selectedId) ?? null : null;
  const otherSessions = sessions.filter(instance => instance.workspace_instance_id !== rs.selectedId);
  const protection = selectedInstance?.protection ?? null;
  const sessionWord = (state: WorkspaceInstance["state"]) => state === "ready" ? "Ready" : state === "starting" ? "Starting R" : state === "stopping" ? "Stopping" : state === "recovery_required" ? "Needs attention" : state === "failed" ? "Failed" : "Stopped";
  // Product copy is English regardless of the browser locale.
  const copyTime = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  // Without native change tracking there is no honest count of objects created
  // since a copy, so the summary says only that R has been active since.
  const copySummary = protection === null ? null : protection.latest_checkpoint_id === null ? "No copy yet"
    : `${protection.saved_at_ms === null ? "Saved" : copyTime(protection.saved_at_ms)} · ${protection.saved_objects ?? 0} objects${protection.skipped_objects ? ` · ${protection.skipped_objects} need${protection.skipped_objects === 1 ? "s" : ""} attention` : ""}`;
  const selectSession = (id: string) => { try { runtimeSessions.select(id); } catch (error) { session.reportError(message(error)); } };
  return <footer className="statusbar" aria-label="Workspace status">
    <Menu.Root open={open} onOpenChange={setOpen}><Menu.Trigger className="status-runtime" aria-label="Runtime and status bar options"><i className={`dot${runtimeFresh && ["idle", "busy"].includes(runtime?.state ?? "") ? "" : " offline"}`} /><span>{sessions.length > 1 ? <><span className="status-session">{selectedInstance?.name ?? "Session"}</span>{" · "}</> : <span className="status-local">Local </span>}R{session.r?.current?.version ? ` ${session.r.current.version}` : ""}</span><Icon name="chevron" size={12} /></Menu.Trigger><Menu.Portal><Menu.Content className="menu shell-menu runtime-menu" side="top" align="start" sideOffset={8} collisionPadding={8}>
      <Menu.Label className="shell-menu-heading"><span>{sessions.length > 1 && selectedInstance ? `${selectedInstance.name} · R` : "Local R"} {session.r?.current?.version}</span><span className="muted">{status}</span></Menu.Label>
      <div className="shell-runtime-facts">{metrics.map(metric => <div key={metric.key} title={metric.detail}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}{disk && <><div><span>Used / capacity</span><strong>{formatBytes(disk.total_bytes - disk.free_bytes)} / {formatBytes(disk.total_bytes)}</strong></div><div><span>Available space</span><strong>{formatBytes(disk.available_bytes)}</strong></div></>}</div>
      <div className="shell-observation-note">{runtime ? `${runtimeFresh ? "" : "Last R observation · "}${freshText(runtime.observed_at_ms)}` : "No R observation"}{ss.runtimeError && ` · ${ss.runtimeError}`}<br />{fs.storage ? `${diskFresh ? "Disk · " : "Last disk observation · "}${freshText(fs.storage.observed_at_ms)}` : diskSupported ? fs.storageError || "Disk observation pending" : "Disk capacity unavailable from this Host"}</div>
      {selectedInstance && <><Menu.Separator className="shell-menu-separator" /><Menu.Label className="shell-menu-label">Session</Menu.Label><div className="shell-runtime-facts"><div><span>Target</span><strong>{selectedInstance.name}</strong></div>{copySummary && <div><span>Recovery copy</span><strong>{copySummary}</strong></div>}{protection?.activity_since_copy && <div><span>Since the copy</span><strong>R activity</strong></div>}{rs.stale && <div><span>Session catalog</span><strong>Refreshing…</strong></div>}</div>{rs.errors.get(selectedInstance.workspace_instance_id) && <div className="shell-observation-note">{rs.errors.get(selectedInstance.workspace_instance_id)}</div>}</>}
      {otherSessions.length > 0 && <><Menu.Separator className="shell-menu-separator" /><Menu.Label className="shell-menu-label">Other sessions</Menu.Label>{otherSessions.map(instance => <Menu.Item key={instance.workspace_instance_id} disabled={!session.ready} onSelect={() => selectSession(instance.workspace_instance_id)}><span className="menu-check">{instance.state === "ready" && <i className="dot" />}</span><span className="shell-view-name">{instance.name}</span><small>{sessionWord(instance.state)}</small></Menu.Item>)}<div className="shell-observation-note">Switching affects work submitted afterwards, not work already accepted.</div></>}
      <Menu.Separator className="shell-menu-separator" /><Menu.Label className="shell-menu-label">Keep visible in status bar</Menu.Label>
      {metrics.map(metric => <Menu.CheckboxItem key={metric.key} checked={prefs[metric.key]} onCheckedChange={value => setMetric(metric.key, value)} onSelect={event => event.preventDefault()} title={metric.detail}><span className="menu-check"><Menu.ItemIndicator><Icon name="check" size={14} /></Menu.ItemIndicator></span><span>{metric.label}</span></Menu.CheckboxItem>)}
      <Menu.Separator className="shell-menu-separator" /><Menu.Item disabled={!session.ready} onSelect={showConsole}><Icon name="terminal" />Open Console{queue?.pending.length ? ` · ${queue.pending.length} queued` : ""}</Menu.Item><Menu.Item onSelect={() => navigation.setDialog("settings")}>R settings…</Menu.Item>
    </Menu.Content></Menu.Portal></Menu.Root>
    <div className="status-divider" />
    <div className="status-work">
      <button className={`status-execution${input || !ss.connected || !runtimeFresh ? " is-attention" : status === "Running" ? " is-running" : ""}`} onClick={status === "Not configured" ? () => navigation.setDialog("settings") : showConsole} disabled={!session.ready && status !== "Not configured"} title={cs.error ? `Last queue observation · ${cs.error}` : input ? "Answer R Input" : "Open Console"}><span className="status-full">{status}</span><span className="status-short">{input ? "Input needed" : status}</span>{elapsed !== null && !input && runtimeFresh && <span className="status-elapsed">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>}{input && <span className="status-action">Answer →</span>}</button>
      {queue?.current?.source?.label && status === "Running" && <button className="status-source" onClick={showConsole} title={queue.current.source.label}>{queue.current.source.label}</button>}
      {(!!queue?.pending.length || !!queue?.pause) && <button className={queue.pause ? "status-queue is-attention" : "status-queue"} onClick={showConsole} title={cs.error ? `Last queue observation · ${cs.error}` : "View R queue"}>{queue.pause ? "Queue paused" : ""}{queue.pause && queue.pending.length ? " · " : ""}{queue.pending.length ? `${queue.pending.length} queued` : ""}</button>}
    </div>
    <div className="status-metrics">{metrics.filter(metric => prefs[metric.key]).map(metric => <button key={metric.key} className="status-metric" data-metric={metric.key} title={metric.detail} onClick={() => setOpen(true)}><span>{metric.label}</span><strong>{metric.value}</strong></button>)}</div>
    <Menu.Root><Menu.Trigger className={`status-sync${syncError ? " is-error" : syncPending ? " is-attention" : ""}`} aria-label={sync} title={sync}><Icon name={syncError ? "warning" : syncPending ? "clock" : "check"} size={14} /><span className={!syncError && !syncPending ? "status-sync-success" : ""}>{sync}</span></Menu.Trigger><Menu.Portal><Menu.Content className="menu shell-menu" side="top" align="end" sideOffset={8} collisionPadding={8}><Menu.Label className="shell-menu-heading">{sync}</Menu.Label><div className="shell-observation-note">{syncError || (syncPending ? "Working changes are waiting to synchronize." : "Working state is synchronized with this workspace.")} File saving is separate.</div>{dirty.slice(0, 8).map(d => <Menu.Item key={d.id} onSelect={() => documents.focus(d)}><Icon name="code" size={16} /><span className="shell-view-name">{d.name}</span><small>Unsaved</small></Menu.Item>)}{dirty.length > 8 && <Menu.Label className="shell-menu-label">{dirty.length - 8} more files with unsaved changes</Menu.Label>}{persistence.stateConflict ? <Menu.Item onSelect={() => navigation.setDialog("conflict")}>Resolve window conflict…</Menu.Item> : (syncError || syncPending) && <Menu.Item onSelect={retrySync}>Retry Draft Sync</Menu.Item>}</Menu.Content></Menu.Portal></Menu.Root>
    <button className="status-customize" aria-label="Customize status bar" title="Choose metrics to keep visible" onClick={() => setOpen(true)}><Icon name="settings" size={14} /></button>
  </footer>;
}
