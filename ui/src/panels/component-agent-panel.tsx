import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAgentTasks, useComponentAgents, useDocuments, useNavigation, useRuntimeSessions } from "../context";
import { componentBusy } from "../component-agents";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { AgentComposer } from "./agent-composer";
import { ScientificOperations, receiptOperationIds } from "./agent-scientific-work";
import { AgentAttachment } from "./agent-attachment";
import { encodeAgentFile } from "../agent-task-adapter";
import type { AgentAsset } from "../generated/AgentAsset";
import { Icon } from "../icons";
import type { ComponentAgentProfile } from "../generated/ComponentAgentProfile";
import type { ComponentAgentEvidence } from "../generated/ComponentAgentEvidence";
import type { ComponentAgentRunSummary } from "../generated/ComponentAgentRunSummary";
import type { ComponentSourcePreview } from "../generated/ComponentSourcePreview";
import type { ComponentSourceSearchResult } from "../generated/ComponentSourceSearchResult";
import type { AgentContextSelection } from "../generated/AgentContextSelection";
import "../component-agent.css";

export const componentLabels: Record<ComponentAgentProfile, string> = { objects: "Objects", packages: "Packages", plots: "Plots", documents: "Documents", workspace: "Console / Workspace", project: "Files / Project", environment: "Environment / R Sessions" };
const runLabels: Record<string,string> = {queued:"Queued",running:"Running",waiting_for_r:"Waiting for R",needs_input:"Needs input",waiting_for_permission:"Needs permission",stopping:"Stopping",completed:"Response complete",stopped:"Stopped",failed:"Failed",interrupted:"Interrupted"};
const toolLabels: Record<string,string> = {"agent.task_intent":"Understand request","rho_task_intent":"Understand request","workspace.run_r":"Run R code","project.read_file":"Read file","workspace.package_index":"Inspect package","workspace.resolve_object":"Inspect object","application.document_edit":"Edit document","application.document_save":"Save document","application.document_run":"Run document"};
const toolPhases: Record<string,string> = {intent:"Preparing",accepted:"Accepted",resolved:"Done",uncertain:"Needs review"};
const sourceFor = (profile: ComponentAgentProfile) => profile === "documents" ? "editor" : profile === "project" ? "files" : profile;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function AskComponent({ profile, viewId, compact = false }: { profile: ComponentAgentProfile; viewId?: string; compact?: boolean }) {
  const owner = useComponentAgents(), tasks = useAgentTasks(), navigation = useNavigation(), [busy, setBusy] = useState(false);
  async function ask() {
    setBusy(true); navigation.setDialog(null); navigation.showPanel("agent");
    try {
      const selectionBefore=tasks.getSnapshot().selectedTask;
      let reference = selectionBefore;
      if (reference?.kind === "rho") { await owner.observeConversation(reference.conversation_id); if (!owner.canControl(reference.conversation_id)) reference = null; }
      if (reference?.kind === "native" && !tasks.canEdit(reference.task_id)) reference = null;
      if (!reference) {
        const agent = tasks.getSnapshot().lastAgent;
        if (agent === "rho") { const id = await owner.newTask(profile,viewId); if (id) { reference = { kind: "rho", conversation_id: id }; if(JSON.stringify(tasks.getSnapshot().selectedTask)===JSON.stringify(selectionBefore))tasks.chooseTask(reference); } }
        else { const id = await tasks.newTask(agent); reference = id ? {kind:"native",task_id:id} : null; }
      }
      if (reference?.kind === "rho") await owner.appendContext(reference.conversation_id, profile, viewId);
      else if (reference?.kind === "native") { const sources = await owner.prepareContext(profile, viewId); for (const source of sources) tasks.addContext(reference.task_id, source); }
      await tasks.observeProjectTasks();
    } catch (error) { owner.reportError(error); }
    finally { setBusy(false); }
  }
  return <button className={compact ? "icon-button ca-ask" : "ca-ask"} title={`Ask about ${componentLabels[profile]}`} disabled={busy} aria-label={`Ask about ${componentLabels[profile]}`} onClick={() => void ask()}><Icon name="agent" size={14} />{!compact && "Ask about…"}</button>;
}
function Evidence({ evidence }: { evidence: ComponentAgentEvidence }) {
  const navigation = useNavigation(), documents = useDocuments(), owner = useComponentAgents();
  if (evidence.kind === "attachment") {
    const preview=owner.getSnapshot().previews.get(`${evidence.conversation_id}:${evidence.asset.asset_id}`);
    return <details className="at-sent-asset" onToggle={event=>{if(event.currentTarget.open)void owner.loadAsset(evidence.conversation_id,evidence.asset.asset_id).catch(error=>owner.reportError(error));}}><summary><Icon name={evidence.asset.mime_type.startsWith("image/")?"image":"file"} size={14}/>{evidence.asset.name}</summary>{preview&&(evidence.asset.mime_type.startsWith("image/")?<img alt={evidence.asset.name} src={preview.url}/>:<pre>{preview.text}</pre>)}</details>;
  }
  let title = "View source", open = () => {};
  if (evidence.kind === "media") { title = "Open original plot ↗"; open = () => navigation.locatePlot(evidence.reference); }
  if (evidence.kind === "document") { title = "Open document ↗"; open = () => documents.focus(evidence.document.document_id); }
  if (evidence.kind === "file") { title = `Open ${evidence.path} ↗`; open = () => { void navigation.openDocument(evidence.path); }; }
  if (evidence.kind === "operation") { title = "Open producing run ↗"; open = () => navigation.openOperation(evidence.operation_id); }
  if (evidence.kind === "observation") {
    const ref = object(evidence.reference);
    if (typeof ref.name === "string") { title = `Open ${ref.name} ↗`; open = () => navigation.openObject(String(ref.name), [], typeof ref.workspace_instance_id === "string" ? ref.workspace_instance_id : undefined); }
    else if (evidence.capability.includes("package")) { title = "Open Packages ↗"; open = () => navigation.showPanel("packages"); }
    else { title = "Open R session ↗"; open = () => navigation.openSessions(typeof ref.workspace_instance_id === "string" ? ref.workspace_instance_id : null); }
  }
  return <button className="ca-evidence" onClick={open}>{title}</button>;
}
function SourcePicker({ id, initial, close }: { id: string; initial: AgentContextSelection | null; close(): void }) {
  const owner = useComponentAgents(), profile = owner.getSnapshot().conversations.get(id)?.profile ?? "objects";
  const [source, setSource] = useState(initial?.source ?? sourceFor(profile)), [text, setText] = useState(""), [page, setPage] = useState<ComponentSourceSearchResult | null>(null);
  const [preview, setPreview] = useState<ComponentSourcePreview | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const request = useRef(0);
  async function read(selection: AgentContextSelection) {
    const token = ++request.current; setLoading(true); setPreview(null); setError("");
    try { const result = await owner.previewSource(id, selection); if (token === request.current) setPreview(result); }
    catch (e) { if (token === request.current) setError(String(e)); }
    finally { if (token === request.current) setLoading(false); }
  }
  useEffect(() => { if (initial) void read(initial); return () => { request.current++; }; }, [id, initial]);
  useEffect(() => {
    if (initial) return;
    let ignore = false; const token = ++request.current;
    const timer = setTimeout(() => { setLoading(true); void owner.searchSources(id, source, text).then(result => { if (!ignore && token === request.current) setPage(result); }).catch(e => { if (!ignore) setError(String(e)); }).finally(() => { if (!ignore && token === request.current) setLoading(false); }); }, 180);
    return () => { ignore = true; clearTimeout(timer); };
  }, [id, source, text, initial, owner]);
  const snapshot = preview?.snapshot;
  return <section className="ca-picker" role="dialog" aria-label="Add workspace context" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
    <header><strong>{snapshot ? snapshot.title : "Add context"}</strong><button aria-label="Close context picker" onClick={close}><Icon name="close" /></button></header>
    {!initial && !snapshot && <><select aria-label="Context source type" value={source} onChange={e => setSource(e.target.value)}>{["objects", "packages", "plots", "editor", "workspace", "files", "environment"].map(s => <option key={s}>{s}</option>)}</select><input autoFocus aria-label="Find workspace information" value={text} maxLength={256} placeholder="Find information in this project" onChange={e => setText(e.target.value)} /></>}
    {loading && <p>Reading source…</p>}{(error || preview?.error) && <p role="alert">{error || preview?.error}</p>}
    <div className="ca-picker-scroll">
      {snapshot ? <><small>{snapshot.description}</small>{preview.image_base64 && <img alt={snapshot.title} src={`data:${preview.image_mime_type};base64,${preview.image_base64}`} />}<pre>{snapshot.text}</pre>{snapshot.truncated && <small>Bounded preview; additional content is omitted.</small>}{snapshot.evidence.map((e, i) => <Evidence key={i} evidence={e} />)}</> :
        page?.items.map((item, i) => <button key={i} onClick={() => void read(item.selection)}><strong>{item.title}</strong><small>{item.description}</small></button>)}
      {page?.notices.map((notice, i) => <p key={i}><small>{notice}</small></p>)}
    </div>
    {snapshot && <div className="ca-actions">
      <label>Include <select aria-label="Context inclusion scope" value={snapshot.selection.inclusion} onChange={e => void read({ ...snapshot.selection, inclusion: e.target.value })}>{(snapshot.selection.source === "plots" ? ["image", "summary"] : snapshot.selection.source === "editor" ? ["text", "selection", "summary"] : snapshot.selection.source === "files" ? ["text", "summary"] : ["objects", "tables"].includes(snapshot.selection.source) ? ["summary", "selection"] : ["summary"]).map(s => <option key={s}>{s}</option>)}</select></label>
      <button className="primary" disabled={loading || !owner.canControl(id)} onClick={() => { try { owner.includeSource(id, preview); const draft = owner.getSnapshot().drafts.get(id); if (draft?.text.endsWith("@")) owner.editDraft(id,draft.text.slice(0,-1)); close(); } catch (e) { setError(String(e)); } }}>{initial ? "Use refreshed source" : "Add context"}</button>
    </div>}
  </section>;
}
function RhoAttachment({ id, asset, editable, preview }: { id:string; asset:AgentAsset; editable:boolean; preview():void }) {
  const owner=useComponentAgents(), value=owner.getSnapshot().previews.get(`${id}:${asset.asset_id}`);
  useEffect(()=>{if(asset.mime_type.startsWith("image/"))void owner.loadAsset(id,asset.asset_id).catch(error=>owner.reportError(error));},[id,asset.asset_id]);
  return <AgentAttachment asset={asset} preview={value} onPreview={preview} onRemove={editable?()=>owner.removeAsset(id,asset.asset_id):undefined} />;
}
function RunTurn({ summary }: { summary: ComponentAgentRunSummary }) {
  const owner = useComponentAgents(), tasks = useAgentTasks(), state = owner.getSnapshot(), run = state.runs.get(summary.run_id);
  const events = state.events.get(summary.run_id) ?? [], tools = state.tools.get(summary.run_id) ?? [], scientificIds=receiptOperationIds(tools);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function observe() {
      if (!tasks.historyVisible) { timer = setTimeout(observe,1500); return; }
      try { await owner.observeRun(summary.run_id); if (!disposed) await Promise.all([owner.observeEvents(summary.run_id), owner.observeTools(summary.run_id)]); }
      catch (e) { if (!disposed) owner.reportError(e); }
      const current = owner.getSnapshot().runs.get(summary.run_id), last = owner.getSnapshot().events.get(summary.run_id)?.at(-1)?.sequence ?? 0;
      if (!disposed && current && (componentBusy(current) || last < current.event_cursor)) timer = setTimeout(observe, 1500);
    }
    void observe(); return () => { disposed = true; clearTimeout(timer); };
  }, [owner, summary.run_id, summary.state]);
  const chunks: string[] = [];
  for (const event of events) if (event.content.kind === "text") chunks.push(event.content.text);
  return <article className="ca-turn" aria-label="Agent turn"><div className="at-message at-message-user"><small>You</small><div className="at-message-text">{run?.request.text ?? summary.text_excerpt}</div>
      <div className="at-event-inputs">{(run?.request.assets??[]).map(assetId=>{const id=run!.request.conversation_id, asset=state.assets.get(id)?.find(asset=>asset.asset_id===assetId), preview=state.previews.get(`${id}:${assetId}`); return <details className="at-sent-asset" key={assetId} onToggle={event=>{if(event.currentTarget.open)void owner.loadAsset(id,assetId).catch(error=>owner.reportError(error));}}><summary><Icon name={asset?.mime_type.startsWith("image/")?"image":"file"} size={14}/>{asset?.name??"Attached file"}</summary>{preview&&(asset?.mime_type.startsWith("image/")?<img alt={asset.name} src={preview.url}/>:<pre>{preview.text}</pre>)}</details>;})}</div></div>
    {!!run?.context?.sources.length && <details className="ca-tool"><summary>Sources used for this answer</summary>{run.context.sources.map((source, i) => <div key={i}><strong>{source.title}</strong><small> · {source.description}</small>{source.evidence.map((e, j) => <Evidence key={j} evidence={e} />)}</div>)}</details>}
    <div className="at-message at-message-assistant"><small>Rho</small><div className="at-message-text">{chunks.join("")}</div></div>
    {state.historyGap.get(summary.run_id) && <p><small>Earlier streamed text is outside the retained display window. Native receipts remain available below.</small></p>}
    {(tools.some(tool=>tool.mutation) || run?.state === "waiting_for_r") && <ScientificOperations ids={scientificIds.slice(0,8)} unknown={run?.state==="waiting_for_r"&&!scientificIds.length} partial={scientificIds.length>8}/>}
    {tools.map(tool => <details key={tool.receipt_id} className="ca-tool"><summary>{toolLabels[tool.capability] ?? tool.capability.replaceAll("_", " ").replaceAll(".", " · ")} · {toolPhases[tool.phase] ?? tool.phase}</summary><pre>{JSON.stringify({capability:tool.capability,phase:tool.phase,result:tool.result}, null, 2)}</pre>{tool.evidence.map((e, i) => <Evidence evidence={e} key={i} />)}</details>)}
    {events.filter(e => e.content.kind === "diagnostic").map(e => e.content.kind === "diagnostic" && <details key={e.sequence} className="at-error"><summary>{e.content.diagnostic.message}</summary><small>{e.content.diagnostic.code}</small></details>)}
    {events.filter(e => e.content.kind === "evidence").map(e => e.content.kind === "evidence" && <Evidence key={e.sequence} evidence={e.content.reference} />)}
    <p data-state={run?.state ?? summary.state}><small>{runLabels[run?.state ?? summary.state] ?? "Checking status"}</small></p>{run && <details className="ca-tool"><summary>Run details</summary><small>{run.model_calls} model calls · {run.tool_calls} tools</small><dl><dt>Input tokens</dt><dd>{run.input_tokens ?? "Unknown"}</dd><dt>Output tokens</dt><dd>{run.output_tokens ?? "Unknown"}</dd></dl></details>}
    {(run?.reason || summary.reason) && <p role="status">{run?.reason ?? summary.reason}</p>}
  </article>;
}
const permissionPolicies = [
  { id: "ask", name: "Ask", description: "Ask before additional actions outside your request" },
  { id: "auto_approval", name: "Auto approval", description: "Use your request and saved rules to approve actions" },
  { id: "full_access", name: "Full access", description: "Act within this project's available capabilities" },
] as const;
export function RhoConversation({ id }: { id: string }) {
  const owner = useComponentAgents(), tasks = useAgentTasks(), sessions = useRuntimeSessions(), navigation = useNavigation(), state = owner.getSnapshot(), conversation = state.conversations.get(id), runtime = sessions.getSnapshot();
  const draft = state.drafts.get(id), composer = owner.composer(id), history = state.history.get(id);
  const [picker, setPicker] = useState<{ selection: AgentContextSelection | null } | null>(null), [composing, setComposing] = useState(false), [renaming, setRenaming] = useState(false), [title, setTitle] = useState(""), [assetId,setAssetId]=useState<string|null>(null), [uploading,setUploading]=useState(false);
  const files=useRef<HTMLInputElement>(null);
  const transcript = useRef<HTMLDivElement>(null), restoring = useRef(false), key = `rho:${id}`;
  const [showLatest, setShowLatest] = useState(false);
  useLayoutEffect(() => { const node = transcript.current; if (!node) return; restoring.current = true; const position = tasks.position(key); node.scrollTop = position.following ? node.scrollHeight : position.scrollTop; setShowLatest(!position.following); restoring.current = false; }, [key]);
  useLayoutEffect(() => { if (tasks.position(key).following && transcript.current) { restoring.current = true; transcript.current.scrollTop = transcript.current.scrollHeight; restoring.current = false; } });
  const controlled = owner.ownsTask(id), editable = owner.canControl(id), pending = state.pending.filter(p => p.request.conversation_id === id);
  const latest = history?.runs[0], run = latest ? state.runs.get(latest.run_id) : undefined;
  const activeRun = conversation?.active_run_id ? state.runs.get(conversation.active_run_id) : undefined;
  const currentRun = activeRun ?? run;
  const busy = !!conversation?.active_run_id && (!activeRun || componentBusy(activeRun)) || !!run && componentBusy(run);
  const attachments=state.assets.get(id)??[], attachmentPreview=assetId?state.previews.get(`${id}:${assetId}`):undefined, selectedAsset=attachments.find(asset=>asset.asset_id===assetId);
  const imageCount = composer.sources.filter(s => s.source === "plots" && s.inclusion === "image").length + (draft?.assets??[]).filter(assetId=>attachments.some(asset=>asset.asset_id===assetId&&asset.mime_type.startsWith("image/"))).length;
  const hasImages = imageCount > 0, inputCount = composer.sources.length + (draft?.assets?.length ?? 0);
  const imageTest = state.diagnostics.find(d => d.kind === "images" && JSON.stringify(d.model) === JSON.stringify(state.settings?.connection));
  const imagesReady = !hasImages || imageTest?.state === "passed";
  const boundSession = composer.grant.session, observedSession = boundSession ? runtime.instances.get(boundSession.workspace_instance_id) : null;
  const sessionExpired = !!boundSession && !!observedSession && (observedSession.native_session_id !== boundSession.session_id || observedSession.state !== "ready");
  const sourceMismatch = composer.sources.some(source => { if (!["objects","tables","packages","workspace"].includes(source.source)) return false; const ref=object(source.reference); return ref.workspace_instance_id !== boundSession?.workspace_instance_id || ref.expected_session !== boundSession?.session_id; });
  const canSend = imageCount <= 2 && inputCount <= 16 && !uploading && owner.attachmentsReady(id) && !sessionExpired && !sourceMismatch && editable && !busy && !pending.length && !state.submitting.has(id) && !composing && (!!draft?.text.trim() || !!draft?.assets?.length) && draft?.conflict === null && !!state.settings?.enabled && !!state.settings.connection && state.credentialStatus?.available !== false && imagesReady;
  async function attach(list: FileList | null) {
    if(!list || !editable)return; setUploading(true);
    try { for(const file of Array.from(list).slice(0,20)) {
      try {
        const mime=file.type||(/\.(r|md|txt|csv|tsv|json|log|yaml|yml|toml)$/i.test(file.name)?"text/plain":"application/octet-stream");
        if(mime.startsWith("image/") && file.size>2*1024*1024) throw new Error("Images are limited to 2 MiB each.");
        if((mime.startsWith("text/")||/\.(r|md|txt|csv|tsv|json|log|yaml|yml|toml)$/i.test(file.name)) && file.size>32*1024) throw new Error("Text attachments are limited to 32 KiB each.");
        await owner.upload(id,file.name,mime,await encodeAgentFile(file));
      } catch(error){owner.reportError(error);}
    } } finally {setUploading(false);}
  }
  const settings = () => navigation.openAgentSettings("rho");
  const action = (work: Promise<unknown>) => { void work.catch(e => owner.reportError(e)); };
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function observe() {
      if (!tasks.historyVisible) { timer = setTimeout(observe,2000); return; }
      try { await owner.observeConversation(id); if (!disposed) await Promise.all([owner.observeHistory(id, owner.getSnapshot().history.get(id)?.before ?? null), owner.observeSettings(), owner.observeAssets(id)]); }
      catch (e) { if (!disposed) owner.reportError(e); }
      if (!disposed) timer = setTimeout(observe, 2000);
    }
    void observe(); return () => { disposed = true; clearTimeout(timer); };
  }, [owner, id]);
  useEffect(() => {
    if (!draft?.dirty || draft.conflict !== null || !editable || composing || uploading || !owner.attachmentsReady(id)) return;
    const timer = setTimeout(() => action(owner.flushDraft(id)), 600);
    return () => clearTimeout(timer);
  }, [id, draft?.revision, draft?.dirty, draft?.conflict, editable, composing, uploading, state.uploading, state.assets, owner]);
  if (!conversation) return <p className="ca-meta">Reading task…</p>;
  const policy = permissionPolicies.find(p => p.id === composer.grant.permission_policy) ?? permissionPolicies[0];
  const decisions = currentRun?.state === "waiting_for_permission" ? currentRun.permissions?.filter(p => p.state === "pending") ?? [] : [];
  return <>
    <header className="at-task-header"><div className="at-task-heading">
      {renaming ? <form onSubmit={event => { event.preventDefault(); action(owner.metadata(id, { title }).then(() => tasks.refreshProjectTasks())); setRenaming(false); }}><input autoFocus aria-label="Task title" maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /><button title="Save title"><Icon name="check" /></button></form> : <strong className="at-title">{conversation.title || "New task"}</strong>}
      <div className="at-task-meta"><span>Rho</span><span>·</span><span>{controlled ? currentRun ? runLabels[currentRun.state] : busy ? "Checking status" : "Ready" : tasks.connected ? "Read-only · Another window" : "Read-only · Offline"}</span>{conversation.archived && <span>· Archived</span>}</div>
    </div>{!controlled && <button className="at-button" disabled={busy} title={busy ? "Wait for the current task to stop before taking over" : undefined} onClick={() => action(owner.takeControl(id))}>Take over</button>}
      <button className="at-icon" aria-label="Agent Settings" onClick={settings}><Icon name="settings" /></button>
      <Menu.Root><Menu.Trigger asChild><button className="at-icon" aria-label="Task actions"><Icon name="more" /></button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu" align="end"><Menu.Item className="at-menu-item" disabled={!tasks.connected} onSelect={() => action(tasks.handoffs.prepare({ kind: "rho", conversation_id: id }))}>Prepare handoff</Menu.Item><Menu.Item className="at-menu-item" disabled={!controlled} onSelect={() => { setTitle(conversation.title); setRenaming(true); }}>Rename</Menu.Item><Menu.Item className="at-menu-item" disabled={!controlled} onSelect={() => action(owner.metadata(id, { archived: !conversation.archived }).then(() => tasks.refreshProjectTasks()))}>{conversation.archived ? "Unarchive" : "Archive"}</Menu.Item></Menu.Content></Menu.Portal></Menu.Root>
    </header>
    <div className="at-conversation" aria-label="Agent conversation" ref={transcript} onScroll={e => { if (restoring.current) return; const node = e.currentTarget, following = node.scrollHeight-node.scrollTop-node.clientHeight<48; tasks.setPosition(key, {scrollTop:node.scrollTop,following}); setShowLatest(!following); }}>
      {history?.next && <button className="at-history-note" onClick={() => { tasks.setPosition(key, {scrollTop:transcript.current?.scrollTop ?? 0,following:false}); action(owner.observeHistory(id, history.next)); }}>Earlier messages</button>}
      {history?.before && <button className="at-history-note" onClick={() => action(owner.observeHistory(id))}>Latest messages</button>}
      {[...(history?.runs ?? [])].reverse().map(summary => <RunTurn key={summary.run_id} summary={summary} />)}
      {!history?.runs.length && <div className="at-empty-conversation">What would you like to work on?</div>}
      {(busy || state.submitting.has(id)) && <div className="at-live-activity" role="status"><span className="at-activity-dots" aria-hidden="true"><i /><i /><i /></span>{decisions.length ? "Needs permission" : currentRun?.state === "stopping" ? "Stopping · Checking original actions" : state.submitting.has(id) ? "Sending…" : "Working…"}</div>}
      {showLatest && <button className="ca-follow" onClick={() => { tasks.setPosition(key, {scrollTop:0,following:true}); setShowLatest(false); }}>Jump to latest</button>}
    </div>
    <div className="at-composer-region">
      <input type="file" ref={files} multiple hidden accept="image/png,image/jpeg,text/*,.r,.R,.md,.csv,.tsv,.json,.log,.yaml,.yml,.toml" onChange={event=>{void attach(event.target.files);event.target.value="";}}/>
      {!state.settings?.enabled && <div className="ca-actions"><small>Configure Rho to send this task. Your draft is kept.</small><button onClick={settings}>Configure Rho</button></div>}
      {state.settings?.enabled && state.credentialStatus?.available === false && <div className="ca-actions"><small>The API key is unavailable. Your draft is kept.</small><button onClick={settings}>Rho settings</button></div>}
      {!imagesReady && <div className="ca-actions"><small>Image input is unavailable. Test this model or include the plot summary.</small><button onClick={settings}>Model settings</button></div>}
      {decisions.map(decision => <section key={decision.decision_id} className="at-permission" aria-label="Pending Agent permission"><div className="at-permission-title"><strong>{decision.title}</strong></div><details className="at-permission-details"><summary>View request</summary><pre>{decision.details}</pre></details><div className="at-permission-options"><button className="at-button" disabled={!controlled} onClick={() => action(owner.decide(currentRun!.run_id, decision.decision_id, true))}>Allow</button><button className="at-button" disabled={!controlled} onClick={() => action(owner.decide(currentRun!.run_id, decision.decision_id, false))}>Deny</button></div></section>)}
      {draft?.conflict !== null && draft?.conflict !== undefined && <details className="at-conflict"><summary>Local draft copy kept</summary><pre>{draft.text}</pre><p>Saved draft: {draft.conflict}</p><button disabled={!editable} onClick={() => owner.resolveDraft(id, true)}>Use local copy</button><button onClick={() => owner.resolveDraft(id, false)}>View saved draft</button></details>}
      {pending.map(p => <div className="ca-actions" key={p.request.request_id}><small>Previous submission needs review.</small><button onClick={() => action(owner.observeSubmission(p.request.request_id))}>Check submission</button>{p.state === "uncertain" && <button disabled={!editable} onClick={() => action(owner.retrySubmission(p.request.request_id))}>Retry original submission</button>}</div>)}
      {(sessionExpired || sourceMismatch) && <div className="ca-actions"><small>{sessionExpired ? "The selected R session has changed. Select its current session before sending." : "Some sources belong to another R session. Keep their original session, or remove and reselect those sources."}</small></div>}
      {(imageCount>2 || inputCount>16) && <div className="ca-actions"><small>{imageCount>2 ? "Choose at most two images for one message." : "Choose at most 16 sources and attachments for one message."}</small></div>}
      {!owner.attachmentsReady(id) && !uploading && !state.uploading.has(id) && <div className="ca-actions"><small>An attachment is not confirmed. Check its original upload or remove it before sending.</small><button onClick={()=>action(owner.observeAssets(id))}>Check attachments</button></div>}
      <AgentComposer onDragOver={event=>{if(editable&&event.dataTransfer.types.includes("Files"))event.preventDefault();}} onDrop={event=>{event.preventDefault();void attach(event.dataTransfer.files);}} input={{ value: draft?.text ?? "", placeholder: "Message Rho…", readOnly: !editable, canSubmit: canSend && !picker && !assetId,
        onChange: text => owner.editDraft(id, text), onCompositionCommit: text => owner.commitComposition(id, text), onComposingChange: setComposing,
        onSubmit: () => action(owner.send(id)), onEscape: () => {setPicker(null);setAssetId(null);}, onMention: () => {setAssetId(null);setPicker({selection:null});}, onPaste: event => {if(event.clipboardData.files.length&&editable){event.preventDefault();void attach(event.clipboardData.files);}} }}
        tools={<><button className="at-icon" aria-label="Add context" disabled={!editable} onClick={() => setPicker({selection:null})}><Icon name="plus" /></button><button className="at-icon" aria-label="Attach images or files" disabled={!editable||uploading||state.uploading.has(id)} onClick={() => files.current?.click()}><Icon name="attach" /></button><button className="at-icon at-mention" aria-label="Mention workspace information" disabled={!editable} onClick={() => setPicker({selection:null})}>@</button>
          <Menu.Root><Menu.Trigger asChild><button className="at-mode" aria-label="Permission mode" title={policy.description} disabled={!editable}><Icon name="shield" size={14} /><span>{policy.name}</span><Icon name="chevron" size={12} /></button></Menu.Trigger><Menu.Portal><Menu.Content className="at-menu at-mode-menu" side="top" align="start">{permissionPolicies.map(p => <Menu.Item className="at-menu-item" key={p.id} onSelect={() => owner.setComposer(id, {...composer,grant:{...composer.grant,permission_policy:p.id}})}><span className="at-task-label"><strong>{p.name}</strong><small>{p.description}</small></span>{p.id===policy.id && <Icon name="check" size={14} />}</Menu.Item>)}</Menu.Content></Menu.Portal></Menu.Root></>}
        controls={<><button className="at-model-select" aria-label="Task model" onClick={settings}>{state.settings?.connection?.model ?? "Configure model"}<Icon name="chevron" size={12} /></button>{busy ? <button className="at-send" aria-label="Stop Agent" disabled={!controlled || currentRun?.state === "stopping"} onClick={() => action(owner.controlRun(conversation.active_run_id ?? run!.run_id,"stop"))}><Icon name="stop" size={14} /><span>Stop</span></button> : <button className="at-send primary" aria-label="Send message" disabled={!canSend} onClick={() => action(owner.send(id))}><Icon name="send" size={15} /></button>}</>}>
        <label className="at-session-picker">R session <select aria-label="Task R session" disabled={!editable || runtime.stale} value={boundSession?.workspace_instance_id ?? ""} onChange={event => {
          const selected = sessions.getSnapshot().instances.get(event.target.value);
          if (event.target.value && (!selected || selected.state !== "ready" || !selected.native_session_id)) return;
          owner.setComposer(id,{...composer,grant:{...composer.grant,session:selected?.native_session_id ? {workspace_instance_id:selected.workspace_instance_id,session_id:selected.native_session_id} : null}});
        }}><option value="">No R session</option>{boundSession && !runtime.instances.has(boundSession.workspace_instance_id) && <option value={boundSession.workspace_instance_id}>{boundSession.workspace_instance_id} · unavailable</option>}{[...runtime.instances.values()].map(instance => <option key={instance.workspace_instance_id} value={instance.workspace_instance_id} disabled={instance.state !== "ready" || !instance.native_session_id}>{instance.name}{instance.state !== "ready" ? ` · ${instance.state}` : ""}</option>)}</select></label>
        {!!composer.sources.length && <div className="at-context-chips">{composer.sources.map((source,i) => <span className="at-context-chip" key={`${source.source}:${i}`}><button onClick={() => setPicker({selection:source})}><Icon name="link" size={14} /><strong>{source.label}</strong><small>{source.source}</small></button>{editable && <button className="at-chip-remove" aria-label={`Remove ${source.label}`} onClick={() => owner.removeSource(id,i)}><Icon name="close" size={12} /></button>}</span>)}</div>}
        {!!draft?.assets?.length && <div className="at-assets">{draft.assets.map(value=>{const asset=attachments.find(asset=>asset.asset_id===value);return asset?<RhoAttachment key={value} id={id} asset={asset} editable={editable} preview={()=>{setPicker(null);setAssetId(value);action(owner.loadAsset(id,value));}}/>:<div className="at-asset" key={value}><span>{state.uploading.has(id)?"Uploading attachment…":"Attachment not confirmed"}</span>{editable&&<button aria-label="Remove unconfirmed attachment" onClick={()=>owner.removeAsset(id,value)}><Icon name="close" size={12}/></button>}</div>;})}</div>}
        {!editable && <div className="at-readonly-caption"><Icon name="lock" size={13} />{draft?.conflict !== null ? "Local draft copy · Read-only" : "Saved draft · Read-only"}</div>}
      </AgentComposer>
      <div className="at-draft-status">{conversation.archived ? "Archived · Unarchive to continue" : !editable ? "Read-only" : draft?.dirty ? "Saving draft…" : "Draft saved"}</div>
      {run && ["stopping","interrupted","failed","stopped"].includes(run.state) && <div className="ca-actions"><button disabled={!controlled} onClick={() => action(owner.controlRun(run.run_id,"reconcile"))}>Check status</button>{run.recovery && <small>{run.recovery.unresolved_mutations ? "Original actions remain unresolved" : "Original actions checked"}</small>}{run.recovery && !run.recovery.unresolved_mutations && !componentBusy(run) && <button disabled={!canSend} onClick={() => action(owner.send(id,run.run_id))}>Continue</button>}</div>}
    </div>
    {assetId && <section className="ca-picker" role="dialog" aria-label="Preview attachment"><header><strong>{selectedAsset?.name??"Attachment"}</strong><button className="at-icon" aria-label="Close attachment preview" onClick={()=>setAssetId(null)}><Icon name="close"/></button></header><div className="ca-picker-scroll">{attachmentPreview ? selectedAsset?.mime_type.startsWith("image/")?<img alt={selectedAsset.name} src={attachmentPreview.url}/>:<pre>{attachmentPreview.text}</pre>:"Loading preview…"}</div></section>}
    {picker && <SourcePicker key={id} id={id} initial={picker.selection} close={() => setPicker(null)} />}
  </>;
}
