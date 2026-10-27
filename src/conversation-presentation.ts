import type { RhoOutput } from './contract.generated.js';

// ACP events are not chat bubbles. This model turns a retained conversation turn
// into the meaning a person reads: prose the Agent wrote, one line per action it
// took, and the few results that need a choice. Technical identity stays behind
// the row's disclosure; nothing here starts or reads an owner.
export type ConversationRead = RhoOutput<'conversation.read'>;
export type ConversationTurn = ConversationRead['turns'][number];
export type ConversationStep = ConversationTurn['steps'][number];
export type SessionObservation = NonNullable<ConversationRead['observation']>;
export type ActivityOutcome = NonNullable<ConversationStep['outcome']>;
export type AgentAction = 'read' | 'edit' | 'write' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'project' | 'agents' | 'plan' | 'other';
export type TargetKind = 'path' | 'command' | 'query' | 'operation' | 'text' | null;

export interface Activity {
  key: string;
  step: ConversationStep;
  action: AgentAction;
  verb: string;
  target: string | null;
  targetKind: TargetKind;
  // The Agent's own human title and the full observed location, shown on demand.
  title: string | null;
  location: string | null;
  outcome: ActivityOutcome;
}
export type Block =
  | { kind: 'text'; key: string; step: ConversationStep; streaming: boolean }
  | { kind: 'error'; key: string; step: ConversationStep }
  | { kind: 'activity'; key: string; activities: Activity[]; running: boolean; summary: string };

const verbs: Record<AgentAction, string> = { read: 'Read', edit: 'Edited', write: 'Wrote', delete: 'Deleted', move: 'Moved', search: 'Searched', execute: 'Ran', fetch: 'Fetched', project: 'Called', agents: 'Used', plan: 'Updated', other: 'Used' };
const byTool: Record<string, AgentAction> = {
  read: 'read', view: 'read', view_image: 'read', notebookread: 'read', bashoutput: 'read',
  edit: 'edit', multiedit: 'edit', notebookedit: 'edit', str_replace_editor: 'edit', apply_patch: 'edit',
  write: 'write', create: 'write',
  delete: 'delete', move: 'move', rename: 'move',
  grep: 'search', glob: 'search', ls: 'search', find: 'search', websearch: 'search',
  webfetch: 'fetch',
  bash: 'execute', shell: 'execute', run: 'execute', killshell: 'execute',
  task: 'agents', agent: 'agents', skill: 'agents', toolsearch: 'agents',
  todowrite: 'plan', todoread: 'plan', enterplanmode: 'plan', exitplanmode: 'plan'
};
const byKind: Record<string, AgentAction> = { read: 'read', edit: 'edit', delete: 'delete', move: 'move', search: 'search', execute: 'execute', fetch: 'fetch', think: 'other', switch_mode: 'other', other: 'other' };
const summaries: Record<AgentAction, [string, string]> = {
  read: ['Read {n} file', 'Read {n} files'], edit: ['Edited {n} file', 'Edited {n} files'], write: ['Wrote {n} file', 'Wrote {n} files'],
  delete: ['Deleted {n} item', 'Deleted {n} items'], move: ['Moved {n} item', 'Moved {n} items'],
  search: ['Searched {n} time', 'Searched {n} times'], execute: ['Ran {n} command', 'Ran {n} commands'],
  fetch: ['Fetched {n} page', 'Fetched {n} pages'], project: ['Used {n} project operation', 'Used {n} project operations'],
  agents: ['Used {n} Agent tool', 'Used {n} Agent tools'], plan: ['Updated the plan', 'Updated the plan {n} times'],
  other: ['Used {n} tool', 'Used {n} tools']
};

const clean = (value: string | undefined | null) => { const text = value?.trim(); return text ? text : null; };
const separator = /[\\/]/;
// The panel names where the work happened without printing an absolute path.
// Paths inside the open project become relative; any other file keeps its last
// two segments. The row's disclosure retains the full observed path.
export function shortPath(value: string, root?: string | null) {
  if (!root) return value.split(separator).filter(Boolean).length > 2 ? '…/' + value.split(separator).filter(Boolean).slice(-2).join('/') : value;
  const base = root.replace(/[\\/]+$/, '');
  if (value === base) return value.split(separator).filter(Boolean).at(-1) ?? value;
  const head = base + (base.includes('\\') ? '\\' : '/');
  if (value.startsWith(head)) return value.slice(head.length);
  const parts = value.split(separator).filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : value;
}
const looksLikePath = (value: string) => separator.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value);
function rhoTool(tool: string, step: ConversationStep): Pick<Activity, 'action' | 'verb' | 'target' | 'targetKind'> | null {
  if (tool === 'mcp__rho__rho_call') return { action: 'project', verb: 'Called', target: clean(step.operation) ?? 'a project operation', targetKind: step.operation ? 'operation' : 'text' };
  if (tool === 'mcp__rho__rho_index') return { action: 'project', verb: 'Looked up', target: 'project operations', targetKind: 'text' };
  if (tool === 'mcp__rho__rho_resolve') return { action: 'project', verb: 'Read', target: 'operation contracts', targetKind: 'text' };
  if (tool === 'mcp__rho__rho_read') return { action: 'project', verb: 'Read', target: 'a kept result', targetKind: 'text' };
  return null;
}

export function toolActivity(step: ConversationStep, location: string | null, root?: string | null, key?: string): Activity {
  const tool = step.tool ?? '';
  const detail = clean(step.detail), rawTitle = clean(step.title);
  // Some Agents repeat the command as the title; do not show it twice.
  const title = rawTitle && rawTitle !== detail ? rawTitle : null;
  const outcome = step.outcome ?? 'requested';
  const special = rhoTool(tool, step);
  if (special) return { key: key ?? step.id ?? tool, step, title, location, outcome, ...special };
  const action = byTool[tool.toLowerCase()] ?? byKind[step.toolKind ?? ''] ?? 'other';
  const verb = tool.toLowerCase() === 'toolsearch' ? 'Found' : tool.toLowerCase() === 'task' ? 'Delegated' : verbs[action];
  const path = action === 'read' || action === 'edit' || action === 'write' || action === 'delete' || action === 'move';
  let target: string | null = null, targetKind: TargetKind = 'text';
  if (tool.toLowerCase() === 'toolsearch') { target = detail ?? title ?? 'Agent tools'; targetKind = detail ? 'query' : 'text'; }
  else if (action === 'project') { target = clean(step.operation) ?? title ?? detail; targetKind = step.operation ? 'operation' : 'text'; }
  else if (path) { target = detail ? shortPath(detail, root) : location ? shortPath(location, root) : title; targetKind = detail || location ? 'path' : 'text'; }
  else if (action === 'execute') { target = detail ?? (title && title.toLowerCase() !== tool.toLowerCase() ? title : null); targetKind = detail ? 'command' : 'text'; }
  else if (action === 'search') { target = detail ?? title; targetKind = detail ? 'query' : 'text'; }
  else if (action === 'fetch') { target = detail ?? title; targetKind = 'text'; }
  else { target = title ?? detail; targetKind = detail && looksLikePath(detail) ? 'path' : 'text'; }
  return { key: key ?? step.id ?? tool + '-' + step.at, step, action, verb, target, targetKind, title, location, outcome };
}

export function activitySummary(activities: Activity[]) {
  const counts = new Map<AgentAction, number>();
  for (const activity of activities) counts.set(activity.action, (counts.get(activity.action) ?? 0) + 1);
  const parts = [...counts].map(([action, n]) => summaries[action][n === 1 ? 0 : 1].replace('{n}', String(n)));
  const refused = activities.filter(a => a.outcome === 'rejected').length, unknown = activities.filter(a => a.outcome === 'unknown').length;
  if (refused) parts.push(refused + ' refused');
  if (unknown) parts.push(unknown + ' with unknown outcome');
  return parts.join(' · ');
}

// Consecutive tool steps form one run; prose and errors stand between runs.
// The Agent's final words never disappear behind an activity disclosure, and a
// run that is still happening is rendered in the open.
export function conversationBlocks(turn: ConversationTurn, observation?: SessionObservation | null, root?: string | null): Block[] {
  const failure = turn.state === 'failed' ? turn.result?.message ?? turn.problem : null;
  const steps = turn.steps.filter(step => !(step.kind === 'error' && step.text === failure) && !(step.kind === 'text' && !step.text?.trim()));
  const locations = new Map<string, string>();
  for (const tool of observation?.tools ?? []) if (tool.id && tool.locations.length) locations.set(tool.id, tool.locations[0].path);
  const blocks: Block[] = [];
  let index = 0;
  for (const step of steps) {
    const key = step.id ?? step.kind + '-' + index;
    const last = blocks.at(-1);
    if (step.kind === 'tool') {
      const activity = toolActivity(step, step.id ? locations.get(step.id) ?? null : null, root, key + '-' + index);
      // A finished turn cannot still be performing a tool; the outcome is unknown.
      if (turn.state !== 'running' && activity.outcome === 'requested') activity.outcome = 'unknown';
      if (last?.kind === 'activity') last.activities.push(activity);
      else blocks.push({ kind: 'activity', key: 'a-' + key, activities: [activity], running: false, summary: '' });
    } else if (step.kind === 'text') {
      // An ACP message identity may appear before and after a tool call; the block
      // position keeps the React key unique across both text steps.
      blocks.push({ kind: 'text', key: 't-' + index + '-' + (step.id ?? ''), step, streaming: turn.state === 'running' && index === steps.length - 1 });
    } else blocks.push({ kind: 'error', key: 'e-' + index, step });
    index++;
  }
  const last = blocks.at(-1);
  if (last?.kind === 'activity' && turn.state === 'running') last.running = true;
  for (const block of blocks) if (block.kind === 'activity') block.summary = activitySummary(block.activities);
  return blocks;
}

// The one plan entry a person needs while the Agent works, if it reported a plan.
export function currentPlanEntry(observation?: SessionObservation | null) {
  const entries = observation?.plan?.entries ?? [];
  return entries.find(entry => entry.status === 'in_progress') ?? entries.find(entry => entry.status === 'pending') ?? null;
}
