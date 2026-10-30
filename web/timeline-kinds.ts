import type { GraphEvent } from '../src/work-graph.js';

// The kinds of action a timeline draws, each its own colour; edits and writes are one kind.
// The Graph's timeline and Studio's side timeline use the same words and colours.
export const timelineKinds = [
  { key: 'ask', label: 'Asked', actions: ['ask'] }, { key: 'read', label: 'Read', actions: ['read'] },
  { key: 'edit', label: 'Edited', actions: ['edit', 'write'] }, { key: 'run', label: 'Ran', actions: ['run'] },
  { key: 'changed', label: 'Changed on disk', actions: ['changed'] }, { key: 'capture', label: 'Versions kept', actions: ['capture'] }, { key: 'answer', label: 'Answered', actions: ['answer'] },
] as const;
export type TimelineKind = typeof timelineKinds[number]['key'];
export const kindOfAction = (action: string): TimelineKind => timelineKinds.find(k => (k.actions as readonly string[]).includes(action))?.key ?? 'read';
export const failed = (e: GraphEvent) => e.outcome === 'failed' || e.outcome === 'rejected' || e.outcome === 'unknown';
export const clock = (ms: number, seconds = false) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' });
export const span = (ms: number) => ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + ' s' : ms < 3600000 ? Math.round(ms / 60000) + ' min' : (ms / 3600000).toFixed(1).replace(/\.0$/, '') + ' h';
