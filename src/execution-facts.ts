import type { RhoOutput } from './contract.generated.js';

// Rho's own reading of what a project actually executed and produced. Nothing here
// interprets the Agent: these are the execution, artifact and check facts the owners
// already keep, turned into the few words a reader needs. The shell draws them; the
// Agent's own account of its work stays in the task map and is never mixed in.
//
// Four facts that used to be shown as one and must stay separate:
//   - the declared output of a plan (what the script said it would write);
//   - the files a run left on disk (present or not, at this moment);
//   - the integrity of those bytes against the producer's completion inventory;
//   - whether a domain check was ever run, which no execution establishes.
export type RunFacts = RhoOutput<'project.runs'>['runs'][number];
export type ResourceFacts = RhoOutput<'observation.snapshot'>['resources'][number];
export type IntegrityState = RunFacts['integrity'];
export type ExecutionState = RunFacts['execution'];

const executionWords: Record<string, string> = {
  completed: 'completed', failed: 'failed', active: 'running', unobserved: 'accepted, not observed',
  unknown: 'outcome unknown'
};
const integrityWords: Record<IntegrityState, string> = {
  verified: 'bytes verified', declared: 'inventory declared', incomplete: 'no complete inventory',
  unchecked: 'not checked', 'not-applicable': 'no artifacts'
};
// A run's state is what the owner observed. `settled` is deliberately not a word
// here: it would turn "the records stopped changing" into "the work succeeded".
export const executionWord = (state: string) => executionWords[state] ?? state;
export const integrityWord = (state: IntegrityState) => integrityWords[state] ?? state;

// What a stop request led to, from Core's own run status and signal record. Accepting a
// request is not a stop: only an ended process is "stopped", and a process that ended on
// its own before any signal was sent finished first, whatever its exit.
export type StopState = NonNullable<RunFacts['stop']>['state'];
export interface CoreExit { Code?: number; Signal?: number }
export interface CoreStatus { Finished?: { exit?: CoreExit | 'Unknown' | null }; NotStarted?: unknown; Gone?: unknown; Detached?: unknown }
export interface CoreCancel { term_sent_at?: unknown; kill_sent_at?: unknown }
export function stopState(status: CoreStatus, cancel?: CoreCancel | null, answered = true): StopState {
  const signalled = !!(cancel?.term_sent_at || cancel?.kill_sent_at);
  // Without a current answer from Core, an earlier "running" proves nothing about the stop.
  if (!answered && !status.Finished && !status.NotStarted) return 'unconfirmed';
  if (status.Finished) {
    const exit = typeof status.Finished.exit === 'object' ? status.Finished.exit : null;
    return !signalled || exit?.Code === 0 ? 'finished-first' : 'stopped';
  }
  if (status.NotStarted) return 'stopped';
  if (status.Gone || status.Detached) return 'unconfirmed';
  return signalled ? 'signalled' : 'requested';
}
export function exitWords(exit: CoreExit | 'Unknown' | null | undefined) {
  if (exit === undefined || exit === null) return null;
  return typeof exit === 'object' && exit.Signal !== undefined ? 'signal ' + exit.Signal : typeof exit === 'object' && exit.Code !== undefined ? 'code ' + exit.Code : 'unknown';
}

export function byId(runs: RunFacts[]) { return new Map(runs.map(run => [run.operationId, run])); }

// The run that produced a registered artifact version, when the owner recorded one.
export function producerOf(resource: ResourceFacts, runs: RunFacts[]) {
  const operationId = (resource.provenance as { operationId?: unknown } | undefined)?.operationId;
  return typeof operationId === 'string' ? runs.find(run => run.operationId === operationId) : undefined;
}

// Submissions of one source file, oldest first, compared by a withheld path key. A
// retry chain is a fact about which file was submitted again; the code digest says
// whether the attempt changed code, so an edited retry never looks like a repeat.
export function sameSourceKey(runs: RunFacts[], key: string | null) {
  return key === null ? [] : runs.filter(run => run.sourceKey === key).sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt));
}
export function distinctScripts(runs: RunFacts[]) { return new Set(runs.map(run => run.script).filter(Boolean)).size; }

// Counts a person can act on. `verifiedRuns` counts runs whose bytes were actually
// checked; a completed run whose artifacts were never checked stays unverified.
export function readRuns(runs: RunFacts[]) {
  const count = (test: (run: RunFacts) => boolean) => runs.filter(test).length;
  return {
    completed: count(run => run.execution === 'completed'),
    failed: count(run => run.execution === 'failed'),
    // Accepted but never observed executing is not running: nothing says it started.
    moving: count(run => run.execution === 'active'),
    unobserved: count(run => run.execution === 'unobserved'),
    unknown: count(run => run.execution === 'unknown')
  };
}

// What is worth the person's attention, in the order they would ask: a failed run
// first, then artifacts nobody checked, then work that stopped without an answer.
export function attention(runs: RunFacts[]) {
  const items: Array<{ kind: 'failed' | 'superseded' | 'unverified' | 'unknown'; text: string; operationId: string }> = [];
  const superseded: typeof items = [];
  for (const run of runs) {
    if (run.execution === 'unknown') { items.push({ kind: 'unknown', operationId: run.operationId, text: `${run.operationId} has no observed outcome` }); continue; }
    if (run.execution !== 'failed') continue;
    const present = run.declared.filter(file => file.present).length;
    const text = run.declared.length ? `${run.operationId} failed; ${present} of ${run.declared.length} declared files are on disk and nothing verified them` : `${run.operationId} failed and wrote no declared file`;
    // A failure the same script completed after keeps its words but no longer leads.
    if (supersededBy(run, runs)) superseded.push({ kind: 'superseded', operationId: run.operationId, text });
    else items.push({ kind: 'failed', operationId: run.operationId, text });
  }
  // Only a run that completed wrote anything to name; a running, unobserved or unknown
  // run has not, and what it wrote is the files actually present, not the declared list.
  for (const run of runs) {
    const present = run.declared.filter(file => file.present).length;
    if (run.execution !== 'completed' || run.integrity === 'verified' || !present) continue;
    items.push({ kind: 'unverified', operationId: run.operationId, text: `${run.operationId} wrote ${present} declared file${present === 1 ? '' : 's'} that nothing verified` });
  }
  return [...items, ...superseded];
}
// The later run of the same script that completed, when there is one: that failure is
// no longer the current state of the work, though it stays one step away.
export function supersededBy(run: RunFacts, runs: RunFacts[]) {
  return run.execution === 'failed' ? sameSourceKey(runs, run.sourceKey).find(other => other.acceptedAt > run.acceptedAt && other.execution === 'completed') : undefined;
}

// The project page shows results, not a dump of every file every run wrote: one row
// per artifact name at the newest submission, with how many earlier versions exist.
// Nothing is hidden — the count is stated, and opening the row opens that exact
// version; the submission chain is one step away in the execution panel.
export interface ResultRow { resource: ResourceFacts; run?: RunFacts; earlier: number }
export function results(resources: ResourceFacts[], runs: RunFacts[]): ResultRow[] {
  const byOperation = byId(runs);
  const groups = new Map<string, ResourceFacts[]>();
  for (const resource of resources) {
    const name = shortPath(resource.path);
    groups.set(name, [...groups.get(name) ?? [], resource]);
  }
  const rows: ResultRow[] = [];
  for (const [name, versions] of groups) {
    const ordered = [...versions].sort((left, right) => {
      const leftAt = byOperation.get(String((left.provenance as { operationId?: unknown } | undefined)?.operationId ?? ''))?.acceptedAt ?? '';
      const rightAt = byOperation.get(String((right.provenance as { operationId?: unknown } | undefined)?.operationId ?? ''))?.acceptedAt ?? '';
      return rightAt.localeCompare(leftAt) || right.version.localeCompare(left.version);
    });
    const newest = ordered[0];
    rows.push({ resource: newest, run: producerOf(newest, runs), earlier: name ? ordered.length - 1 : 0 });
  }
  // Newest first, then by name, so the latest run's results lead.
  return rows.sort((left, right) => (right.run?.acceptedAt ?? '').localeCompare(left.run?.acceptedAt ?? '') || shortPath(left.resource.path).localeCompare(shortPath(right.resource.path)));
}

// A path as a reader names it: the file's own name, with the run's folder dropped.
export function shortPath(value: string) { return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value; }
