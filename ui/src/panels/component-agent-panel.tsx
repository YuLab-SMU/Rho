import { useEffect, useRef, useState } from "react";
import { useAgentTasks, useComponentAgents, useDocuments, useNavigation } from "../context";
import { componentBusy } from "../component-agents";
import { AgentPanel } from "./agent-panel";
import { AgentMessageInput } from "./agent-message-input";
import { ComponentModelSettingsPanel } from "./component-model-settings";
import { Icon } from "../icons";
import type { ComponentAgentProfile } from "../generated/ComponentAgentProfile";
import type { ComponentAgentEvidence } from "../generated/ComponentAgentEvidence";
import type { ComponentAgentRunSummary } from "../generated/ComponentAgentRunSummary";
import type { ComponentSourcePreview } from "../generated/ComponentSourcePreview";
import type { ComponentSourceSearchResult } from "../generated/ComponentSourceSearchResult";
import type { AgentContextSelection } from "../generated/AgentContextSelection";
import "../component-agent.css";

export const componentLabels: Record<ComponentAgentProfile, string> = { objects: "Objects", packages: "Packages", plots: "Plots", documents: "Documents", workspace: "Console / Workspace", project: "Files / Project", environment: "Environment / R Sessions" };
const sourceFor = (profile: ComponentAgentProfile) => profile === "documents" ? "editor" : profile === "project" ? "files" : profile;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function AskComponent({ profile, viewId, compact = false }: { profile: ComponentAgentProfile; viewId?: string; compact?: boolean }) {
  const owner = useComponentAgents(), navigation = useNavigation(), [busy, setBusy] = useState(false);
  return <button className={compact ? "icon-button ca-ask" : "ca-ask"} title={`Ask about ${componentLabels[profile]}`} disabled={busy} aria-label={`Ask about ${componentLabels[profile]}`} onClick={() => {
    setBusy(true); navigation.setDialog(null); navigation.showPanel("agent"); owner.showAssistant();
    void owner.ask(profile, viewId).catch(e => owner.reportError(e)).finally(() => setBusy(false));
  }}><Icon name="agent" size={14} />{!compact && "Ask about…"}</button>;
}
function Evidence({ evidence }: { evidence: ComponentAgentEvidence }) {
  const navigation = useNavigation(), documents = useDocuments();
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
  return <section className="ca-picker" role="dialog" aria-label="Assistant sources" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
    <header><strong>{snapshot ? snapshot.title : "Add context"}</strong><button aria-label="Close assistant sources" onClick={close}><Icon name="close" /></button></header>
    {!initial && !snapshot && <><select aria-label="Assistant source type" value={source} onChange={e => setSource(e.target.value)}>{["objects", "packages", "plots", "editor", "workspace", "files", "environment"].map(s => <option key={s}>{s}</option>)}</select><input autoFocus aria-label="Find assistant context" value={text} maxLength={256} placeholder="Find information in this project" onChange={e => setText(e.target.value)} /></>}
    {loading && <p>Reading source…</p>}{(error || preview?.error) && <p role="alert">{error || preview?.error}</p>}
    <div className="ca-picker-scroll">
      {snapshot ? <><small>{snapshot.description}</small>{preview.image_base64 && <img alt={snapshot.title} src={`data:${preview.image_mime_type};base64,${preview.image_base64}`} />}<pre>{snapshot.text}</pre>{snapshot.truncated && <small>Bounded preview; additional content is omitted.</small>}{snapshot.evidence.map((e, i) => <Evidence key={i} evidence={e} />)}</> :
        page?.items.map((item, i) => <button key={i} onClick={() => void read(item.selection)}><strong>{item.title}</strong><small>{item.description}</small></button>)}
      {page?.notices.map((notice, i) => <p key={i}><small>{notice}</small></p>)}
    </div>
    {snapshot && <div className="ca-actions">
      <label>Include <select aria-label="Assistant source inclusion" value={snapshot.selection.inclusion} onChange={e => void read({ ...snapshot.selection, inclusion: e.target.value })}>{(snapshot.selection.source === "plots" ? ["image", "summary"] : snapshot.selection.source === "editor" ? ["text", "selection", "summary"] : snapshot.selection.source === "files" ? ["text", "summary"] : ["objects", "tables"].includes(snapshot.selection.source) ? ["summary", "selection"] : ["summary"]).map(s => <option key={s}>{s}</option>)}</select></label>
      <button className="primary" disabled={loading || !owner.canControl(id)} onClick={() => { try { owner.includeSource(id, preview); close(); } catch (e) { setError(String(e)); } }}>{initial ? "Use refreshed source" : "Add context"}</button>
    </div>}
  </section>;
}
function RunTurn({ summary }: { summary: ComponentAgentRunSummary }) {
  const owner = useComponentAgents(), state = owner.getSnapshot(), run = state.runs.get(summary.run_id);
  const events = state.events.get(summary.run_id) ?? [], tools = state.tools.get(summary.run_id) ?? [];
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function observe() {
      try { await owner.observeRun(summary.run_id); if (!disposed) await Promise.all([owner.observeEvents(summary.run_id), owner.observeTools(summary.run_id)]); }
      catch (e) { if (!disposed) owner.reportError(e); }
      const current = owner.getSnapshot().runs.get(summary.run_id), last = owner.getSnapshot().events.get(summary.run_id)?.at(-1)?.sequence ?? 0;
      if (!disposed && current && (componentBusy(current) || last < current.event_cursor)) timer = setTimeout(observe, 1500);
    }
    void observe(); return () => { disposed = true; clearTimeout(timer); };
  }, [owner, summary.run_id, summary.state]);
  const chunks: string[] = [];
  for (const event of events) if (event.content.kind === "text") chunks.push(event.content.text);
  return <article className="ca-turn" aria-label="Assistant run"><div className="ca-question">{run?.request.text ?? summary.text_excerpt}</div>
    {!!run?.context?.sources.length && <details className="ca-tool"><summary>Sources used for this answer</summary>{run.context.sources.map((source, i) => <div key={i}><strong>{source.title}</strong><small> · {source.description}</small>{source.evidence.map((e, j) => <Evidence key={j} evidence={e} />)}</div>)}</details>}
    <div className="ca-answer">{chunks.join("")}</div>
    {state.historyGap.get(summary.run_id) && <p><small>Earlier streamed text is outside the retained display window. Native receipts remain available below.</small></p>}
    {tools.map(tool => <details key={tool.receipt_id} className="ca-tool"><summary>{tool.capability.replaceAll("_", " ").replaceAll(".", " · ")} · {tool.phase}</summary><pre>{JSON.stringify(tool.result, null, 2)}</pre>{tool.evidence.map((e, i) => <Evidence evidence={e} key={i} />)}</details>)}
    {events.filter(e => e.content.kind === "evidence").map(e => e.content.kind === "evidence" && <Evidence key={e.sequence} evidence={e.content.reference} />)}
    <p><small>{run?.state ?? summary.state}{run && ` · ${run.model_calls}/${run.budget.model_calls} model calls · ${run.tool_calls}/${run.budget.tool_calls} tools`}</small></p>
    {(run?.reason || summary.reason) && <p role="status">{run?.reason ?? summary.reason}</p>}
  </article>;
}
function ComponentConversation({ id, settings }: { id: string; settings(): void }) {
  const owner = useComponentAgents(), state = owner.getSnapshot(), conversation = state.conversations.get(id);
  const draft = state.drafts.get(id), composer = owner.composer(id), history = state.history.get(id);
  const [picker, setPicker] = useState<{ selection: AgentContextSelection | null } | null>(null), [composing, setComposing] = useState(false);
  const editable = owner.canControl(id), pending = state.pending.filter(p => p.request.conversation_id === id);
  const latest = history?.runs[0], run = latest ? state.runs.get(latest.run_id) : undefined;
  const activeRun = conversation?.active_run_id ? state.runs.get(conversation.active_run_id) : undefined;
  const busy = !!conversation?.active_run_id && (!activeRun || componentBusy(activeRun)) || !!run && componentBusy(run);
  const hasImages = composer.sources.some(s => s.source === "plots" && s.inclusion === "image");
  const imageTest = state.diagnostics.find(d => d.kind === "images" && JSON.stringify(d.model) === JSON.stringify(state.settings?.connection));
  const imagesReady = !hasImages || imageTest?.state === "passed";
  const canSend = editable && !busy && !pending.length && !state.submitting.has(id) && !composing && !!draft?.text.trim() && draft.conflict === null && !!state.settings?.enabled && !!state.settings.connection && imagesReady;
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function observe() {
      try { await owner.observeConversation(id); if (!disposed) await owner.observeHistory(id, owner.getSnapshot().history.get(id)?.before ?? null); }
      catch (e) { if (!disposed) owner.reportError(e); }
      if (!disposed) timer = setTimeout(observe, 2000);
    }
    void observe(); return () => { disposed = true; clearTimeout(timer); };
  }, [owner, id]);
  useEffect(() => {
    if (!draft?.dirty || draft.conflict !== null || !editable || composing) return;
    const timer = setTimeout(() => { void owner.flushDraft(id).catch(e => owner.reportError(e)); }, 600);
    return () => clearTimeout(timer);
  }, [id, draft?.revision, draft?.dirty, draft?.conflict, editable, composing, owner]);
  const action = (work: Promise<unknown>) => { void work.catch(e => owner.reportError(e)); };
  if (!conversation) return <p className="ca-meta">Reading conversation…</p>;
  return <>
    <div className="ca-meta">{componentLabels[conversation.profile]}{composer.grant.session && ` · ${composer.grant.session.workspace_instance_id}`}{!editable && " · Controlled by another window"}</div>
    <div className="ca-history">
      {history?.next && <button onClick={() => action(owner.observeHistory(id, history.next))}>Earlier runs</button>}
      {history?.before && <button onClick={() => action(owner.observeHistory(id))}>Latest runs</button>}
      {[...(history?.runs ?? [])].reverse().map(summary => <RunTurn key={summary.run_id} summary={summary} />)}
      {!history?.runs.length && <div className="ca-empty"><Icon name="agent" size={28} /><h2>Ask about {componentLabels[conversation.profile]}</h2><p>{state.settings?.enabled ? "Choose context and describe what you want to understand or change." : "Choose a model to start. Your draft is kept while you configure it."}</p></div>}
    </div>
    <div className="ca-composer">
      {!imagesReady && <div className="ca-actions"><small>Image input is not verified for this model. Test image input in settings, or preview each plot and include its summary.</small><button onClick={settings}>Model settings</button></div>}
      {!editable && <div className="ca-actions"><small>Read-only · Your local draft is retained.</small><button onClick={() => action(owner.takeControl(id))}>Take control</button></div>}
      {draft?.conflict !== null && draft?.conflict !== undefined && <details><summary>Local draft copy kept</summary><pre>{draft.text}</pre><p>Saved draft: {draft.conflict}</p><button disabled={!editable} onClick={() => owner.resolveDraft(id, true)}>Use local copy</button><button onClick={() => owner.resolveDraft(id, false)}>Use saved draft</button></details>}
      {pending.map(p => <div className="ca-actions" key={p.request.request_id}><small>Submission {p.state}. Check its original status before another send.</small><button onClick={() => action(owner.observeSubmission(p.request.request_id))}>Check submission</button>{p.state === "uncertain" && <button disabled={!editable} onClick={() => action(owner.retrySubmission(p.request.request_id))}>Retry original submission</button>}</div>)}
      <div className="ca-sources">{composer.sources.map((source, i) => <span key={i} className="ca-source"><button onClick={() => setPicker({ selection: source })}>{source.label} · {source.inclusion}</button><button aria-label={`Remove ${source.label}`} disabled={!editable || busy} onClick={() => owner.removeSource(id, i)}>×</button></span>)}<button disabled={!editable || busy} onClick={() => setPicker({ selection: null })}>＋ Context</button></div>
      <AgentMessageInput value={draft?.text ?? ""} placeholder="Ask a follow-up…" readOnly={!editable} canSubmit={canSend && !picker} onChange={text => owner.editDraft(id, text)} onCompositionCommit={text => owner.editDraft(id, text)} onComposingChange={setComposing} onSubmit={() => action(owner.send(id))} onEscape={() => setPicker(null)} onMention={() => setPicker({ selection: null })} onPaste={() => {}} />
      <div className="ca-actions"><select aria-label="Assistant mode" value={composer.grant.mode} disabled={!editable || busy} onChange={e => owner.setComposer(id, { ...composer, grant: { ...composer.grant, mode: e.target.value as typeof composer.grant.mode } })}><option value="explain">Explain</option>{["documents", "workspace", "project"].includes(conversation.profile) && <><option value="edit">Edit</option><option value="run">Run</option></>}</select><small>{composer.grant.mode === "explain" ? "Read only" : composer.grant.mode === "edit" ? "Change selected drafts and files" : `Execute in ${composer.grant.session?.workspace_instance_id ?? "no R session selected"}`}</small></div>
      {composer.grant.mode !== "explain" && composer.grant.documents.map((document, i) => <label className="ca-check" key={document.document.document_id}><input type="checkbox" disabled={!editable || busy || !document.path} checked={document.allow_save} onChange={e => owner.setComposer(id, { ...composer, grant: { ...composer.grant, documents: composer.grant.documents.map((d, j) => j === i ? { ...d, allow_save: e.target.checked } : d) } })} /> Allow saving {document.path ?? "untitled draft (choose a path in Editor first)"}</label>)}
      <div className="ca-actions"><button onClick={settings}>{state.settings?.connection?.model ?? "Configure model"}</button><small>{draft?.dirty ? "Saving draft…" : "Draft saved"}</small>{busy ? <button disabled={!editable} onClick={() => action(owner.controlRun(conversation.active_run_id ?? run!.run_id, "stop"))}>Stop</button> : <button className="primary" disabled={!canSend} onClick={() => action(owner.send(id))}>Send</button>}</div>
      {run && ["stopping", "interrupted", "failed", "stopped"].includes(run.state) && <div className="ca-actions"><button disabled={!editable} onClick={() => action(owner.controlRun(run.run_id, "reconcile"))}>Check status</button>{run.recovery && <small>{run.recovery.unresolved_mutations ? "Original actions remain unresolved" : `Original actions checked · Continue uses the original ${run.request.grant.mode} scope`}</small>}{run.recovery && !run.recovery.unresolved_mutations && !componentBusy(run) && <button disabled={!canSend} onClick={() => action(owner.send(id, run.run_id))}>Continue</button>}</div>}
    </div>
    {picker && <SourcePicker key={id} id={id} initial={picker.selection} close={() => setPicker(null)} />}
  </>;
}
export function AgentArea({ viewId }: { viewId: string }) {
  const owner = useComponentAgents(), external = useAgentTasks(), state = owner.getSnapshot(), native = external.getSnapshot();
  const [settings, setSettings] = useState(false), [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    if (!state.assistantVisible) return;
    let disposed = false;
    void Promise.all([owner.observeSettings(), owner.observeConversations()]).then(([, next]) => { if (!disposed) setNext(next ?? null); }).catch(e => { if (!disposed) owner.reportError(e); });
    external.show(viewId); return () => { disposed = true; external.hide(viewId); };
  }, [owner, external, viewId, state.assistantVisible]);
  const select = (id: string) => { setSettings(false); owner.select(id); };
  return <div className="ca-shell"><div className="ca-switch"><button className={state.assistantVisible ? "selected" : ""} onClick={() => owner.showAssistant()}>Rho Assistant</button><button className={!state.assistantVisible ? "selected" : ""} onClick={() => { setSettings(false); owner.showAssistant(false); }}>External tasks</button></div>
    {!state.assistantVisible ? <div className="ca-body"><AgentPanel viewId={viewId} /></div> : <div className="ca-body">
      <aside className="ca-rail" aria-label="Assistant conversations"><h3>Rho Assistant</h3>{[...state.conversations.values()].map(c => <button className={state.selected === c.conversation_id ? "selected" : ""} key={c.conversation_id} onClick={() => select(c.conversation_id)}><strong>{componentLabels[c.profile]}</strong><small>{c.draft.slice(0, 60) || (c.active_run_id ? "Running" : "Conversation")}</small></button>)}{next && <button onClick={() => void owner.observeConversations(next).then(n => setNext(n ?? null)).catch(e => owner.reportError(e))}>More conversations</button>}<h3>External tasks</h3>{native.tasks.map(task => <button key={task.task.task_id} onClick={() => { external.select(task.task.task_id); owner.showAssistant(false); }}><strong>{task.task.title}</strong><small>{task.task.provider} · {task.attachment.state}</small></button>)}</aside>
      <main className="ca-main" aria-label="Rho Assistant">
        <header className="ca-selector"><select aria-label="Assistant conversation" value={state.selected ?? ""} onChange={e => select(e.target.value)}><option value="" disabled>Choose conversation</option>{[...state.conversations.values()].map(c => <option key={c.conversation_id} value={c.conversation_id}>{componentLabels[c.profile]} · {c.draft.slice(0, 32) || new Date(c.created_at_ms).toLocaleTimeString()}</option>)}</select><select aria-label="New assistant conversation" value="" onChange={e => { setSettings(false); void owner.ask(e.target.value as ComponentAgentProfile).catch(error => owner.reportError(error)); }}><option value="">＋ New</option>{Object.entries(componentLabels).map(([profile, label]) => <option key={profile} value={profile}>{label}</option>)}</select><button aria-label="Assistant model settings" onClick={() => setSettings(!settings)}><Icon name="settings" /></button></header>
        {state.error && <div className="at-error" role="alert"><span>{state.error}</span><button onClick={() => owner.clearError()}>Dismiss</button></div>}
        {settings ? <div className="ca-history"><ComponentModelSettingsPanel /></div> : state.selected ? <ComponentConversation key={state.selected} id={state.selected} settings={() => setSettings(true)} /> : <div className="ca-empty"><Icon name="agent" size={28} /><h2>Rho Assistant</h2><p>Start from an Ask action in a component, or choose a new conversation above.</p><button onClick={() => setSettings(true)}>Configure model</button></div>}
      </main>
    </div>}
  </div>;
}
