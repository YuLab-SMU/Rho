import type { TimelineEvent } from '@rho-workspace/plugin-contracts';

// What plugins say was done, placed on the timeline beside the conversations: each event in the
// lane of whoever did it. The person at this machine has a lane of their own. An Agent's work is
// its conversation's, wherever that conversation was started: by the conversation's principal,
// by the cells a session's own record names, or else under the name of the Agent the person
// connected (Claude Code in a terminal, WorkBuddy), which is a lane like any conversation's.
// Two lanes are left for what no conversation or connected Agent did: the rho command of
// whoever runs the service, and An Agent for callers whose access record is gone. The plugin's
// record says what was done; nothing is inferred.
export const personPrincipal = 'browser:local', operatorPrincipal = 'operator';
export interface SourcedEvent extends TimelineEvent { source: string }
export interface LaneOwner { conversationId: string; principal: string | null; title: string; agent: string; eventKeys?: string[] }
export type Who = 'person' | 'conversation' | 'other';
export interface EventMark {
  key: string; at: number; end: number; lane: string; laneTitle: string; who: Who; agent?: string;
  source: string; action: TimelineEvent['action']; label: string; where: string | null; outcome: TimelineEvent['outcome']; failed: boolean;
}
export const personLane = 'person', operatorLane = 'operator', otherLane = 'other';

export function eventMarks(events: readonly SourcedEvent[], owners: readonly LaneOwner[], now: number): EventMark[] {
  const byPrincipal = new Map(owners.flatMap(o => o.principal ? [[o.principal, o] as const] : []));
  const byEvent = new Map<string, LaneOwner | null>();
  for (const owner of owners) for (const key of owner.eventKeys ?? []) {
    const previous = byEvent.get(key);
    byEvent.set(key, previous === undefined || previous?.conversationId === owner.conversationId ? owner : null);
  }
  return events.flatMap(e => {
    const at = Date.parse(e.startedAt);
    if (!Number.isFinite(at)) return [];
    const ended = e.endedAt ? Date.parse(e.endedAt) : NaN;
    const end = Math.max(at, Number.isFinite(ended) ? ended : e.outcome === 'running' ? now : at);
    const key = e.source + ':' + e.id;
    const owner = e.by === personPrincipal ? null : byEvent.has(key) ? byEvent.get(key) : byPrincipal.get(e.by);
    const who: Who = e.by === personPrincipal ? 'person' : owner ? 'conversation' : 'other';
    return [{ key: e.source + ':' + e.id, at, end, lane: who === 'person' ? personLane : owner ? owner.conversationId : e.by === operatorPrincipal ? operatorLane : otherLane,
      laneTitle: who === 'person' ? 'You' : owner ? owner.title : e.by === operatorPrincipal ? 'rho command' : 'An Agent', who, ...(owner ? { agent: owner.agent } : {}),
      source: e.source, action: e.action, label: e.label, where: e.where, outcome: e.outcome, failed: e.outcome === 'failed' || e.outcome === 'unknown' }];
  }).sort((a, b) => a.at - b.at);
}

// One conversation's share: what its own Agent did, and what the person did from when the
// conversation began, as its Studio shows the person's cells and commands beside its Agent's.
export const conversationMarks = (marks: readonly EventMark[], conversationId: string, since: number) =>
  marks.filter(m => m.lane === conversationId || (m.who === 'person' && m.at >= since));

// A mark in words: who did what, where.
export function markCaption(mark: EventMark) {
  const who = mark.who === 'person' ? 'You' : mark.who === 'conversation' ? mark.agent ?? 'The Agent' : mark.lane === operatorLane ? 'The rho command' : 'An Agent';
  const verb = mark.outcome === 'running' ? (mark.who === 'person' ? 'are running' : 'is running') : 'ran';
  return `${who} ${verb} ${mark.label}${mark.where ? ' · ' + mark.where : ''}`;
}
