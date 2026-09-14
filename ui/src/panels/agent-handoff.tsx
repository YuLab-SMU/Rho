import { useEffect, useRef, useState } from "react";
import { useAgentHandoffs, useAgentTasks, useNavigation } from "../context";
import { HANDOFF_BODY_BYTES, handoffKey } from "../agent-handoffs";
import { AgentMessageInput } from "./agent-message-input";
import { Icon } from "../icons";
import type { ProjectAgentTaskRef } from "../generated/ProjectAgentTaskRef";
import type { ProjectAgentTaskSummary } from "../generated/ProjectAgentTaskSummary";
import "../agent-handoff.css";

const agentName = (task: ProjectAgentTaskSummary) => task.provider === "codex" ? "Codex" : task.provider === "kimi" ? "Kimi Code" : task.provider === "deepseek" ? "DeepSeek Harness" : "Rho";

export function AgentHandoffPreview({ source }: { source: ProjectAgentTaskRef }) {
  const owner = useAgentHandoffs(), tasks = useAgentTasks(), navigation = useNavigation();
  const entry = owner.editor(source), [composing, setComposing] = useState(false);
  const [targetTasks, setTargetTasks] = useState<readonly ProjectAgentTaskSummary[]>([]), [next, setNext] = useState<string | null>(null), [targetLoading, setTargetLoading] = useState(false), [targetError, setTargetError] = useState("");
  const targetRead = useRef(0), sourceKey = handoffKey(source);
  async function readTargets(before: string | null = null) {
    const read = ++targetRead.current; setTargetLoading(true); setTargetError("");
    try {
      const page = await tasks.readHandoffTargets(before);
      if (targetRead.current !== read || !page) return;
      setTargetTasks(previous => [...new Map([...(before ? previous : []), ...page.tasks].map(task => [handoffKey(task.reference), task])).values()]); setNext(page.next);
    } catch (error) { if (targetRead.current === read) setTargetError(error instanceof Error ? error.message : String(error)); }
    finally { if (targetRead.current === read) setTargetLoading(false); }
  }
  useEffect(() => { void readTargets(); return () => { targetRead.current++; }; }, [tasks, sourceKey]);
  if (!entry) return null;
  const state = tasks.getSnapshot(), sourceTask = state.projectTasks.find(task => handoffKey(task.reference) === handoffKey(source));
  const targets = targetTasks.filter(task => handoffKey(task.reference) !== handoffKey(source));
  const selectedKey = entry.targetRef ? handoffKey(entry.targetRef) : "";
  const locked = !!entry.pending || entry.sending || !!entry.receipt;
  const canAdd = !locked && !entry.loading && !composing && !!entry.observation && !!entry.target?.writable && !!entry.body.trim() && !owner.invalidContext(entry) && tasks.connected;
  const action = (work: Promise<unknown>) => void work.catch(error => tasks.reportError(error));
  const edit = (text: string) => { try { owner.edit(source, text); } catch (error) { tasks.reportError(error); } };
  async function refresh() { await owner.reloadSource(source); if (entry?.targetRef) await owner.selectTarget(source, entry.targetRef); }
  function openTarget() {
    if (!entry?.receipt) return;
    const target = entry.receipt.target;
    owner.close(source);
    if (owner.editor(target)?.open) owner.close(target);
    tasks.chooseTask(target);
  }
  const preview = entry.preview, reference = preview?.selection.reference;
  const operationId = preview?.selection.source === "operations" && reference && typeof reference === "object" && !Array.isArray(reference) && typeof reference.operation_id === "string" ? reference.operation_id : null;
  return <section className="at-handoff" aria-label="Prepare handoff">
    <header className="at-handoff-header"><strong>Prepare handoff</strong><small>{entry.observation?.title ?? sourceTask?.title ?? "Reading source task…"}{sourceTask ? ` · ${agentName(sourceTask)}` : ""}</small></header>
    <div className="at-handoff-body">
      <h2>Transfer the useful context</h2>
      <label className="at-handoff-field">Send context to<select aria-label="Send context to" value={selectedKey} disabled={locked || !tasks.connected} onChange={event => { const task = targets.find(task => handoffKey(task.reference) === event.target.value); if (task) action(owner.selectTarget(source, task.reference)); }}>
        <option value="" disabled>Choose a task in this project</option>
        {entry.targetRef && !targets.some(task => handoffKey(task.reference) === selectedKey) && <option value={selectedKey}>{entry.target?.title ?? "Previously selected task"}</option>}
        {targets.map(task => <option key={handoffKey(task.reference)} value={handoffKey(task.reference)}>{task.title} · {agentName(task)}</option>)}
      </select></label>
      {next && <button className="at-handoff-link" disabled={locked || targetLoading} onClick={() => void readTargets(next)}>Load more project tasks</button>}
      {targetLoading && <p className="at-muted">Reading project tasks…</p>}
      {targetError && <div role="alert"><p>{targetError}</p><button className="at-handoff-link" onClick={() => void readTargets()}>Reload project tasks</button></div>}
      {!targets.length && !next && !targetLoading && !targetError && <p className="at-muted">Create another task in this project to receive the handoff.</p>}
      <div className="at-handoff-field"><span>Handoff draft</span><AgentMessageInput label="Handoff draft" maxLength={HANDOFF_BODY_BYTES} value={entry.body} placeholder={"Goal:\n\nConfirmed:\n\nNext:"} readOnly={locked} canSubmit={false} onChange={edit} onCompositionCommit={edit} onComposingChange={setComposing} onSubmit={() => {}} onEscape={() => {}} onMention={() => {}} onPaste={() => {}} /></div>
      <div className="at-handoff-sources" aria-label="Handoff sources">{entry.context.map((selection, index) => <span className="at-handoff-source" key={index}><button title="Preview original source" onClick={() => action(owner.preview(source, selection))}>{selection.label}</button><button className="at-icon" aria-label={`Remove ${selection.label} from handoff`} disabled={locked} onClick={() => owner.removeContext(source, index)}><Icon name="close" size={12} /></button></span>)}</div>
      {owner.invalidContext(entry) && <p role="alert">Some references are no longer in the source observation. Preview and remove them before adding the handoff.</p>}
      {(entry.preview || entry.previewLoading || entry.previewError) && <section className="at-context-preview at-handoff-preview" aria-label="Handoff source preview"><header><strong>{preview?.title ?? "Source preview"}</strong><button className="at-icon" aria-label="Close handoff source preview" onClick={() => owner.closePreview(source)}><Icon name="close" /></button></header><div className="at-preview-body">
        {entry.previewLoading && <p>Reading the original source…</p>}{entry.previewError && <p role="alert">{entry.previewError}</p>}
        {preview?.image_base64 && <img alt={preview.title} src={`data:${preview.image_mime_type};base64,${preview.image_base64}`} />}
        {!!preview?.columns.length ? <div className="at-table-scroll"><table><thead><tr>{preview.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div> : preview?.text && <pre>{preview.text}</pre>}
        {preview?.truncated && <small className="at-muted">Bounded preview; additional content is omitted.</small>}
        {operationId && <button className="at-handoff-link" onClick={() => navigation.openOperation(operationId)}>Open original operation ↗</button>}
      </div></section>}
      {entry.observation?.notices.map((notice, index) => <p className="at-muted" key={index}>{notice}</p>)}
      {entry.observation?.truncated && <p className="at-muted">This handoff starts from a bounded source observation.</p>}
      {!entry.pending && !entry.receipt && <section className="at-handoff-existing" aria-label="Existing target draft"><small>Already in the target draft</small>
        {entry.loading ? <p>Reading the current draft…</p> : entry.target ? <><p className="at-handoff-text">{entry.target.draft.text || "The target draft is empty."}</p>{!!entry.target.draft.context.length && <small>Existing references: {entry.target.draft.context.map(selection => selection.label).join(" · ")}</small>}{!!entry.target.draft.assets.length && <small>{entry.target.draft.assets.length} existing attachment{entry.target.draft.assets.length === 1 ? "" : "s"} will be kept.</small>}<small>Your handoff will be appended below this text.</small>{!entry.target.writable && <p role="alert">{entry.target.reason ?? "This target is currently read-only."}</p>}</> : <p>{entry.targetRef ? "Reload the target draft before adding the handoff." : "Choose a target task to preview its current draft."}</p>}
      </section>}
      {entry.error && <div className="at-handoff-notice" role="alert"><p>{entry.error}</p>{entry.diagnostic && <details><summary>Details</summary><p>{entry.diagnostic.code}</p><p>{entry.diagnostic.continuation}</p></details>}</div>}
      {!locked && (entry.error || entry.targetRef || !entry.observation) && <button className="at-handoff-link" disabled={entry.loading || !tasks.connected} onClick={() => action(refresh())}>Refresh source and target</button>}
      {entry.pending && <div className="at-handoff-notice" role="status"><strong>Check the handoff receipt</strong><p>The original request is kept until its result is confirmed.</p></div>}
      {entry.receipt && <div className="at-handoff-notice" role="status"><strong>Added to the target draft</strong><p>The target draft is ready for review. Send it when ready.</p><details><summary>Handoff receipt</summary><dl><dt>Request</dt><dd>{entry.receipt.request_id}</dd><dt>Saved draft version</dt><dd>{entry.receipt.target_draft_version}</dd></dl></details></div>}
    </div>
    <footer className="at-handoff-footer"><small>Add to draft, then send when ready.</small><button disabled={entry.sending || entry.checking} onClick={() => owner.close(source)}>{entry.receipt ? "Done" : "Cancel"}</button>
      {entry.receipt ? <button className="primary" onClick={openTarget}>Open target draft</button> : entry.pending ? <><button className="at-button" disabled={entry.sending || entry.checking || !tasks.connected} onClick={() => action(owner.check(source))}>{entry.checking ? "Checking…" : "Check receipt"}</button><button className="at-button" disabled={entry.sending || entry.checking || !tasks.connected} onClick={() => action(owner.retry(source))}>{entry.sending ? "Retrying…" : "Retry original request"}</button></> : <button className="primary" disabled={!canAdd} onClick={() => action(owner.appendToDraft(source))}>{entry.sending ? "Adding…" : "Add to draft"}</button>}
    </footer>
  </section>;
}
