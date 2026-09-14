import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useAgentTasks, useComponentAgents, useNavigation } from "../context";
import { Icon } from "../icons";
import { AgentComposer } from "./agent-composer";
import { RhoConversation } from "./component-agent-panel";
import { agentBusy, projectTaskKey } from "../agent-tasks";
import type { ProjectAgentTaskSummary } from "../generated/ProjectAgentTaskSummary";
import { encodeAgentFile } from "../agent-task-adapter";
import type { AgentProvider } from "../generated/AgentProvider";
import type { AgentTaskSummary } from "../generated/AgentTaskSummary";
import type { AgentAsset } from "../generated/AgentAsset";
import type { AgentContextSelection } from "../generated/AgentContextSelection";
import type { AgentContextPreview } from "../generated/AgentContextPreview";
import type { AgentTaskEvent } from "../generated/AgentTaskEvent";
import "../agent-panel.css";
import { AgentActivity } from "./agent-activity";
import { AgentAttachment } from "./agent-attachment";
import { NativeScientificWork } from "./agent-scientific-work";
import { AgentUsage } from "./agent-usage";

const providers: Record<AgentProvider, string> = { codex: "Codex", kimi: "Kimi Code", deepseek: "DeepSeek Harness" };
const statusLabel: Record<string, string> = { queued: "Queued", waiting_for_r: "Waiting for R", needs_input: "Needs input", stopped: "Stopped", completed: "Ready", draft: "Draft", ready: "Ready", running: "Running", waiting_for_permission: "Needs permission", connecting: "Connecting", resuming: "Resuming", stopping: "Stopping", disconnected: "Disconnected", uncertain: "Needs review", interrupted: "Stopped", failed: "Failed" };
const rhoToolTitles: Record<string, string> = { workspace_run_r: "Submit R code", workspace_packages: "Inspect R packages", workspace_console_state: "Check R queue", workspace_resume_queue: "Continue queued R runs", workspace_list_outputs: "Find run outputs", output_view: "Inspect figure", application_context: "Read workspace context", application_windows: "Find workspace window", application_control: "Update workspace", application_command_status: "Check workspace action", operation_get: "Check run result", operation_list_recent: "Find original run" };
const toolStatusLabels: Record<string, string> = { in_progress: "Running", running: "Running", pending: "Pending", completed: "Done", failed: "Failed" };
const toolTitle = (text: string) => { if (!text.startsWith("mcp__rho__rho_")) return text; const key = text.slice(14).replace(/_v\d+(?:_\w+)?$/, ""); return rhoToolTitles[key] ?? `Rho · ${key.replaceAll("_", " ")}`; };
function Down() { return <span className="at-down"><Icon name="chevron" size={12} /></span>; }
function TaskState({ task }: { task: AgentTaskSummary }) {
  const state = task.attachment.state;
  return <span className={`at-state at-state-${state}`}><Icon size={13} name={state === "waiting_for_permission" || state === "uncertain" ? "warning" : agentBusy(state) ? "clock" : state === "ready" ? "check" : "agent"} />{statusLabel[state] ?? state}</span>;
}
function NewTaskButton({ compact = false }: { compact?: boolean }) {
  const owner = useAgentTasks(), rho = useComponentAgents(), state = owner.getSnapshot();
  async function createRho() { const before=owner.getSnapshot().selectedTask; try { const id = await rho.newTask(); if (id) { owner.rememberAgent("rho"); if (JSON.stringify(owner.getSnapshot().selectedTask)===JSON.stringify(before)) owner.chooseTask({ kind: "rho", conversation_id: id }); await owner.observeProjectTasks(); } } catch (error) { rho.reportError(error); } }
  return <Menu.Root><Menu.Trigger asChild><button className={compact ? "at-icon" : "at-button"} aria-label="New task" disabled={!owner.connected || state.creating}><Icon name="plus" />{!compact && "New task"}</button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu" align="end" sideOffset={5}>
    <Menu.Item className="at-menu-item" onSelect={() => void createRho()}><Icon name="agent" />Rho</Menu.Item>
    {(Object.keys(providers) as AgentProvider[]).map(provider => <Menu.Item className="at-menu-item" key={provider} onSelect={() => void owner.newTask(provider)}><Icon name="agent" />{providers[provider]}</Menu.Item>)}
  </Menu.Content></Menu.Portal></Menu.Root>;
}
const label = (task: ProjectAgentTaskSummary) => task.provider ? providers[task.provider] : "Rho";
const TaskRow = memo(function TaskRow({ task, selected, onSelect }: { task: ProjectAgentTaskSummary; selected: boolean; onSelect(): void }) {
  return <button className={`at-task${selected ? " selected" : ""}`} onClick={onSelect} aria-current={selected ? "true" : undefined}>
    <span className="at-task-status-icon"><Icon size={14} name={task.attention_reason || task.permissions ? "warning" : agentBusy(task.state) ? "clock" : "agent"} /></span>
    <span className="at-task-label"><strong>{task.title}</strong><small title={task.attention_reason?.replaceAll("_"," ")}>{label(task)} · {task.attention_reason && task.attention_reason !== "permission" ? "Needs review" : statusLabel[task.state] ?? task.state}{task.history_gap && " · Partial history"}</small></span>
    <span className="at-task-trailing">{task.permissions ? <span className="at-count">{task.permissions}</span> : task.has_draft ? <Icon name="file" size={12} /> : null}</span>
  </button>;
});
function TaskList() {
  const owner = useAgentTasks(), state = owner.getSnapshot(), selected = state.selectedTask && projectTaskKey(state.selectedTask);
  return <aside className="at-task-list" aria-label="Project tasks">
    <div className="at-list-heading"><strong>Tasks</strong><NewTaskButton /></div>
    <div className="at-filters"><button className={!state.archived ? "selected" : ""} onClick={() => owner.filterArchived(false)}>Active</button><button className={state.archived ? "selected" : ""} onClick={() => owner.filterArchived(true)}>Archived</button></div>
    <div className="at-task-scroll">{state.projectTasks.map(task => <TaskRow key={projectTaskKey(task.reference)} task={task} selected={projectTaskKey(task.reference) === selected} onSelect={() => owner.chooseTask(task.reference)} />)}
      {!state.projectTasks.length && <p className="at-list-empty">{state.archived ? "No archived tasks" : "No tasks yet"}</p>}
      {state.next && <button className="at-load-more" onClick={() => void owner.loadMore()}>Load more tasks</button>}
    </div><div className="at-list-footer">{state.running} running{state.attentionCount > 0 ? ` · ${state.attentionCount} need attention` : ""}</div>
  </aside>;
}
function TaskSelector() {
  const owner = useAgentTasks(), rho = useComponentAgents(), state = owner.getSnapshot(), ref = state.selectedTask;
  const task = ref && state.projectTasks.find(t => projectTaskKey(t.reference) === projectTaskKey(ref));
  const title = task?.title ?? (ref?.kind === "rho" ? rho.getSnapshot().conversations.get(ref.conversation_id)?.title : ref?.kind === "native" ? owner.summary(ref.task_id)?.task.title : null);
  return <div className="at-task-selector"><Menu.Root><Menu.Trigger asChild><button className="at-select-task" aria-label={`Select task: ${title ?? "No task selected"}`}><span>{title ?? "Choose a task"}</span><Down /></button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu at-task-menu" align="start" sideOffset={5}>
    <div className="at-filters"><button className={!state.archived ? "selected" : ""} onClick={() => owner.filterArchived(false)}>Active</button><button className={state.archived ? "selected" : ""} onClick={() => owner.filterArchived(true)}>Archived</button></div>
    {state.projectTasks.map(task => <Menu.Item className="at-menu-item" key={projectTaskKey(task.reference)} onSelect={() => owner.chooseTask(task.reference)}><span className="at-task-label"><strong>{task.title}</strong><small title={task.attention_reason?.replaceAll("_"," ")}>{label(task)} · {task.attention_reason && task.attention_reason !== "permission" ? "Needs review" : statusLabel[task.state] ?? task.state}{task.history_gap && " · Partial history"}</small></span>{task.permissions > 0 && <span className="at-count">{task.permissions}</span>}</Menu.Item>)}
    {state.next && <Menu.Item className="at-menu-item" onSelect={e => { e.preventDefault(); void owner.loadMore(); }}>Load more tasks</Menu.Item>}
  </Menu.Content></Menu.Portal></Menu.Root><NewTaskButton compact /></div>;
}
function TaskHeader({ task }: { task: AgentTaskSummary }) {
  const owner = useAgentTasks(), navigation = useNavigation(), [renaming, setRenaming] = useState(false), [title, setTitle] = useState(task.task.title), [inspecting, setInspecting] = useState(false);
  const editable = owner.canControl(task.task.task_id), id = task.task.task_id;
  useEffect(() => { setRenaming(false); setInspecting(false); setTitle(task.task.title); }, [id, task.task.title]);
  return <><header className="at-task-header">
    <div className="at-task-heading">{renaming ? <form onSubmit={e => { e.preventDefault(); void owner.rename(id, title); setRenaming(false); }}><input autoFocus value={title} maxLength={160} onChange={e => setTitle(e.target.value)} aria-label="Task title" onKeyDown={e => { if (e.key === "Escape") setRenaming(false); }} /><button title="Save title"><Icon name="check" /></button></form> : <strong className="at-title">{task.task.title}</strong>}
      <div className="at-task-meta"><span>{providers[task.task.provider]}</span><span>·</span>{editable ? <TaskState task={task} /> : <span><Icon name="lock" size={12} /> Read-only · {task.attachment.control_frozen ? "Needs review" : "Another window"}</span>}{task.task.archived && <span>· Archived</span>}</div>
    </div>
    {!editable && <button className="at-button" disabled={!owner.connected || owner.hasPending(id)} onClick={() => void owner.takeOver(id, agentBusy(task.attachment.state) || task.attachment.control_frozen || task.unconfirmed > 0)}>{agentBusy(task.attachment.state) || task.attachment.control_frozen || task.unconfirmed > 0 ? "Stop Agent and take over" : "Take over"}</button>}
    {editable && !task.task.archived && ["disconnected", "uncertain"].includes(task.attachment.state) && task.task.native_session_id && <button className="primary" disabled={!owner.connected || owner.hasPending(id)} onClick={() => void owner.act(id, "resume")}>Resume</button>}
    <button className="at-icon" title="Agent Settings" aria-label="Agent Settings" onClick={() => navigation.openAgentSettings(task.task.provider)}><Icon name="settings" /></button>
    <Menu.Root><Menu.Trigger asChild><button className="at-icon" aria-label="Task actions"><Icon name="more" /></button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu" align="end" sideOffset={5}>
      <Menu.Item className="at-menu-item" onSelect={() => setInspecting(!inspecting)}>Session details</Menu.Item>
      <Menu.Item className="at-menu-item" disabled={!editable} onSelect={() => setRenaming(true)}>Rename</Menu.Item>
      <Menu.Item className="at-menu-item" disabled={!editable} onSelect={() => void owner.archive(id, !task.task.archived)}>{task.task.archived ? "Unarchive" : "Archive"}</Menu.Item>
      <Menu.Item className="at-menu-item" disabled={!editable || agentBusy(task.attachment.state) || !task.attachment.connection_id} onSelect={() => void owner.act(id, "disconnect")}>Disconnect</Menu.Item>
    </Menu.Content></Menu.Portal></Menu.Root>
  </header>{inspecting && <section className="at-session-details" aria-label="Agent session details"><header><strong>Session details</strong><button className="at-icon" aria-label="Close session details" onClick={() => setInspecting(false)}><Icon name="close" size={13} /></button></header><dl><dt>Native session</dt><dd>{task.task.native_session_id ?? "Created on first send"}</dd><dt>History</dt><dd>{task.attachment.capabilities.history === "native_history" ? "Native history" : task.attachment.capabilities.history === "native_context_history" ? "Native context history · Replay may omit items" : "Rho observation cache"}</dd><dt>Saved observations</dt><dd>{task.history_gap ? "Earlier messages are outside this cache" : "Recent messages cached"}</dd><dt>Previous turns</dt><dd>{task.unconfirmed ? `${task.unconfirmed} need review` : "No unconfirmed submissions"}</dd></dl><AgentUsage events={owner.getSnapshot().events.get(id) ?? []} /></section>}</>;
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
  if (event.kind === "tool") return <div className={`at-tool at-tool-${event.status ?? "running"}`}><Icon name={event.status === "completed" ? "check" : event.status === "failed" ? "warning" : "clock"} size={14} /><span>{toolTitle(event.text)}</span><small>{toolStatusLabels[event.status ?? ""] ?? event.status}</small></div>;
  return <div className={`at-message at-message-${event.role}`}><small>{event.role === "user" ? "You" : "Agent"}</small><div className="at-message-text">{event.text}</div>{event.status === "truncated" && <small>Message excerpt</small>}<EventInputs taskId={taskId} event={event} /></div>;
}
function Conversation({ task }: { task: AgentTaskSummary }) {
  const owner = useAgentTasks(), state = owner.getSnapshot(), id = task.task.task_id, events = state.events.get(id) ?? [], scroll = useRef<HTMLDivElement>(null), restoring = useRef(false);
  useLayoutEffect(() => { const element = scroll.current; if (!element) return; restoring.current = true; const position = owner.position(id); element.scrollTop = position.following ? element.scrollHeight : position.scrollTop; restoring.current = false; }, [id]);
  useLayoutEffect(() => { const element = scroll.current; if (element && owner.position(id).following) { restoring.current = true; element.scrollTop = element.scrollHeight; restoring.current = false; } }, [events]);
  return <div className="at-conversation" ref={scroll} aria-label="Agent conversation" onScroll={() => { const e = scroll.current; if (e && !restoring.current) owner.setPosition(id, { scrollTop: e.scrollTop, following: e.scrollHeight - e.scrollTop - e.clientHeight < 48 }); }}>
    {(state.earlier.get(id) || state.historyGap.get(id) || task.history_gap) && <div className="at-history-note">{state.earlier.get(id) || owner.canReadNativeHistory(id) ? <button onClick={() => void owner.olderHistory(id)}>{state.earlier.get(id) ? "Load earlier messages" : "Read native history"}<Down /></button> : "Earlier messages unavailable in this cache"}</div>}
    {events.some(e => e.source === "native_history") && <div className="at-history-source">{task.task.provider === "kimi" ? "Native context history" : "Native history"}</div>}
    {events.filter(event => event.kind !== "activity" && event.kind !== "usage").map(event => <EventView key={event.event_id} event={event} taskId={id} />)}
    <AgentActivity task={task} events={events} now={state.observedAt} pending={state.pending.some(p => p.taskId === id && p.kind === "send")} />
    {!events.length && !agentBusy(task.attachment.state) && !state.pending.some(p => p.taskId === id && p.kind === "send") && <div className="at-empty-conversation">What would you like to work on?</div>}
  </div>;
}
function AssetCard({ taskId, asset, removable, onPreview }: { taskId: string; asset: AgentAsset; removable: boolean; onPreview(): void }) {
  const owner = useAgentTasks(), preview = owner.getSnapshot().previews.get(`${taskId}:${asset.asset_id}`);
  useEffect(() => { if (asset.mime_type.startsWith("image/")) void owner.loadAsset(taskId, asset.asset_id); }, [taskId, asset.asset_id]);
  return <AgentAttachment asset={asset} preview={preview} onPreview={onPreview} onRemove={removable ? () => owner.removeAsset(taskId, asset.asset_id) : undefined} />;
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
  const controlled = owner.canControl(id), editable = owner.canEdit(id) && !!detail, busy = agentBusy(task.attachment.state), files = useRef<HTMLInputElement>(null), region = useRef<HTMLDivElement>(null), popover = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<"context" | "preview" | "asset" | null>(null), [search, setSearch] = useState(""), [source, setSource] = useState<string | null>(null), [assetId, setAssetId] = useState<string | null>(null), [localError, setLocalError] = useState(""), [decisionIndex, setDecisionIndex] = useState(0);
  const [composing, setComposing] = useState(false);
  const compositionDraft = useRef<typeof content | null>(null);
  const catalog = state.catalogs[task.task.provider];
  const models = catalog?.models ?? task.attachment.capabilities.models;
  const model = models.find(m => m.id === task.task.model);
  const modes = task.attachment.capabilities.modes, currentMode = task.attachment.capabilities.current_mode ?? task.task.mode;
  const mode = modes.find(m => m.id === currentMode), decisions = task.attachment.decisions, decision = decisions[Math.min(decisionIndex, Math.max(0, decisions.length - 1))];
  const pendingSend = state.pending.some(p => p.taskId === id && p.kind === "send");
  const previousTurns = detail?.receipts.filter(r => ["uncertain", "interrupted"].includes(r.status)) ?? [];
  const canSend = !composing && editable && owner.connected && !busy && !pendingSend && !local?.conflict && !["disconnected", "uncertain"].includes(task.attachment.state) && (!!content.text.trim() || !!content.assets.length || !!content.context.length);
  useEffect(() => { setMenu(null); setSearch(""); setAssetId(null); setLocalError(""); setDecisionIndex(0); }, [id]);
  useEffect(() => { if (menu !== "context") return; owner.clearContext(true); const timer = setTimeout(() => { void owner.searchContext(source, search); }, 160); return () => clearTimeout(timer); }, [menu, search, source]);
  useEffect(() => { if (!menu) return; const listener = (event: PointerEvent) => { if (!region.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setMenu(null); }; document.addEventListener("pointerdown", listener); return () => document.removeEventListener("pointerdown", listener); }, [menu]);
  async function attach(list: FileList | null) { if (!list || !editable) return; for (const file of Array.from(list).slice(0, 20)) { try { await owner.upload(id, file.name, file.type || "application/octet-stream", await encodeAgentFile(file)); } catch (e) { setLocalError(e instanceof Error ? e.message : String(e)); } } }
  function contextMenu(value: string | null = null) { setSource(value); setSearch(""); setMenu("context"); }
  async function preview(selection: AgentContextSelection) { setMenu("preview"); await owner.previewContext(selection); }
  const selectedAsset = detail?.assets.find(a => a.asset_id === assetId), assetPreview = assetId ? state.previews.get(`${id}:${assetId}`) : null;
  return <div className="at-composer-region" ref={region}>
    {task.unconfirmed > 0 && <details className="at-review"><summary><Icon name="warning" size={14} />{previousTurns.length > 0 && previousTurns.every(r => r.status === "interrupted") ? "Earlier turn stopped" : "Previous turn needs review"}</summary>{previousTurns.map(r => <div key={r.request_id}><strong>{r.status}</strong><p>{r.error}</p>{r.submitted_draft && <><pre>{r.submitted_draft.text}</pre><button className="at-button" disabled={!editable} onClick={() => owner.restoreSubmitted(id, r.submitted_draft!)}>Use retained draft</button></>}</div>)}</details>}
    {decision && <section className="at-permission" aria-label="Pending Agent permission"><div className="at-permission-title"><strong>{toolTitle(decision.title)}</strong>{decisions.length > 1 && <select aria-label="Pending permission" value={Math.min(decisionIndex, decisions.length - 1)} onChange={e => setDecisionIndex(Number(e.target.value))}>{decisions.map((d, i) => <option key={d.id} value={i}>{i + 1} of {decisions.length}</option>)}</select>}</div>
      {decision.details && <details className="at-permission-details" key={decision.id}><summary>View request</summary><pre>{decision.details}</pre></details>}<div className="at-permission-options">{decision.options.map(option => <button key={option.id} className="at-button" disabled={!controlled || !owner.connected || owner.hasPending(id, "decision")} onClick={() => void owner.reply(id, task.attachment.generation, decision.id, option.id)}>{option.label}</button>)}</div>
    </section>}
    {local?.conflict && <details className="at-conflict"><summary><Icon name="warning" size={14} />Local draft copy kept</summary><pre>{local.conflict.text}</pre><div><button className="at-button" disabled={!editable} onClick={() => owner.useLocalCopy(id)}>Use local copy</button><button className="at-button" onClick={() => owner.useSavedDraft(id)}>View saved draft</button></div></details>}
    <AgentComposer onDragOver={e => { if (editable && owner.connected && e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (owner.connected) void attach(e.dataTransfer.files); }}
      input={{ value: content.text, placeholder: `Message ${providers[task.task.provider]}…`, readOnly: !editable, canSubmit: canSend && !menu,
        onComposingChange: active => { if (active) compositionDraft.current = structuredClone(content); setComposing(active); },
        onChange: text => owner.editText(id, text), onCompositionCommit: text => owner.commitComposition(id, text, compositionDraft.current ?? content),
        onSubmit: () => void owner.send(id), onEscape: () => { setMenu(null); owner.clearContext(); }, onMention: () => contextMenu(),
        onPaste: e => { if (e.clipboardData.files.length && editable && owner.connected) { e.preventDefault(); void attach(e.clipboardData.files); } } }} tools={<>
        <Menu.Root><Menu.Trigger asChild><button className="at-icon" aria-label="Add context" title="Add context" disabled={!editable || !owner.connected}><Icon name="plus" /></button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu" side="top" align="start" sideOffset={6}>
          <Menu.Item className="at-menu-item" onSelect={() => files.current?.click()}><Icon name="attach" />Images &amp; files…</Menu.Item><Menu.Item className="at-menu-item" onSelect={() => contextMenu()}><Icon name="object" />Workspace</Menu.Item><Menu.Item className="at-menu-item" onSelect={() => contextMenu("plugins")}><Icon name="components" />Plugins</Menu.Item><Menu.Item className="at-menu-item" onSelect={() => contextMenu("editor")}><Icon name="code" />Editor selection</Menu.Item>
        </Menu.Content></Menu.Portal></Menu.Root>
        <button className="at-icon" title="Attach images or files" aria-label="Attach images or files" disabled={!editable || !owner.connected} onClick={() => files.current?.click()}><Icon name="attach" /></button>
        <button className="at-icon at-mention" title="Mention workspace information" aria-label="Mention workspace information" disabled={!editable || !owner.connected} onClick={() => contextMenu()}>@</button>
        <Menu.Root><Menu.Trigger asChild><button className="at-mode" aria-label="Permission mode" title={mode?.description ?? "Modes are supplied by the native Agent"} disabled={!editable || !owner.connected || !modes.length}><Icon name="shield" size={14} /><span>{mode?.name ?? "Permissions"}</span>{modes.length > 0 && <Down />}</button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu at-mode-menu" side="top" align="start" sideOffset={6}>
          {modes.map(m => <Menu.Item className="at-menu-item" key={m.id} onSelect={() => void owner.configure(id, task.task.model, task.task.effort, m.id)}><span className="at-task-label"><strong>{m.name}</strong>{m.description && <small>{m.description}</small>}</span>{m.id === currentMode && <Icon name="check" size={14} />}</Menu.Item>)}
        </Menu.Content></Menu.Portal></Menu.Root>
      </>} controls={<><select aria-label="Task model" value={task.task.model} title={model?.name ?? task.task.model} disabled={!editable || !owner.connected} onChange={e => void owner.configure(id, e.target.value, null, task.task.mode)}>{!models.some(m => m.id === task.task.model) && <option value={task.task.model}>{task.task.model}</option>}{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        {(model?.efforts.length ?? 0) > 0 && <select aria-label="Reasoning effort" value={task.task.effort ?? ""} disabled={!editable || !owner.connected} onChange={e => void owner.configure(id, task.task.model, e.target.value || null, task.task.mode)}><option value="">Default</option>{model!.efforts.map(e => <option key={e} value={e}>{e}</option>)}</select>}
        {busy ? <button className="at-send" title="Stop Agent" aria-label="Stop Agent" disabled={!controlled || !owner.connected || owner.hasPending(id, "stop")} onClick={() => void owner.act(id, "stop")}><Icon name="stop" size={14} /><span>Stop</span></button> : <button className="at-send primary" title="Send (Enter)" aria-label="Send message" disabled={!canSend} onClick={() => void owner.send(id)}><Icon name="send" size={15} /></button>}</>}>
      {!!content.context.length && <div className="at-context-chips">{content.context.map((selection, i) => <span className="at-context-chip" key={`${selection.source}:${i}`}><button onClick={() => void preview(selection)}><Icon name={selection.source === "objects" ? "object" : selection.source === "plots" ? "plot" : selection.source === "tables" ? "table" : selection.source.startsWith("plugin.") ? "components" : "file"} size={14} /><strong>{selection.label}</strong><small>{selection.source.startsWith("plugin.") ? "Plugin" : selection.source}</small></button>{editable && <button className="at-chip-remove" aria-label={`Remove ${selection.label}`} onClick={() => owner.removeContext(id, i)}><Icon name="close" size={12} /></button>}</span>)}</div>}
      {!!content.assets.length && <div className="at-assets">{content.assets.map(asset => { const record = detail?.assets.find(a => a.asset_id === asset); return record ? <AssetCard key={asset} asset={record} taskId={id} removable={editable} onPreview={() => { setAssetId(asset); setMenu("asset"); void owner.loadAsset(id, asset); }} /> : <span key={asset}>Attachment pending…</span>; })}</div>}
      {!editable && <div className="at-readonly-caption"><Icon name="lock" size={13} />{local?.conflict ? "Local draft copy · Read-only" : "Saved draft · Read-only"}</div>}
    </AgentComposer>
    <input ref={files} type="file" multiple hidden onChange={e => { void attach(e.target.files); e.target.value = ""; }} />
    <div className="at-draft-status">{task.task.archived ? "Archived · Unarchive to continue" : !editable ? "Read-only" : local?.dirty ? owner.connected ? "Saving draft…" : "Local draft · Offline" : "Draft saved"}</div>
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
  const owner = useAgentTasks(), rho = useComponentAgents(), navigation = useNavigation(), state = owner.getSnapshot(), rhoState = rho.getSnapshot(), task = state.selected ? owner.summary(state.selected) : null;
  useEffect(() => { owner.show(viewId); return () => owner.hide(viewId); }, [owner, viewId]);
  return <div className="agent-panel" aria-label="Agent panel"><TaskList /><main className="at-main"><TaskSelector />
    {state.error && <div className="at-error" role="alert"><span>{state.error}</span><button className="at-icon" aria-label="Dismiss Agent error" onClick={() => owner.clearError()}><Icon name="close" size={13} /></button></div>}
    {rhoState.error && <div className="at-error" role="alert"><span>{rhoState.error}</span><button className="at-icon" aria-label="Dismiss Rho error" onClick={() => rho.clearError()}><Icon name="close" size={13} /></button></div>}
    {state.selectedTask?.kind === "rho" ? <RhoConversation key={state.selectedTask.conversation_id} id={state.selectedTask.conversation_id} /> : task ? <><TaskHeader task={task} /><NativeScientificWork key={`science:${task.task.task_id}`} task={task} /><Conversation task={task} /><Composer key={task.task.task_id} task={task} /></> : <div className="at-start"><Icon name="agent" size={28} /><h2>Work with an Agent</h2><NewTaskButton /><button onClick={() => navigation.setDialog("agents")}><Icon name="settings" />Agent Settings</button></div>}
  </main></div>;
}
