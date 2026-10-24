import { useEffect, useState } from 'react';
import type { BrowserClient, ResourceSummary, WorkspaceSnapshot } from '../src/browser.js';
import { producerOf, type RunFacts } from '../src/execution-facts.js';

// The project's executions, read from the one operation that reports them. Views and
// the project page read the same facts through this cache so they cannot disagree,
// and a bounded age keeps a stale "running" from standing in for a fresh read.
const maxAgeMs = 4000;
const cache = new Map<string, { at: number; runs: RunFacts[] }>();
const inFlight = new Map<string, Promise<RunFacts[]>>();

export function forgetRuns(projectId?: string) {
  if (projectId) cache.delete(projectId); else cache.clear();
  if (projectId) inFlight.delete(projectId); else inFlight.clear();
}

async function read(client: BrowserClient, projectId: string): Promise<RunFacts[]> {
  const pending = inFlight.get(projectId);
  if (pending) return pending;
  const work = client.call('project.runs', { projectId, limit: 50 }, AbortSignal.timeout(30000))
    .then(result => { cache.set(projectId, { at: Date.now(), runs: result.runs }); return result.runs; })
    .finally(() => { inFlight.delete(projectId); });
  inFlight.set(projectId, work);
  return work;
}

export function useRuns(client: BrowserClient, projectId: string | undefined, observationCursor?: number) {
  const [runs, setRuns] = useState<RunFacts[] | null>(() => projectId ? cache.get(projectId)?.runs ?? null : null);
  const [problem, setProblem] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    const held = cache.get(projectId);
    if (held && observationCursor === undefined && Date.now() - held.at < maxAgeMs) { setRuns(held.runs); return; }
    read(client, projectId).then(next => { if (live) { setRuns(next); setProblem(''); } }, (error: unknown) => {
      // The last read stays on screen; the failure is named instead of hidden.
      if (live) setProblem(error instanceof Error ? error.message : 'The executions could not be read.');
    });
    return () => { live = false; };
  }, [client, projectId, nonce, observationCursor]);
  return { runs, problem, readAgain: () => { if (projectId) forgetRuns(projectId); setNonce(value => value + 1); } };
}

// The resource a view is bound to, when it is bound to exactly one.
export function boundResource(view: { bindings?: Record<string, unknown> }, resources: ResourceSummary[]) {
  for (const binding of Object.values(view.bindings ?? {})) {
    const { id, version } = binding as { id?: string; version?: string };
    if (!id) continue;
    const resource = resources.find(entry => entry.id === id && entry.version === version);
    if (resource) return resource;
  }
  return undefined;
}

// Where each registered artifact version is already on screen: the layout and view
// that show it. Opening a sibling artifact means switching to a view that exists,
// not creating one.
export interface Place { compositionId: string; viewId: string }
export function viewPlaces(snapshot: WorkspaceSnapshot) {
  const places = new Map<string, Place>();
  for (const composition of snapshot.compositions) for (const view of composition.views) {
    for (const binding of Object.values(view.bindings ?? {})) {
      const id = (binding as { id?: string })?.id;
      if (id && !places.has(id)) places.set(id, { compositionId: composition.compositionId, viewId: view.id });
    }
  }
  return places;
}

// What a reader needs before trusting one artifact: which execution produced this
// version, how that execution ended, and whether anyone checked the bytes.
export function artifactOrigin(resource: ResourceSummary, runs: RunFacts[] | null) {
  const run = runs ? producerOf(resource, runs) : undefined;
  if (!runs) return { run: undefined, settled: false as const };
  return { run, settled: true as const };
}
