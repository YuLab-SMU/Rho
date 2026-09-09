import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useAgentTasks, useLayout, useNavigation } from "../context";
import { Icon } from "../icons";
import { agentBusy } from "../agent-tasks";
import { encodeAgentFile } from "../agent-task-adapter";
import type { AgentProvider } from "../generated/AgentProvider";
import type { AgentTaskSummary } from "../generated/AgentTaskSummary";
import type { AgentAsset } from "../generated/AgentAsset";
import type { AgentContextSelection } from "../generated/AgentContextSelection";
import type { AgentContextPreview } from "../generated/AgentContextPreview";
import type { AgentTaskEvent } from "../generated/AgentTaskEvent";
import "../agent-panel.css";

const providers: Record<AgentProvider, string> = { codex: "Codex", kimi: "Kimi Code", deepseek: "DeepSeek Harness" };
const statusLabel: Record<string, string> = { draft: "Draft", ready: "Ready", running: "Running", waiting_for_permission: "Needs permission", connecting: "Connecting", resuming: "Resuming", stopping: "Stopping", disconnected: "Disconnected", uncertain: "Needs review", interrupted: "Stopped", failed: "Failed" };
const toolTitle = (text: string) => text.startsWith("mcp__rho__rho_") ? `Rho · ${text.slice(14).replace(/_v\d+(?:_\w+)?$/, "").replaceAll("_", " ")}` : text;
function Down() { return <span className="at-down"><Icon name="chevron" size={12} /></span>; }
function TaskState({ task }: { task: AgentTaskSummary }) {
  const state = task.attachment.state;
  return <span className={`at-state at-state-${state}`}><Icon size={13} name={state === "waiting_for_permission" || state === "uncertain" ? "warning" : agentBusy(state) ? "clock" : state === "ready" ? "check" : "agent"} />{statusLabel[state] ?? state}</span>;
}
function NewTaskButton({ compact = false }: { compact?: boolean }) {
  const owner = useAgentTasks(), state = owner.getSnapshot();
  return <Menu.Root><Menu.Trigger asChild><button className={compact ? "at-icon" : "at-button"} aria-label="New task" disabled={!owner.connected || state.creating}><Icon name="plus" />{!compact && "New task"}</button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu" align="end" sideOffset={5}>
    {(Object.keys(providers) as AgentProvider[]).map(provider => <Menu.Item className="at-menu-item" key={provider} onSelect={() => void owner.newTask(provider)}><Icon name="agent" />{providers[provider]}</Menu.Item>)}
  </Menu.Content></Menu.Portal></Menu.Root>;
}
const TaskRow = memo(function TaskRow({ task, selected, onSelect }: { task: AgentTaskSummary; selected: boolean; onSelect(): void }) {
  return <button className={`at-task${selected ? " selected" : ""}`} onClick={onSelect} aria-current={selected ? "true" : undefined}>
    <span className="at-task-status-icon"><Icon size={14} name={task.attachment.decisions.length ? "warning" : agentBusy(task.attachment.state) ? "clock" : "agent"} /></span>
    <span className="at-task-label"><strong>{task.task.title}</strong><small>{providers[task.task.provider]} · {statusLabel[task.attachment.state] ?? task.attachment.state}</small></span>
    <span className="at-task-trailing">{task.attachment.decisions.length ? <span className="at-count">{task.attachment.decisions.length}</span> : task.has_draft ? <Icon name="file" size={12} /> : null}</span>
  </button>;
});
function TaskList() {
  const owner = useAgentTasks(), state = owner.getSnapshot();
  return <aside className="at-task-list" aria-label="Project tasks">
    <div className="at-list-heading"><strong>Tasks</strong><NewTaskButton /></div>
    <div className="at-filters"><button className={!state.archived ? "selected" : ""} onClick={() => owner.filterArchived(false)}>Active</button><button className={state.archived ? "selected" : ""} onClick={() => owner.filterArchived(true)}>Archived</button></div>
    <div className="at-task-scroll">{state.tasks.map(task => <TaskRow key={task.task.task_id} task={task} selected={task.task.task_id === state.selected} onSelect={() => owner.select(task.task.task_id)} />)}
      {!state.tasks.length && <p className="at-list-empty">{state.archived ? "No archived tasks" : "No tasks yet"}</p>}
      {state.next && <button className="at-load-more" onClick={() => void owner.loadMore()}>Load more tasks</button>}
    </div>
    <div className="at-list-footer">{state.running} running{state.permissions > 0 ? ` · ${state.permissions} need permission` : ""}</div>
  </aside>;
}
function TaskSelector() {
  const owner = useAgentTasks(), state = owner.getSnapshot(), task = state.selected ? owner.summary(state.selected) : null;
  return <div className="at-task-selector"><Menu.Root><Menu.Trigger asChild><button className="at-select-task"><span>{task?.task.title ?? "Choose a task"}</span><Down /></button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu at-task-menu" align="start" sideOffset={5}>
    <div className="at-filters"><button className={!state.archived ? "selected" : ""} onClick={() => owner.filterArchived(false)}>Active</button><button className={state.archived ? "selected" : ""} onClick={() => owner.filterArchived(true)}>Archived</button></div>
    {state.tasks.map(task => <Menu.Item className="at-menu-item" key={task.task.task_id} onSelect={() => owner.select(task.task.task_id)}><span className="at-task-label"><strong>{task.task.title}</strong><small>{providers[task.task.provider]} · {statusLabel[task.attachment.state]}</small></span>{task.attachment.decisions.length > 0 && <span className="at-count">{task.attachment.decisions.length}</span>}</Menu.Item>)}
    {state.next && <Menu.Item className="at-menu-item" onSelect={e => { e.preventDefault(); void owner.loadMore(); }}>Load more tasks</Menu.Item>}
  </Menu.Content></Menu.Portal></Menu.Root><NewTaskButton compact /></div>;
}
function TaskHeader({ task }: { task: AgentTaskSummary }) {
  const owner = useAgentTasks(), navigation = useNavigation(), [renaming, setRenaming] = useState(false), [title, setTitle] = useState(task.task.title), [inspecting, setInspecting] = useState(false);
  const editable = owner.canEdit(task.task.task_id), id = task.task.task_id;
  useEffect(() => { setRenaming(false); setInspecting(false); setTitle(task.task.title); }, [id, task.task.title]);
  return <><header className="at-task-header">
    <div className="at-task-heading">{renaming ? <form onSubmit={e => { e.preventDefault(); void owner.rename(id, title); setRenaming(false); }}><input autoFocus value={title} maxLength={160} onChange={e => setTitle(e.target.value)} aria-label="Task title" onKeyDown={e => { if (e.key === "Escape") setRenaming(false); }} /><button title="Save title"><Icon name="check" /></button></form> : <strong className="at-title">{task.task.title}</strong>}
      <div className="at-task-meta"><span>{providers[task.task.provider]}</span><span>·</span>{editable ? <TaskState task={task} /> : <span><Icon name="lock" size={12} /> Read-only · {task.attachment.control_frozen ? "Needs review" : "Another window"}</span>}{task.task.archived && <span>· Archived</span>}</div>
    </div>
    {!editable && <button className="at-button" disabled={!owner.connected || owner.hasPending(id)} onClick={() => void owner.takeOver(id, agentBusy(task.attachment.state) || task.attachment.control_frozen || task.unconfirmed > 0)}>{agentBusy(task.attachment.state) || task.attachment.control_frozen || task.unconfirmed > 0 ? "Stop Agent and take over" : "Take over"}</button>}
    {editable && ["disconnected", "uncertain"].includes(task.attachment.state) && task.task.native_session_id && <button className="primary" disabled={!owner.connected || owner.hasPending(id)} onClick={() => void owner.act(id, "resume")}>Resume</button>}
    <button className="at-icon" title="Agent Settings" aria-label="Agent Settings" onClick={() => navigation.setDialog("agents")}><Icon name="settings" /></button>
    <Menu.Root><Menu.Trigger asChild><button className="at-icon" aria-label="Task actions"><Icon name="more" /></button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu" align="end" sideOffset={5}>
      <Menu.Item className="at-menu-item" onSelect={() => setInspecting(!inspecting)}>Session details</Menu.Item>
      <Menu.Item className="at-menu-item" disabled={!editable} onSelect={() => setRenaming(true)}>Rename</Menu.Item>
      <Menu.Item className="at-menu-item" disabled={!editable} onSelect={() => void owner.archive(id, !task.task.archived)}>{task.task.archived ? "Unarchive" : "Archive"}</Menu.Item>
      <Menu.Item className="at-menu-item" disabled={!editable || agentBusy(task.attachment.state) || !task.attachment.connection_id} onSelect={() => void owner.act(id, "disconnect")}>Disconnect</Menu.Item>
    </Menu.Content></Menu.Portal></Menu.Root>
  </header>{inspecting && <section className="at-session-details" aria-label="Agent session details"><header><strong>Session details</strong><button className="at-icon" aria-label="Close session details" onClick={() => setInspecting(false)}><Icon name="close" size={13} /></button></header><dl><dt>Native session</dt><dd>{task.task.native_session_id ?? "Created on first send"}</dd><dt>History</dt><dd>{task.attachment.capabilities.history === "native_history" ? "Native history" : task.attachment.capabilities.history === "native_context_history" ? "Native context history · Replay may omit items" : "Rho observation cache"}</dd><dt>Saved observations</dt><dd>{task.history_gap ? "Earlier messages are outside this cache" : "Recent messages cached"}</dd><dt>Previous turns</dt><dd>{task.unconfirmed ? `${task.unconfirmed} need review` : "No unconfirmed submissions"}</dd></dl></section>}</>;
}
function EventInputs({ taskId, event }: { taskId: string; event: AgentTaskEvent }) {
  const owner = useAgentTasks(), state = owner.getSnapshot(), detail = state.details.get(taskId);
  const receipt = event.request_id ? detail?.receipts.find(r => r.request_id === event.request_id) : null;
  if (!receipt || event.role !== "user") return null;
  return <div className="at-event-inputs">{receipt.input_assets.map(id => {
    const asset = detail?.assets.find(a => a.asset_id === id), preview = state.previews.get(`${taskId}:${id}`);
    return asset && <details className="at-sent-asset" key={id} onToggle={e => { if (e.currentTarget.open) void owner.loadAsset(taskId, id); }}><summary><Icon name={asset.mime_type.startsWith("image/") ? "image" : "file"} size={14} />{asset.name}</summary>{preview && (asset.mime_type.startsWith("image/") ? <img alt={asset.name} src={preview.url} /> : <pre>{preview.text}</pre>)}</details>;
  })}{receipt.input_context.map((c, i) => <span className="at-sent-context" key={i}><Icon name="link" size={13} />{c.label}<small>{c.source} · {c.inclusion}</small></span>)}</div>;
}
function EventView({ event, taskId }: { event: AgentTaskEvent; taskId: string }) {
  if (event.kind === "context") return <details className="at-tool at-context-event"><summary><Icon name="link" size={14} />Workspace context</summary><pre>{event.text}</pre></details>;
  if (event.kind === "tool") return <div className={`at-tool at-tool-${event.status ?? "running"}`}><Icon name={event.status === "completed" ? "check" : event.status === "failed" ? "warning" : "clock"} size={14} /><span>{toolTitle(event.text)}</span><small>{event.status}</small></div>;
  return <div className={`at-message at-message-${event.role}`}><small>{event.role === "user" ? "You" : "Agent"}</small><div className="at-message-text">{event.text}</div>{event.status === "truncated" && <small>Message excerpt</small>}<EventInputs taskId={taskId} event={event} /></div>;
}
function Conversation({ task }: { task: AgentTaskSummary }) {
  const owner = useAgentTasks(), state = owner.getSnapshot(), id = task.task.task_id, events = state.events.get(id) ?? [], scroll = useRef<HTMLDivElement>(null), restoring = useRef(false);
  useLayoutEffect(() => { const element = scroll.current; if (!element) return; restoring.current = true; const position = owner.position(id); element.scrollTop = position.following ? element.scrollHeight : position.scrollTop; restoring.current = false; }, [id]);
  useLayoutEffect(() => { const element = scroll.current; if (element && owner.position(id).following) { restoring.current = true; element.scrollTop = element.scrollHeight; restoring.current = false; } }, [events]);
  return <div className="at-conversation" ref={scroll} aria-label="Agent conversation" onScroll={() => { const e = scroll.current; if (e && !restoring.current) owner.setPosition(id, { scrollTop: e.scrollTop, following: e.scrollHeight - e.scrollTop - e.clientHeight < 48 }); }}>
    {(state.earlier.get(id) || state.historyGap.get(id) || task.history_gap) && <div className="at-history-note">{state.earlier.get(id) || owner.canReadNativeHistory(id) ? <button onClick={() => void owner.olderHistory(id)}>{state.earlier.get(id) ? "Load earlier messages" : "Read native history"}<Down /></button> : "Earlier messages unavailable in this cache"}</div>}
    {events.some(e => e.source === "native_history") && <div className="at-history-source">{task.task.provider === "kimi" ? "Native context history" : "Native history"}</div>}
    {events.map(event => <EventView key={event.event_id} event={event} taskId={id} />)}
    {!events.length && <div className="at-empty-conversation">{agentBusy(task.attachment.state) ? <><Icon name="clock" />{statusLabel[task.attachment.state]}…</> : "What would you like to work on?"}</div>}
  </div>;
}
function AssetCard({ taskId, asset, removable, onPreview }: { taskId: string; asset: AgentAsset; removable: boolean; onPreview(): void }) {
  const owner = useAgentTasks(), preview = owner.getSnapshot().previews.get(`${taskId}:${asset.asset_id}`);
  useEffect(() => { if (asset.mime_type.startsWith("image/")) void owner.loadAsset(taskId, asset.asset_id); }, [taskId, asset.asset_id]);
  return <div className="at-asset"><button className="at-asset-main" onClick={onPreview}>{asset.mime_type.startsWith("image/") ? preview ? <img src={preview.url} alt={asset.name} /> : <Icon name="image" size={24} /> : <Icon name="file" size={24} />}<span><strong>{asset.name}</strong><small>{Math.max(1, Math.ceil(asset.bytes / 1024))} KB</small></span></button>{removable && <button className="at-icon" aria-label={`Remove ${asset.name}`} onClick={() => owner.removeAsset(taskId, asset.asset_id)}><Icon name="close" size={12} /></button>}</div>;
}
function ContextPreview({ preview, onChange, onAdd, onClose }: { preview: AgentContextPreview; onChange(selection: AgentContextSelection): void; onAdd(): void; onClose(): void }) {
  const ref = preview.selection.reference;
  const object = ref && typeof ref === "object" && !Array.isArray(ref) ? ref : {};
  return <div className="at-context-preview"><header><span><strong>{preview.title}</strong><small>{preview.description}</small></span><button className="at-icon" aria-label="Close context preview" onClick={onClose}><Icon name="close" /></button></header>
    <div className="at-preview-body">{preview.image_base64 && <img alt={preview.title} src={`data:${preview.image_mime_type};base64,${preview.image_base64}`} />}
      {preview.columns.length > 0 ? <div className="at-table-scroll"><table><thead><tr>{preview.columns.map((name, i) => <th key={i}>{name}</th>)}</tr></thead><tbody>{preview.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div> : preview.text && <pre>{preview.text}</pre>}
      {preview.truncated && <small className="at-muted">Bounded preview; additional content is omitted.</small>}
    </div>
    <footer><label>Include <select aria-label="Context inclusion scope" value={preview.selection.inclusion} onChange={e => onChange({ ...preview.selection, inclusion: e.target.value })}>{preview.inclusions.map(scope => <option key={scope} value={scope}>{scope[0].toUpperCase() + scope.slice(1)}</option>)}</select></label>
      {preview.selection.inclusion === "selection" && (preview.selection.source === "objects" || preview.selection.source === "tables") && <label>Rows <input aria-label="First context row" type="number" min={1} defaultValue={Number(object.start ?? 1)} onBlur={e => onChange({ ...preview.selection, reference: { ...object, start: Math.max(1, Number(e.target.value)) } })} /><input aria-label="Context row count" type="number" min={1} max={20} defaultValue={Number(object.limit ?? 20)} onBlur={e => onChange({ ...preview.selection, reference: { ...object, limit: Math.min(20, Math.max(1, Number(e.target.value))) } })} /></label>}
      <button className="primary" onClick={onAdd}>Add context</button></footer>
  </div>;
}
function Composer({ task }: { task: AgentTaskSummary }) {
  const owner = useAgentTasks(), state = owner.getSnapshot(), id = task.task.task_id, detail = state.details.get(id), local = state.drafts.get(id);
  const content = local?.content ?? detail?.draft.content ?? { text: "", assets: [], context: [] };
  const editable = owner.canEdit(id) && !!detail, busy = agentBusy(task.attachment.state), input = useRef<HTMLTextAreaElement>(null), files = useRef<HTMLInputElement>(null), region = useRef<HTMLDivElement>(null), popover = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<"context" | "preview" | "asset" | null>(null), [search, setSearch] = useState(""), [source, setSource] = useState<string | null>(null), [assetId, setAssetId] = useState<string | null>(null), [localError, setLocalError] = useState(""), [decisionIndex, setDecisionIndex] = useState(0);
  const catalog = state.catalogs[task.task.provider];
  const models = catalog?.models ?? task.attachment.capabilities.models;
  const model = models.find(m => m.id === task.task.model);
  const modes = task.attachment.capabilities.modes, currentMode = task.attachment.capabilities.current_mode ?? task.task.mode;
  const mode = modes.find(m => m.id === currentMode), decisions = task.attachment.decisions, decision = decisions[Math.min(decisionIndex, Math.max(0, decisions.length - 1))];
  const pendingSend = state.pending.some(p => p.taskId === id && p.kind === "send");
  const canSend = editable && owner.connected && !busy && !pendingSend && !local?.conflict && !["disconnected", "uncertain"].includes(task.attachment.state) && (!!content.text.trim() || !!content.assets.length || !!content.context.length);
  useEffect(() => { setMenu(null); setSearch(""); setAssetId(null); setLocalError(""); setDecisionIndex(0); }, [id]);
  useEffect(() => { if (menu !== "context") return; owner.clearContext(true); const timer = setTimeout(() => { void owner.searchContext(source, search); }, 160); return () => clearTimeout(timer); }, [menu, search, source]);
  useEffect(() => { if (!menu) return; const listener = (event: PointerEvent) => { if (!region.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setMenu(null); }; document.addEventListener("pointerdown", listener); return () => document.removeEventListener("pointerdown", listener); }, [menu]);
  useLayoutEffect(() => { const e = input.current; if (e) { e.style.height = "0px"; e.style.height = `${Math.min(180, Math.max(54, e.scrollHeight))}px`; } }, [content.text, id]);
  async function attach(list: FileList | null) { if (!list || !editable) return; for (const file of Array.from(list).slice(0, 20)) { try { await owner.upload(id, file.name, file.type || "application/octet-stream", await encodeAgentFile(file)); } catch (e) { setLocalError(e instanceof Error ? e.message : String(e)); } } }
  function contextMenu(value: string | null = null) { setSource(value); setSearch(""); setMenu("context"); }
  async function preview(selection: AgentContextSelection) { setMenu("preview"); await owner.previewContext(selection); }
  const selectedAsset = detail?.assets.find(a => a.asset_id === assetId), assetPreview = assetId ? state.previews.get(`${id}:${assetId}`) : null;
  return <div className="at-composer-region" ref={region}>
    {task.unconfirmed > 0 && <details className="at-review"><summary><Icon name="warning" size={14} />Previous turn needs review</summary>{detail?.receipts.filter(r => ["uncertain", "interrupted"].includes(r.status)).map(r => <div key={r.request_id}><strong>{r.status}</strong><p>{r.error}</p>{r.submitted_draft && <><pre>{r.submitted_draft.text}</pre><button className="at-button" disabled={!editable} onClick={() => owner.restoreSubmitted(id, r.submitted_draft!)}>Use retained draft</button></>}</div>)}</details>}
    {decision && <section className="at-permission" aria-label="Pending Agent permission"><div className="at-permission-title"><strong>{toolTitle(decision.title)}</strong>{decisions.length > 1 && <select aria-label="Pending permission" value={Math.min(decisionIndex, decisions.length - 1)} onChange={e => setDecisionIndex(Number(e.target.value))}>{decisions.map((d, i) => <option key={d.id} value={i}>{i + 1} of {decisions.length}</option>)}</select>}</div>
      {decision.details && <pre>{decision.details}</pre>}<div className="at-permission-options">{decision.options.map(option => <button key={option.id} className="at-button" disabled={!editable || !owner.connected || owner.hasPending(id, "decision")} onClick={() => void owner.reply(id, task.attachment.generation, decision.id, option.id)}>{option.label}</button>)}</div>
    </section>}
    {local?.conflict && <details className="at-conflict"><summary><Icon name="warning" size={14} />Local draft copy kept</summary><pre>{local.conflict.text}</pre><div><button className="at-button" disabled={!editable} onClick={() => owner.useLocalCopy(id)}>Use local copy</button><button className="at-button" onClick={() => owner.useSavedDraft(id)}>View saved draft</button></div></details>}
    <div className={`at-composer${editable ? "" : " readonly"}`} onDragOver={e => { if (editable && owner.connected && e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (owner.connected) void attach(e.dataTransfer.files); }}>
      {!!content.context.length && <div className="at-context-chips">{content.context.map((selection, i) => <span className="at-context-chip" key={`${selection.source}:${i}`}><button onClick={() => void preview(selection)}><Icon name={selection.source === "objects" ? "object" : selection.source === "plots" ? "plot" : selection.source === "tables" ? "table" : selection.source.startsWith("plugin.") ? "components" : "file"} size={14} /><strong>{selection.label}</strong><small>{selection.source.startsWith("plugin.") ? "Plugin" : selection.source}</small></button>{editable && <button className="at-chip-remove" aria-label={`Remove ${selection.label}`} onClick={() => owner.removeContext(id, i)}><Icon name="close" size={12} /></button>}</span>)}</div>}
      {!!content.assets.length && <div className="at-assets">{content.assets.map(asset => { const record = detail?.assets.find(a => a.asset_id === asset); return record ? <AssetCard key={asset} asset={record} taskId={id} removable={editable} onPreview={() => { setAssetId(asset); setMenu("asset"); void owner.loadAsset(id, asset); }} /> : <span key={asset}>Attachment pending…</span>; })}</div>}
      {!editable && <div className="at-readonly-caption"><Icon name="lock" size={13} />Saved draft · Read-only</div>}
      <textarea ref={input} aria-label="Agent message" placeholder={`Message ${providers[task.task.provider]}…`} value={content.text} readOnly={!editable} maxLength={32768} rows={3}
        onChange={e => { owner.editText(id, e.target.value); if (e.target.value.endsWith("@")) contextMenu(); }}
        onKeyDown={e => { if (e.key === "Escape") { setMenu(null); owner.clearContext(); } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && canSend && !menu) { e.preventDefault(); void owner.send(id); } }}
        onPaste={e => { if (e.clipboardData.files.length && editable && owner.connected) { e.preventDefault(); void attach(e.clipboardData.files); } }} />
      <div className="at-composer-tools"><div className="at-input-tools">
        <Menu.Root><Menu.Trigger asChild><button className="at-icon" aria-label="Add context" title="Add context" disabled={!editable || !owner.connected}><Icon name="plus" /></button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu" side="top" align="start" sideOffset={6}>
          <Menu.Item className="at-menu-item" onSelect={() => files.current?.click()}><Icon name="attach" />Images &amp; files…</Menu.Item><Menu.Item className="at-menu-item" onSelect={() => contextMenu()}><Icon name="object" />Workspace</Menu.Item><Menu.Item className="at-menu-item" onSelect={() => contextMenu("plugins")}><Icon name="components" />Plugins</Menu.Item><Menu.Item className="at-menu-item" onSelect={() => contextMenu("editor")}><Icon name="code" />Editor selection</Menu.Item>
        </Menu.Content></Menu.Portal></Menu.Root>
        <button className="at-icon" title="Attach images or files" aria-label="Attach images or files" disabled={!editable || !owner.connected} onClick={() => files.current?.click()}><Icon name="attach" /></button>
        <button className="at-icon at-mention" title="Mention workspace information" aria-label="Mention workspace information" disabled={!editable || !owner.connected} onClick={() => contextMenu()}>@</button>
        <Menu.Root><Menu.Trigger asChild><button className="at-mode" aria-label="Permission mode" title={mode?.description ?? "Modes are supplied by the native Agent"} disabled={!editable || !owner.connected || !modes.length}><Icon name="shield" size={14} /><span>{mode?.name ?? "Permissions"}</span>{modes.length > 0 && <Down />}</button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu at-mode-menu" side="top" align="start" sideOffset={6}>
          {modes.map(m => <Menu.Item className="at-menu-item" key={m.id} onSelect={() => void owner.configure(id, task.task.model, task.task.effort, m.id)}><span className="at-task-label"><strong>{m.name}</strong>{m.description && <small>{m.description}</small>}</span>{m.id === currentMode && <Icon name="check" size={14} />}</Menu.Item>)}
        </Menu.Content></Menu.Portal></Menu.Root>
      </div><div className="at-model-tools"><select aria-label="Task model" value={task.task.model} title={model?.name ?? task.task.model} disabled={!editable || !owner.connected} onChange={e => void owner.configure(id, e.target.value, null, task.task.mode)}>{!models.some(m => m.id === task.task.model) && <option value={task.task.model}>{task.task.model}</option>}{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        {(model?.efforts.length ?? 0) > 0 && <select aria-label="Reasoning effort" value={task.task.effort ?? ""} disabled={!editable || !owner.connected} onChange={e => void owner.configure(id, task.task.model, e.target.value || null, task.task.mode)}><option value="">Default</option>{model!.efforts.map(e => <option key={e} value={e}>{e}</option>)}</select>}
        {busy ? <button className="at-send" title="Stop Agent" aria-label="Stop Agent" disabled={!editable || !owner.connected || owner.hasPending(id, "stop")} onClick={() => void owner.act(id, "stop")}><Icon name="stop" size={14} /><span>Stop</span></button> : <button className="at-send primary" title="Send (Enter)" aria-label="Send message" disabled={!canSend} onClick={() => void owner.send(id)}><Icon name="send" size={15} /></button>}
      </div></div>
    </div>
    <input ref={files} type="file" multiple hidden onChange={e => { void attach(e.target.files); e.target.value = ""; }} />
    <div className="at-draft-status">{!editable ? "Read-only" : local?.dirty ? owner.connected ? "Saving draft…" : "Local draft · Offline" : "Draft saved"}</div>
    {localError && <div className="at-error" role="alert">{localError}<button className="at-icon" aria-label="Dismiss attachment error" onClick={() => setLocalError("")}><Icon name="close" size={12} /></button></div>}
    {menu && region.current?.closest(".agent-panel") && createPortal(<div ref={popover} className="at-context-popover" role="dialog" aria-label={menu === "context" ? "Add workspace context" : "Preview context"}>
      {menu === "context" && <><div className="at-context-search"><Icon name="search" /><input autoFocus aria-label="Find workspace information" placeholder="Find information in this project" value={search} onChange={e => setSearch(e.target.value)} /><button className="at-icon" aria-label="Close context picker" onClick={() => setMenu(null)}><Icon name="close" size={13} /></button></div><div className="at-source-filters"><button className={source === null ? "selected" : ""} onClick={() => setSource(null)}>All</button>{state.sources.filter(s => !s.plugin).map(s => <button className={source === s.id ? "selected" : ""} key={s.id} onClick={() => setSource(s.id)}>{s.name}</button>)}<button className={source === "plugins" ? "selected" : ""} onClick={() => setSource("plugins")}>Plugins</button></div><div className="at-context-results">{state.contextLoading && <p className="at-muted">Reading available information…</p>}{state.contextItems.map((item, i) => <button key={i} className="at-context-result" onClick={() => void preview(item.selection)}><Icon name={item.kind === "figure" ? "plot" : item.kind === "table" ? "table" : item.kind === "object" ? "object" : "file"} /><span><strong>{item.title}</strong><small>{item.description}</small></span><small>{item.kind}</small></button>)}{!state.contextLoading && !state.contextItems.length && <p className="at-muted">{source === "plugins" ? "No plugin information sources are registered." : "No matching information"}</p>}</div></>}
      {menu === "preview" && state.contextPreview && <ContextPreview preview={state.contextPreview} onChange={s => void owner.previewContext(s)} onClose={() => setMenu(null)} onAdd={() => { owner.addContext(id, state.contextPreview!.selection); if (content.text.endsWith("@")) owner.editText(id, content.text.slice(0, -1)); setMenu(null); }} />}
      {menu === "preview" && state.contextLoading && <p className="at-muted">Loading preview…</p>}
      {menu === "asset" && <div className="at-context-preview"><header><strong>{selectedAsset?.name}</strong><button className="at-icon" aria-label="Close attachment preview" onClick={() => setMenu(null)}><Icon name="close" /></button></header><div className="at-preview-body">{assetPreview ? selectedAsset?.mime_type.startsWith("image/") ? <img alt={selectedAsset.name} src={assetPreview.url} /> : <pre>{assetPreview.text}</pre> : "Loading attachment…"}</div></div>}
      {state.contextNotices.length > 0 && (menu === "preview" ? <div className="at-context-notices" role="alert">{state.contextNotices.map((notice, i) => <p key={i}>{notice}</p>)}</div> : <details className="at-context-notices"><summary>Some sources are unavailable</summary>{state.contextNotices.map((notice, i) => <p key={i}>{notice}</p>)}</details>)}
    </div>, region.current.closest(".agent-panel")!)}
  </div>;
}
export function AgentPanel({ viewId }: { viewId: string }) {
  const owner = useAgentTasks(), navigation = useNavigation(), state = owner.getSnapshot(), task = state.selected ? owner.summary(state.selected) : null;
  useEffect(() => { owner.show(viewId); return () => owner.hide(viewId); }, [owner, viewId]);
  return <div className="agent-panel" aria-label="Agent panel"><TaskList /><main className="at-main"><TaskSelector />
    {state.error && <div className="at-error" role="alert"><span>{state.error}</span><button className="at-icon" aria-label="Dismiss Agent error" onClick={() => owner.clearError()}><Icon name="close" size={13} /></button></div>}
    {task ? <><TaskHeader task={task} /><Conversation task={task} /><Composer task={task} /></> : <div className="at-start"><Icon name="agent" size={28} /><h2>Work with an Agent</h2><NewTaskButton /><button onClick={() => navigation.setDialog("agents")}><Icon name="settings" />Agent Settings</button></div>}
  </main></div>;
}
export function AgentLauncher() {
  const owner = useAgentTasks(), state = owner.getSnapshot(), layout = useLayout();
  const pending = state.attention;
  return <div className="at-launcher"><button className="bordered" onClick={() => layout.show("agent")}><Icon name="agent" />Agents</button>{state.permissions > 0 && <Menu.Root><Menu.Trigger asChild><button className="at-launcher-badge" aria-label={`${state.permissions} Agent permissions pending`}>{state.permissions}</button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu" align="end" sideOffset={6}>{pending.map(t => <Menu.Item className="at-menu-item" key={t.task.task_id} onSelect={() => { owner.select(t.task.task_id); layout.show("agent"); }}><Icon name="warning" /><span>{t.task.title}</span></Menu.Item>)}{!pending.length && <Menu.Item className="at-menu-item" onSelect={() => layout.show("agent")}>Open pending task</Menu.Item>}</Menu.Content></Menu.Portal></Menu.Root>}</div>;
}
