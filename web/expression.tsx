import { useEffect, useRef, useState } from 'react';
import type { BrowserClient, CompositionSummary, WorkspaceSnapshot } from '../src/browser.js';
import { actLive, advanceLive, holdView, liveLimits, screenOf, startLive, tickLive, type LiveWorkspace } from '../src/live-workspace.js';
import type { PersonIntent } from '../src/expression.js';
import { useRuns } from './executions.js';
import { executionWord, integrityWord } from '../src/execution-facts.js';
import { ExecutionPanel } from './artifact.js';
import { referenceFor } from '../src/live-trace.js';
import './expression.css';
export function useExpression(snapshot: WorkspaceSnapshot, composition: CompositionSummary, client: BrowserClient, principal?: string) {
  const { runs, problem } = useRuns(client, snapshot.project.id, snapshot.cursor);
  const key = ['rho-expression/1', snapshot.project.id, composition.compositionId, principal].join(':');
  const state = useRef<LiveWorkspace | null>(null), touched = useRef(false);
  const [, render] = useState(0), [checkpointProblem, setCheckpointProblem] = useState('');
  const save = () => {
    if (!state.current || !sessionStorage.getItem('rho.browser.session.v1')) return;
    try {
      const json = JSON.stringify(state.current);
      if (new TextEncoder().encode(json).length > liveLimits.maxCheckpointBytes) throw new Error('The 1 MiB return checkpoint limit was reached. Current views are retained in this tab; reload cannot restore the latest attention state.');
      sessionStorage.setItem(key, json);
    } catch (e: any) { setCheckpointProblem(e.message ?? 'The return checkpoint could not be stored.'); }
  };
  useEffect(() => {
    if (!runs) return;
    if (!state.current) {
      try { const raw = sessionStorage.getItem(key); if (raw && raw.length <= liveLimits.maxCheckpointBytes) { const old = JSON.parse(raw); if (old.format === 1 && old.layout?.compositionId === composition.compositionId) state.current = old; } } catch { /* Current owner snapshot remains the baseline. */ }
      if (state.current) { advanceLive(state.current, snapshot, runs, composition, Date.now()); actLive(state.current, { kind: 'return' }); }
      else state.current = startLive(snapshot, runs, composition);
      if (touched.current) holdView(state.current, state.current.active);
      if (document.hidden) actLive(state.current, { kind: 'leave' });
    } else advanceLive(state.current, snapshot, runs, composition, Date.now());
    save(); render(n => n + 1);
  }, [snapshot, composition, runs]);
  useEffect(() => {
    const visibility = () => { if (state.current) { actLive(state.current, { kind: document.hidden ? 'leave' : 'return' }); save(); render(n => n + 1); } };
    const away = () => { if (state.current) { actLive(state.current, { kind: 'leave' }); save(); } };
    const interval = setInterval(() => { if (state.current?.expression.pending) { tickLive(state.current, Date.now()); save(); render(n => n + 1); } }, 1000);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', away);
    return () => { away(); clearInterval(interval); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', away); };
  }, [key]);
  const act = (intent: PersonIntent) => { if (state.current) { if (intent.kind === 'unfollow') holdView(state.current, state.current.active); actLive(state.current, intent); save(); render(n => n + 1); } };
  const hold = (id: string) => { touched.current = true; if (state.current) { holdView(state.current, id); save(); render(n => n + 1); } };
  const openResource = (ref: { id: string; version: string }) => {
    if (!state.current) return;
    const resource = snapshot.resources.find(r => r.id === ref.id && r.version === ref.version);
    const recorded = snapshot.compositions.flatMap(c => c.views).find(v => Object.values(v.bindings).some(b => 'id' in b && b.id === ref.id && b.version === ref.version));
    const owner = snapshot.catalog.components.find(c => c.id === (resource?.kind === 'table' ? 'rho.table' : 'rho.media'));
    const binding = owner && Object.keys(owner.bindings)[0];
    if (!resource || !recorded && (!owner || !binding)) { setCheckpointProblem('The linked result has no available resource viewer. Its exact reference is retained in the reply.'); return; }
    const id = 'result:' + ref.id.slice(0, 32) + ':' + ref.version.slice(0, 32);
    if (!state.current.layout.views.some(v => v.id === id)) {
      if (state.current.layout.views.length >= liveLimits.maxViews) { setCheckpointProblem('The 64-view limit was reached. The reply and linked result are retained.'); return; }
      const view = recorded ? { ...recorded, id } : { id, component: owner!.id, version: owner!.version, props: { title: resource.path.split('/').at(-1) }, bindings: { [binding!]: ref } };
      state.current.layout = { ...state.current.layout, views: [...state.current.layout.views, view] };
    }
    hold(id);
  };
  return { state: state.current, screen: state.current ? screenOf(state.current) : null, composition: state.current?.layout ?? composition, active: state.current?.active, act, hold, openResource, problem: [problem, checkpointProblem, state.current?.limit].filter(Boolean).join(' · ') };
}
type Expression = ReturnType<typeof useExpression>;
export function ExpressionBar({ expression }: { expression: Expression }) {
  const { state, screen, act } = expression;
  const [evidence, setEvidence] = useState(false);
  if (!screen || !state) return <div className="expression-bar" role="status">Reading workspace observations…{expression.problem}</div>;
  const label = (object: string): string => {
    const item = screen.objects[object];
    return item?.kind === 'question' ? 'Question about ' + label(item.target) : state.names[object] ?? item?.name ?? object;
  };
  const held = state.held[state.active], latest = state.latest.views.find(v => v.id === state.active);
  const oldRef = held && referenceFor(held, state.refs), newRef = latest && referenceFor(latest, state.refs);
  const newer = oldRef?.version && newRef?.artifact === oldRef.artifact && newRef.version !== oldRef.version ? Object.values(latest!.bindings).find(b => 'id' in b && b.version === newRef.version) as { id: string; version: string } | undefined : undefined;
  return <div className="expression-controls">
    <div className="expression-bar" aria-label="Workspace attention">
      <span className="expression-attention" data-attention={screen.attention}>{screen.attention === 'following' ? 'Following Agent' : screen.attention === 'working' ? 'Working · your view stays' : 'Away · changes collected'}</span>
      <button onClick={() => act({ kind: screen.attention === 'following' ? 'unfollow' : 'follow' })}>{screen.attention === 'following' ? 'Work here' : 'Follow Agent'}</button>
      <button onClick={() => act({ kind: screen.attention === 'away' ? 'return' : 'leave' })}>{screen.attention === 'away' ? 'Return' : 'Step away'}</button>
      <button onClick={() => expression.hold(state.active)}>Keep this version</button>
      {newer && <button onClick={() => expression.openResource(newer)}>New version available</button>}
      {screen.agent && <span className="expression-marker" title={label(screen.agent.object)}>Agent: {label(screen.agent.object)}{screen.agent.placement === 'pending' ? ' · waiting for a quiet moment' : ''}</span>}
      <button aria-expanded={evidence} onClick={() => { setEvidence(v => !v); act({ kind: 'reveal', target: evidence ? null : screen.agent?.object ?? 'workspace' }); }}>Recorded evidence</button>
    </div>
    {expression.problem && <p className="expression-notice" role="alert">{expression.problem}</p>}
    {screen.escalations.map(e => <div className="expression-notice" role="status" key={e.object}><button onClick={() => act({ kind: 'open', target: e.object })}>{label(e.object)}</button> · {e.reason}</div>)}
    {screen.suggestions.map(s => <div className="expression-proposal" key={s.id}><span>Agent layout update{ s.merged ? ` · ${s.merged + 1} changes combined` : ''}</span><button onClick={() => act({ kind: 'accept', suggestion: s.id })}>Open update</button><button onClick={() => act({ kind: 'dismiss', suggestion: s.id })}>Dismiss</button></div>)}
    {screen.digest && !evidence && <section className="expression-digest" aria-label="Changes while away"><strong>While you were away · {screen.digest.lines.length} changes</strong><ul>{screen.digest.lines.map((line, i) => <li key={i}>{'object' in line ? <button onClick={() => act({ kind: 'open', target: line.object })}>{label(line.object)}</button> : null} {'state' in line ? line.state : line.kind === 'source' ? `version ${line.from ?? '?'} → ${line.to}` : line.kind === 'artifact' ? `${line.versions} new version(s)` : line.kind === 'suggestion' ? 'Layout update available' : line.kind === 'items' ? `${line.count} declared items changed` : ''}</li>)}</ul><button onClick={() => act({ kind: 'dismiss-digest' })}>Dismiss summary</button></section>}
    {evidence && <section className="expression-evidence" aria-label="Recorded activity"><p>Owner observations and recorded Agent calls. Execution summaries are bounded to the latest 50 runs. Unrecorded adapter actions are unknown.</p>{state.gap && <p role="status">Earlier activity is outside the retained window. No missing calls were reconstructed.</p>}<ol>{state.evidence.map((f, i) => <li key={i}><time>{f.at ? new Date(f.at).toLocaleTimeString() : 'Time not recorded'}</time> <strong>{f.op}</strong> · {f.actor} · {f.object ? label(f.object) : 'Object not recorded'}{f.outcome === 'rejected' ? ` · refused (${f.reason?.kind ?? 'reason not recorded'})` : ''}</li>)}</ol><p>Showing the latest {state.evidence.length} presentation facts (limit {liveLimits.maxEvidence}).</p></section>}
  </div>;
}
export function ExecutionView({ operationId, snapshot, client }: { operationId: string; snapshot: WorkspaceSnapshot; client: BrowserClient }) {
  const { runs, problem, readAgain } = useRuns(client, snapshot.project.id, snapshot.cursor), [open, setOpen] = useState(false);
  const run = runs?.find(r => r.operationId === operationId);
  return <section className="expression-run"><h2>{operationId}</h2>{run ? <><p>{executionWord(run.execution)} · {integrityWord(run.integrity)}</p><p>Domain check: {run.domain === 'checked' ? 'recorded' : 'none recorded'}</p><ul>{run.declared.map(d => <li key={d.path}>{d.path} · {d.present ? `${d.bytes ?? '?'} bytes present` : 'not observed on disk'}</li>)}</ul><button onClick={() => setOpen(true)}>Inspect execution and artifacts</button>{open && <ExecutionPanel run={run} runs={runs!} snapshot={snapshot} onClose={() => setOpen(false)} onReadAgain={readAgain} />}</> : <p>{problem || 'This execution is outside the current observation window.'}</p>}</section>;
}
