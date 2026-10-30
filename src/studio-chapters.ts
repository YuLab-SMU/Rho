import { toolActivity, type ConversationTurn } from './conversation-presentation.js';

// A message's work in the parts a person would tell it in. The Agent's own words between its
// steps ("Now I'll write the analysis script…") open a part and name it; before any words the
// steps are named by what they did. Inside a part, editing, running and looking again folds
// into rounds. Everything is read from the record: a part says what the steps were, not why.
export interface Round { start: number; end: number; edits: number; runs: number; looks: number }
export interface Chapter {
  id: string; turn: string; start: number; end: number;
  title: string; said: boolean; kind: 'look' | 'explore' | 'build' | 'work' | 'answer';
  steps: number; runs: number; edits: number; rounds: Round[]; files: string[]; notes: string[]; running: boolean;
}
type Kind = 'look' | 'edit' | 'run' | 'refused' | 'other';
interface Step { at: number; kind: Kind; path: string | null }
export const chapterLimits = { titleChars: 90, files: 6 };

// The provider's own failure notices arrive as the Agent's text; they open no part.
const notice = (text: string) => /^\s*(API Error|Error:|Request failed|Overloaded)/i.test(text);
const time = (value?: string | null) => value ? Date.parse(value) : NaN;
const sentence = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim(), first = /^(.+?[.!?。！？])(\s|$)/.exec(line)?.[1] ?? line;
  const clean = first.replace(/[:：]$/, '');
  return clean.length > chapterLimits.titleChars ? clean.slice(0, chapterLimits.titleChars - 1).trimEnd() + '…' : clean;
};
const names = (paths: string[]) => { const shown = [...new Set(paths.map(p => p.split('/').at(-1)!))]; return shown.length > 2 ? shown.slice(0, 2).join(', ') + ' and ' + (shown.length - 2) + ' more' : shown.join(' and '); };

function rounds(steps: Step[]): Round[] {
  const out: Round[] = [];
  let current: Round | null = null, ran = false;
  for (const step of steps) {
    if (step.kind === 'edit' && (!current || ran)) { current = { start: step.at, end: step.at, edits: 0, runs: 0, looks: 0 }; out.push(current); ran = false; }
    if (!current) continue;
    current.end = step.at;
    if (step.kind === 'edit') current.edits++; else if (step.kind === 'run') { current.runs++; ran = true; } else if (step.kind === 'look') current.looks++;
  }
  // Editing and running once is the work itself, not a round of it.
  return out.length > 1 ? out : [];
}

function part(turn: string, index: number, steps: Step[], said: string | null, extra: Partial<Chapter> = {}): Chapter {
  const runs = steps.filter(s => s.kind === 'run').length, edits = steps.filter(s => s.kind === 'edit').length, looks = steps.filter(s => s.kind === 'look');
  const refused = steps.filter(s => s.kind === 'refused').length;
  const kind: Chapter['kind'] = edits ? 'build' : runs ? 'explore' : looks.length ? 'look' : 'work';
  const title = said ? sentence(said)
    : kind === 'look' ? (looks.some(s => s.path) ? 'Read ' + names(looks.flatMap(s => s.path ? [s.path] : [])) : 'Looked at the project')
    : kind === 'explore' ? 'Explored with ' + runs + (runs === 1 ? ' command' : ' commands')
    : kind === 'build' ? 'Edited ' + names(steps.filter(s => s.kind === 'edit').flatMap(s => s.path ? [s.path] : []))
    : 'Worked';
  return {
    id: turn + ':' + index, turn, start: steps[0]?.at ?? NaN, end: steps.at(-1)?.at ?? NaN, title, said: !!said, kind,
    steps: steps.length, runs, edits, rounds: rounds(steps),
    files: [...new Set(steps.flatMap(s => s.path ? [s.path] : []))].slice(0, chapterLimits.files),
    notes: refused ? [refused + ' refused'] : [], running: false, ...extra,
  };
}

export function chapters(turn: ConversationTurn, id: string, root?: string | null): Chapter[] {
  const out: Chapter[] = [];
  const lastTool = turn.steps.reduce((last, s, i) => s.kind === 'tool' ? i : last, -1);
  let open: { said: string | null; at: number; steps: Step[]; notices: number } = { said: null, at: time(turn.startedAt ?? turn.sentAt), steps: [], notices: 0 };
  const close = () => {
    if (!open.steps.length && !open.said) return;
    const steps = open.steps;
    // Before the Agent says anything, what it read first is one part and what it ran after is another.
    if (!open.said) {
      const firstRuns = steps.findIndex((s, i) => s.kind === 'run' && steps[i + 1]?.kind === 'run');
      const lead = firstRuns > 0 ? steps.slice(0, firstRuns) : [];
      if (lead.some(s => s.kind === 'look') && !lead.some(s => s.kind === 'edit')) {
        out.push(part(id, out.length, lead, null, { kind: 'look', title: 'Read ' + names(lead.filter(s => s.kind === 'look').flatMap(s => s.path ? [s.path] : [])) }));
        open.steps = steps.slice(firstRuns);
      }
    }
    if (open.steps.length || open.said) {
      const chapter = part(id, out.length, open.steps, open.said, open.said ? { start: open.at } : {});
      if (open.notices) chapter.notes.push(open.notices + (open.notices === 1 ? ' provider error' : ' provider errors'));
      out.push(chapter);
    }
  };
  turn.steps.forEach((step, index) => {
    const at = time(step.at);
    if (step.kind === 'text') {
      if (index > lastTool) return;
      if (notice(step.text ?? '')) { open.notices++; return; }
      close(); open = { said: step.text ?? '', at, steps: [], notices: 0 };
      return;
    }
    if (step.kind === 'error') { open.notices++; return; }
    const activity = toolActivity(step, null, root);
    const kind: Kind = activity.outcome === 'rejected' ? 'refused' : activity.action === 'read' || activity.action === 'search' ? 'look'
      : activity.action === 'edit' || activity.action === 'write' ? 'edit' : activity.action === 'execute' ? 'run' : 'other';
    const path = activity.targetKind === 'path' && activity.target ? activity.target : null;
    open.steps.push({ at: time(step.startedAt ?? step.at), kind, path });
  });
  close();
  const answer = turn.steps.slice(lastTool + 1).filter(s => s.kind === 'text' && !notice(s.text ?? ''));
  if (answer.length && turn.state !== 'running') out.push({ ...part(id, out.length, [], null), kind: 'answer', title: 'Answered', start: time(answer[0].at), end: time(answer.at(-1)!.at) });
  if (turn.state === 'running' && out.length) out.at(-1)!.running = true;
  return out;
}
