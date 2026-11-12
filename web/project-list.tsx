import { useEffect, useState } from 'react';
import type { BrowserClient, ProjectSummary } from '../src/browser.js';
import { projectHue, projectName } from './home.js';
import { Icon } from './icons.js';
import './project-list.css';

// The sidebar names at most this many projects, the most recently opened, so the tasks and
// files of the open one stay in sight under them.
export const listLimits = { maxProjects: 8, readEveryMs: 5000 };
export type ProjectState = 'working' | 'waiting';
export function initials(project: ProjectSummary) {
  return projectName(project).split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map(w => [...w][0]!.toUpperCase()).join('') || 'P';
}
// Each mark tells its project apart from the others shown: projects whose initials match
// are marked by where their names differ, "swarm-bix18" and "swarm-bix41" as 18 and 41.
export function projectMarks(projects: ProjectSummary[]) {
  const marks = new Map(projects.map(p => [p.id, initials(p)]));
  for (const project of projects) {
    const same = projects.filter(other => other.id !== project.id && initials(other) === initials(project));
    if (!same.length) continue;
    const name = [...projectName(project).toUpperCase()];
    const shared = Math.max(...same.map(other => { const o = [...projectName(other).toUpperCase()]; let i = 0; while (i < name.length && name[i] === o[i]) i++; return i; }));
    const rest = name.slice(shared).filter(c => /[\p{L}\p{N}]/u.test(c));
    if (rest.length) marks.set(project.id, /\p{N}/u.test(rest[0]) ? rest.slice(0, 2).join('') : name[0] + rest[0]);
  }
  return marks;
}
// The projects the sidebar lists: the most recently opened, kept in the order the service lists
// them so a project does not move under the pointer when another one is opened.
export function listedProjects(projects: ProjectSummary[]) {
  const recent = new Set([...projects].sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, listLimits.maxProjects).map(p => p.id));
  return projects.filter(p => recent.has(p.id));
}
// Whether each project's Agent is answering, from its conversations started in Rho: one bounded
// read per project while the page is visible. Reading starts nothing; a project whose list
// cannot be read (a narrower link, an owner that is absent) shows no state rather than a guess.
export function useProjectStates(client: BrowserClient, projects: ProjectSummary[], enabled: boolean) {
  const [states, setStates] = useState<Record<string, ProjectState>>({});
  const ids = projects.map(p => p.id).join(',');
  useEffect(() => {
    if (!enabled || !ids) { setStates({}); return; }
    let live = true;
    const controller = new AbortController();
    const read = async () => {
      if (document.hidden) return;
      const next: Record<string, ProjectState> = {};
      await Promise.all(ids.split(',').map(projectId => client.call('conversation.list', { projectId }, controller.signal)
        .then(list => { if (list.conversations.some(c => c.state === 'running')) next[projectId] = 'working'; }, () => undefined)));
      if (live) setStates(next);
    };
    void read();
    const timer = setInterval(() => void read(), listLimits.readEveryMs);
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, [client, ids, enabled]);
  return states;
}

const stateWords: Record<ProjectState, string> = { working: 'Agent working', waiting: 'Agent needs your choice' };
// The first thing in the sidebar: the projects, each by name, with the one on screen marked and
// a dot on each whose Agent is working. One click goes to another project, where it was left.
// A project leaves the list from its row: a project is a folder, and removing it here leaves the
// folder and everything in it as it is.
export function ProjectList({ projects, total, current, home, states, onHome, onProject, onRemove }: {
  projects: ProjectSummary[]; total: number; current: string | null; home: boolean; states: Record<string, ProjectState>;
  onHome: () => void; onProject: (project: ProjectSummary) => void; onRemove?: (project: ProjectSummary) => void;
}) {
  const marks = projectMarks(projects);
  return <nav className="nav-section nav-projects" aria-label="Projects">
    <div className="nav-heading"><span className="section-label">Projects</span><button className="icon-button nav-add" aria-label="Open or create a project" title="Open or create a project" onClick={onHome}><Icon name="plus" size={15} /></button></div>
    <ul className="nav-group">{projects.map(project => {
      const state = states[project.id], name = projectName(project);
      return <li key={project.id} className={'nav-closing' + (onRemove ? ' closable' : '')}><button className={'nav-row nav-project' + (state ? ' ' + state : '')} aria-label={name + (state ? ' · ' + stateWords[state] : '')} title={name + (state ? ' · ' + stateWords[state] : '')} aria-current={!home && current === project.id ? 'page' : undefined} onClick={() => onProject(project)}>
        <span className={'project-avatar tiny ' + projectHue(project.id + name)} aria-hidden="true">{marks.get(project.id)}</span>
        <span className="nav-row-name">{name}</span>
        {state && <span className={state === 'waiting' ? 'state-dot waiting' : 'pulse-dot'} aria-hidden="true" />}
      </button>
        {onRemove && <button className="icon-button nav-close" aria-label={'Remove ' + name + ' from Rho'} title="Remove from Rho · its folder stays as it is" onClick={() => onRemove(project)}><Icon name="close" size={13} /></button>}
      </li>;
    })}</ul>
    {total > projects.length && <button className="nav-more" onClick={onHome}>All {total} projects</button>}
  </nav>;
}
