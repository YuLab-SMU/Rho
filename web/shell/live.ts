import { useEffect, useRef, useState } from 'react';
import type { BrowserClient, CompositionSummary, TaskMapResponse, WorkspaceSnapshot } from '../../src/browser.js';
import { actLive, advanceLive, holdView, liveLimits, releaseView, screenOf, startLive, tickLive, type LiveWorkspace } from '../../src/live-workspace.js';
import type { PersonIntent } from '../../src/expression.js';
import { useRuns } from '../executions.js';

// The live layout and Screen for this tab. The expression rules decide everything; this
// hook only feeds them owner snapshots and the person's intents, and keeps the tab's
// return checkpoint within its 1 MiB budget.
export function useLive(snapshot: WorkspaceSnapshot, composition: CompositionSummary, client: BrowserClient, principal?: string) {
  const { runs, problem, readAgain: readRuns } = useRuns(client, snapshot.project.id, snapshot.cursor);
  // The Agent's declared items, read with the same cursor as everything else it observes.
  const mapAllowed = snapshot.catalog.operations.some(o => o.method === 'task.map.read' && o.authorized && o.state === 'available');
  const [map, setMap] = useState<TaskMapResponse | null>(null), [mapProblem, setMapProblem] = useState('');
  useEffect(() => {
    if (!mapAllowed) return;
    let current = true;
    client.call('task.map.read', { projectId: snapshot.project.id }).then(m => { if (current) { setMap(m); setMapProblem(''); } }, (e: any) => { if (current) setMapProblem("The Agent's declared items could not be read. " + (e?.message ?? '')); });
    return () => { current = false; };
  }, [client, snapshot.project.id, snapshot.cursor, mapAllowed]);
  const key = ['rho-expression/1', snapshot.project.id, composition.compositionId, principal].join(':');
  const state = useRef<LiveWorkspace | null>(null), touched = useRef(false), chosen = useRef<string | null>(null);
  // Who last changed the active view: the person here, or the owners' records (an Agent, a saved layout, the pace).
  const movedBy = useRef<'person' | 'owners'>('owners');
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
      try { const raw = sessionStorage.getItem(key); if (raw && raw.length <= liveLimits.maxCheckpointBytes) { const old = JSON.parse(raw); if (old.format === 1 && old.layout?.compositionId === composition.compositionId) state.current = old; } } catch { /* The owner snapshot stays the baseline. */ }
      if (state.current) { advanceLive(state.current, snapshot, runs, composition, Date.now(), map); actLive(state.current, { kind: 'return' }); }
      else state.current = startLive(snapshot, runs, composition, map);
      // A view the person chose before the records were read is the one held, not the first.
      if (touched.current) holdView(state.current, chosen.current && state.current.layout.views.some(v => v.id === chosen.current) ? chosen.current : state.current.active);
      if (document.hidden) actLive(state.current, { kind: 'leave' });
    } else { const before = state.current.active; advanceLive(state.current, snapshot, runs, composition, Date.now(), map); if (state.current.active !== before) movedBy.current = 'owners'; }
    save(); render(n => n + 1);
  }, [snapshot, composition, runs, map]);
  useEffect(() => {
    const visibility = () => { if (state.current) { actLive(state.current, { kind: document.hidden ? 'leave' : 'return' }); save(); render(n => n + 1); } };
    const away = () => { if (state.current) { actLive(state.current, { kind: 'leave' }); save(); } };
    const interval = setInterval(() => { if (state.current?.expression.pending) { const before = state.current.active; tickLive(state.current, Date.now()); if (state.current.active !== before) movedBy.current = 'owners'; save(); render(n => n + 1); } }, 1000);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', away);
    return () => { away(); clearInterval(interval); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', away); };
  }, [key]);
  const act = (intent: PersonIntent) => { movedBy.current = 'person'; if (state.current) { if (intent.kind === 'unfollow') holdView(state.current, state.current.active); actLive(state.current, intent); save(); render(n => n + 1); } };
  const hold = (id: string) => { touched.current = true; chosen.current = id; movedBy.current = 'person'; if (state.current) { holdView(state.current, id); save(); render(n => n + 1); } };
  const release = (id: string) => { if (state.current) { releaseView(state.current, id); save(); } };
  // A linked result opens beside what the person has: an owner view of that exact version.
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
  return { state: state.current, screen: state.current ? screenOf(state.current) : null, layout: state.current?.layout ?? composition, active: state.current?.active, movedBy: movedBy.current, runs, readRuns, map, act, release, hold, openResource, problem: [problem, mapProblem, checkpointProblem, state.current?.limit].filter(Boolean).join(' · ') };
}
export type Live = ReturnType<typeof useLive>;
