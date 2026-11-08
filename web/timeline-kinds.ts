import type { GraphEvent } from '../src/work-graph.js';

// The kinds of action a timeline draws, each its own colour; edits and writes are one kind.
// The Graph's timeline and Studio's side timeline use the same words and colours.
export const timelineKinds = [
  { key: 'ask', label: 'Asked', actions: ['ask'] }, { key: 'read', label: 'Read', actions: ['read'] },
  { key: 'edit', label: 'Edited', actions: ['edit', 'write'] }, { key: 'run', label: 'Ran', actions: ['run'] },
  { key: 'changed', label: 'Changed on disk', actions: ['changed'] }, { key: 'capture', label: 'Versions kept', actions: ['capture'] }, { key: 'answer', label: 'Answered', actions: ['answer', 'report'] },
] as const;
export type TimelineKind = typeof timelineKinds[number]['key'];
export const kindOfAction = (action: string): TimelineKind => timelineKinds.find(k => (k.actions as readonly string[]).includes(action))?.key ?? 'read';
export const failed = (e: GraphEvent) => e.outcome === 'failed' || e.outcome === 'rejected' || e.outcome === 'unknown';
export const clock = (ms: number, seconds = false) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' });
export const span = (ms: number) => ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + ' s' : ms < 3600000 ? Math.round(ms / 60000) + ' min' : (ms / 3600000).toFixed(1).replace(/\.0$/, '') + ' h';
// How much of a timeline's length each stretch of work gets. Each is long enough first for its
// steps to be told apart (a short burst of cells beside days of messages stays readable), then the
// rest goes by the square root of how long each lasted.
export function stretchSizes(stretches: ReadonlyArray<{ start: number; end: number }>, steps: ReadonlyArray<{ at: number }>, usable: number, perStep = 10, most = 160) {
  const floors = stretches.map(s => Math.min(most, 24 + perStep * steps.filter(e => e.at >= s.start && e.at <= s.end).length));
  const needed = floors.reduce((a, b) => a + b, 0), scale = needed > usable ? usable / needed : 1, spare = Math.max(0, usable - needed);
  const weights = stretches.map(s => Math.sqrt(s.end - s.start)), total = weights.reduce((a, b) => a + b, 0) || 1;
  return stretches.map((_, i) => floors[i] * scale + spare * weights[i] / total);
}
