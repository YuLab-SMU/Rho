import { useEffect, useMemo, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { agentName } from './agent-now.js';
import { when } from './home.js';
import { Icon } from './icons.js';

// The project's skills as other pages see them: one bounded list read, who made a change and how
// it reads, and the Overview's few newest changes to how work is done here. A skill chosen on
// the Overview is handed to the Skills page, which opens on it.
export type SkillList = RhoOutput<'skills.list'>;
type Change = Pick<RhoOutput<'skills.read'>['changes'][number], 'kind' | 'reason'>;
export const skillsWorkLimits = { changes: 3 };
const browser = 'browser:local';
export const failure = (error: unknown) => error instanceof Error ? error.message : 'It could not be read.';
export const skillTitle = (name: string) => { const words = name.replace(/-/g, ' '); return words.charAt(0).toUpperCase() + words.slice(1); };
export const skillPath = (name: string) => `.claude/skills/${name}/SKILL.md`;

// Who made a change: you, an Agent by its conversation when Rho knows it, or an edit outside Rho.
export type Author = { name: string; conversationId?: string };
export function useAuthor(snapshot: WorkspaceSnapshot) {
  return useMemo(() => {
    const agents = new Map((snapshot.conversations ?? []).filter(c => c.principal).map(c => [c.principal!, { name: agentName(c.client), conversationId: c.conversationId }]));
    return (by: string): Author => by === browser ? { name: 'You' } : by === 'outside' ? { name: 'Outside Rho' } : agents.get(by) ?? { name: 'An Agent' };
  }, [snapshot.conversations]);
}

// A change reads as its reason; what kind of change it was goes with who made it.
export const headline = (change: Change) => change.kind === 'undone' ? 'Undid: ' + change.reason : change.reason;
export const didWhat = (change: Pick<Change, 'kind'>, name: string) => change.kind === 'removed' ? `${name} removed the skill` : change.kind === 'undone' ? `${name} undid a change` : change.kind === 'outside' ? 'Noticed by Rho' : name;

export function useSkillList(client: BrowserClient, projectId: string, cursor: number, enabled = true) {
  const [state, setState] = useState<{ list: SkillList | null; problem: string }>({ list: null, problem: '' });
  const again = () => client.call('skills.list', { projectId }).then(list => setState({ list, problem: '' }), error => setState(s => ({ ...s, problem: failure(error) })));
  useEffect(() => { if (enabled) void again(); }, [client, projectId, cursor, enabled]);
  return { ...state, again };
}

let asked: string | null = null;
export const askSkill = (name: string) => { asked = name; };
export const askedSkill = () => asked;
export const answeredSkill = () => { asked = null; };

export function SkillsWorkSection({ list, problem, snapshot, onOpen }: { list: SkillList | null; problem: string; snapshot: WorkspaceSnapshot; onOpen: () => void }) {
  const author = useAuthor(snapshot);
  const changed = [...(list?.skills ?? []), ...(list?.removed ?? [])].filter(s => s.last).sort((a, b) => b.last!.at.localeCompare(a.last!.at));
  if (!changed.length && !problem) return null;
  const count = list?.skills.length ?? 0;
  return <section className="project-section skills-work" aria-labelledby="skills-work-title">
    <div className="section-heading"><h2 id="skills-work-title">Skills{count > 0 && <span className="section-count">{count}</span>}</h2><button className="text-button" onClick={onOpen}>View all</button></div>
    {problem && <p role="alert">The skills could not be read. {problem}</p>}
    <div className="activity-list">{changed.slice(0, skillsWorkLimits.changes).map(skill => { const last = skill.last!; return <button className="activity-row" key={skill.name} onClick={() => { askSkill(skill.name); onOpen(); }}>
      <span className="activity-symbol"><Icon name="book" size={16} /></span>
      <span className="activity-name"><strong>{last.kind === 'outside' ? 'Changed outside Rho' : headline(last)}</strong>
        <small>{skillTitle(skill.name)} · {last.kind === 'outside' ? '' : didWhat(last, author(last.by).name) + ' · '}{when(last.at).text}</small></span>
      <Icon name="chevron" size={13} />
    </button>; })}</div>
  </section>;
}
