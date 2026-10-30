import type { ConversationTurn } from './conversation-presentation.js';

// The work as it stood at one moment. A replay shows the conversation, the Studio views, the
// commands and the steps from this one cut, so they cannot disagree: a message not yet sent is
// absent, a step that had not ended then is still going, and versions kept, files changed and
// decisions made later are left out. Nothing is inferred that the record does not hold.
const time = (value?: string | null) => value ? Date.parse(value) : NaN;

export function turnAt(turn: ConversationTurn, at: number): ConversationTurn | null {
  if (!(time(turn.sentAt) <= at)) return null;
  if (turn.state !== 'running' && time(turn.endedAt) <= at) return turn;
  const steps = turn.steps.flatMap(step => {
    const began = time(step.startedAt ?? step.at), last = time(step.at);
    if (!(began <= at)) return [];
    if (last <= at) return [step];
    // A tool reported before the moment and finished after it was still going.
    if (step.kind === 'tool') { const { exitCode: _, output: __, ...rest } = step; return [{ ...rest, at: step.startedAt ?? step.at, outcome: 'requested' as const }]; }
    return [];
  });
  const evidence = turn.evidence && {
    ...turn.evidence,
    records: turn.evidence.records
      .map(record => ({ ...record, snapshots: record.snapshots.filter(s => time(s.observedAt) <= at) }))
      .filter(record => record.snapshots.length > 0 || (record.state !== 'captured' && time(record.requestedAt) <= at)),
  };
  const files = (turn as { files?: { changed: Array<{ modifiedAt: string | null }> } }).files;
  return {
    ...turn, state: 'running', endedAt: null, steps,
    ...(evidence ? { evidence } : {}),
    ...(files ? { files: { ...files, changed: files.changed.filter(c => time(c.modifiedAt) <= at) } } : {}),
    decisions: turn.decisions?.filter(d => time(d.at) <= at),
    permissions: turn.permissions?.filter(p => steps.some(s => s.id === p.toolCallId)),
  } as ConversationTurn;
}

export function turnsAt<T extends { turn: ConversationTurn }>(turns: T[], at: number | null): T[] {
  if (at === null) return turns;
  return turns.flatMap(item => { const turn = turnAt(item.turn, at); return turn ? [{ ...item, turn }] : []; });
}
