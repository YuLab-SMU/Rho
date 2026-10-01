import {useState} from 'react';
import type {ReactNode} from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import './plugin-sidebar.css';

export interface NavigationView {id: string; title: string; plugin: string; contribution: string;}
interface Group {key: string; title: string; contribution: string; views: NavigationView[];}
const preference = 'rho.plugin-window.navigation-expanded';
// Reuse the approved S01–S02 glyphs; these are presentation hints, never a
// capability registry or a request to instantiate a scientific provider.
const icons: Record<string, ReactNode> = {
  files: <path d="M3 6h7l2 2h9v12H3z" />,
  editor: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20" />,
  console: <path d="m5 6 5 6-5 6m9 0h5" />,
  objects: <><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z" /><path d="m3 7 9 5 9-5M12 12v10" /></>,
  plots: <path d="M3 3v18h18M6 16l4-6 5 3 5-8" />,
  packages: <path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v9M8 5l9 5v4" />,
  agent: <><rect x="4" y="6" width="16" height="14" rx="5" /><path d="M12 3v3M2 11v4m20-4v4M9 15h6M9 11h.1M15 11h.1" /></>,
  viewer: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M6 6.5h.1M9 6.5h.1" /></>,
  help: <><path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H3V4Zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h5V4Z" /></>,
  manager: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M17.5 13v9M13 17.5h9" /></>,
  studio: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 13h18M14 3v18" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16m4-11 3 3-3 3" /></>,
};
function Icon({name}: {name: string}) {
  return <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{icons[name] ?? icons.studio}</svg>;
}
function Hint({label, children}: {label: string; children: ReactNode}) {
  return <Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="plugin-navigation-hint" side="right" sideOffset={8}>{label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}

/** Navigation addresses the exact views already retained by this window. It
 * neither opens replacement documents nor activates packages on a click. */
export function PluginSidebar({views, active, focus}: {views: NavigationView[]; active: string | null; focus(id: string): void}) {
  const [expanded, setExpanded] = useState(() => {try {return localStorage.getItem(preference) === 'true';} catch {return false;}});
  const groups = new Map<string, Group>();
  for (const view of views) {
    const key = `${view.plugin}/${view.contribution}`;
    const group = groups.get(key) ?? {key, title: view.title, contribution: view.contribution, views: []};
    group.views.push(view); groups.set(key, group);
  }
  // Familiar modules use the reviewed order. Other contributed views follow in
  // window order; third-party contributions are never omitted from navigation.
  const order = ['files', 'editor', 'console', 'objects', 'plots', 'packages', 'viewer', 'help', 'manager', 'studio'];
  const rank = (group: Group) => group.views[0].plugin === `org.rho.${group.contribution}` && order.includes(group.contribution) ? order.indexOf(group.contribution) : order.length;
  const agent = [...groups.values()].filter(group => group.views[0].plugin === 'org.rho.agent' && group.contribution === 'agent');
  const modules = [...groups.values()].filter(group => !agent.includes(group)).sort((a, b) => rank(a) - rank(b));
  const item = (group: Group) => {
    const selected = group.views.some(view => view.id === active);
    const content = <><Icon name={group.views[0].plugin === `org.rho.${group.contribution}` ? group.contribution : 'studio'} /><span className="plugin-navigation-label">{group.title}</span></>;
    if (group.views.length === 1) return <Hint key={group.key} label={group.title}><button className="plugin-navigation-item" aria-label={group.title} aria-current={selected ? 'true' : undefined} onClick={() => focus(group.views[0].id)}>{content}</button></Hint>;
    return <Menu.Root key={group.key}><Hint label={group.title}><Menu.Trigger asChild><button className="plugin-navigation-item" aria-label={group.title} aria-current={selected ? 'true' : undefined}>{content}<span className="plugin-navigation-count">{group.views.length}</span></button></Menu.Trigger></Hint>
      <Menu.Portal><Menu.Content className="plugin-navigation-menu" side="right" sideOffset={8} collisionPadding={8}>
        <Menu.Label className="plugin-navigation-menu-heading">{group.title}</Menu.Label>
        {group.views.map((view, index) => <Menu.Item key={view.id} onSelect={() => focus(view.id)}>{view.title} {index + 1}{view.id === active && <span aria-label="Current view">✓</span>}</Menu.Item>)}
      </Menu.Content></Menu.Portal>
    </Menu.Root>;
  };
  return <Tooltip.Provider delayDuration={350}><nav className={`plugin-navigation${expanded ? ' is-expanded' : ''}`} aria-label="Workspace navigation">
    <div className="plugin-navigation-modules">{modules.map(item)}</div>
    <div className="plugin-navigation-bottom">{agent.map(item)}
      <Hint label={expanded ? 'Collapse navigation' : 'Expand navigation'}><button className="plugin-navigation-item" aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'} aria-expanded={expanded} onClick={() => {
        const next = !expanded; setExpanded(next); try {localStorage.setItem(preference, String(next));} catch { /* Storage may be disabled; navigation remains usable. */ }
      }}><Icon name="sidebar" /><span className="plugin-navigation-label">Collapse</span></button></Hint>
    </div>
  </nav></Tooltip.Provider>;
}
