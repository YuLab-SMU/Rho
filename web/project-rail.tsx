import { useEffect, useState, type RefObject } from 'react';
import type { BrowserClient, ProjectSummary } from '../src/browser.js';
import { projectHue, projectName } from './home.js';
import { Icon } from './icons.js';
import './project-rail.css';

// The rail names at most this many projects, the most recently opened, so it never scrolls.
export const railLimits = { maxProjects: 8, readEveryMs: 5000 };
export type ProjectState = 'working' | 'waiting';
export function initials(project: ProjectSummary) {
  return projectName(project).split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map(w => [...w][0]!.toUpperCase()).join('') || 'P';
}
// The projects the rail shows: the most recently opened, kept in the order the service lists
// them so a project does not move under the pointer when another one is opened.
export function railProjects(projects: ProjectSummary[]) {
  const recent = new Set([...projects].sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, railLimits.maxProjects).map(p => p.id));
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
    const timer = setInterval(() => void read(), railLimits.readEveryMs);
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, [client, ids, enabled]);
  return states;
}

const stateWords: Record<ProjectState, string> = { working: 'Agent working', waiting: 'Agent needs your choice' };
// The application's own column: Rho's projects list, each recent project, and this tab's
// connection. A project's own navigation sits beside it.
export function ProjectRail({ projects, current, home, states, onHome, onProject, onAccess, accessOpen, accessTrigger }: {
  projects: ProjectSummary[]; current: string | null; home: boolean; states: Record<string, ProjectState>;
  onHome: () => void; onProject: (project: ProjectSummary) => void; onAccess: () => void; accessOpen: boolean; accessTrigger?: RefObject<HTMLButtonElement | null>;
}) {
  return <nav className="project-rail" aria-label="Projects">
    <button className="rail-home" aria-label="All projects" data-tip="All projects" aria-current={home ? 'page' : undefined} onClick={onHome}><span className="brand-mark" aria-hidden="true">ρ</span></button>
    <ul className="rail-projects">{projects.map(project => {
      const state = states[project.id], label = projectName(project) + (state ? ' · ' + stateWords[state] : '');
      return <li key={project.id}><button className={'rail-project' + (state ? ' ' + state : '')} aria-label={label} data-tip={label} aria-current={!home && current === project.id ? 'page' : undefined} onClick={() => onProject(project)}>
        <span className={'project-avatar ' + projectHue(project.id + projectName(project))} aria-hidden="true">{initials(project)}</span>
        {state && <span className="rail-state" aria-hidden="true" />}
      </button></li>;
    })}</ul>
    <button className="rail-add" aria-label="Open or create a project" data-tip="Open or create a project" onClick={onHome}><Icon name="plus" size={17} /></button>
    <button ref={accessTrigger} className="rail-access" aria-label="Connection & access" data-tip="Connection & access" aria-expanded={accessOpen} onClick={onAccess}><Icon name="signal" size={18} /></button>
  </nav>;
}
