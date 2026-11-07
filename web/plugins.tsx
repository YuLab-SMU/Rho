import { ThirdPartyPlugins } from './extensions.js';
import type { BrowserClient } from '../src/browser.js';
import { useLayoutEffect, useRef, useState } from 'react';
import type { CapabilityCatalog, CapabilityPlugin, EntryPresentation } from '../src/browser.js';
import { pluginEntries, pluginGroups, pluginMatches, pluginPresentation } from '../src/plugin-presentation.js';
import { Icon } from './icons.js';
import { PluginMcp, PluginSkill, PluginViews } from './plugin-entries.js';

function Markers({ presentation }: { presentation?: EntryPresentation }) {
  return <span className="plugin-markers">
    {presentation?.readOnly === true && <span className="plugin-marker">Reads</span>}
    {presentation?.runsCode === true && <span className="plugin-marker">Runs code</span>}
  </span>;
}

interface Problem { installed: boolean; title: string; body: string; about?: CapabilityPlugin }
function PluginSymbol({ plugin, size = '' }: { plugin: CapabilityPlugin; size?: string }) {
  const icon = plugin.presentation?.icon;
  return <span className={'plugin-symbol ' + size} aria-hidden="true" style={icon ? { background: icon.background, color: icon.color } : undefined}>
    {icon?.text ? <span className="plugin-symbol-text">{icon.text}</span> : icon?.paths ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {icon.paths.map((d, index) => <path key={index} d={d} />)}{icon.dots?.map(([cx, cy], index) => <circle key={index} cx={cx} cy={cy} r="1.8" fill="currentColor" stroke="none" />)}
    </svg> : <Icon name="plugins" />}
  </span>;
}
// A usable plugin shows no state. An unusable one says the first reason and who can change it (U1-06c).
function problem(plugin: CapabilityPlugin, plugins: CapabilityPlugin[], project: string): Problem | null {
  const name = pluginPresentation(plugin).displayName;
  if (!plugin.selected || !plugin.packagePresent) return { installed: false, title: 'Not part of this installation', body: `Rho on this machine was installed without ${name}. Reinstall Rho with the full plugin set to add it.` };
  const needs = (plugin.requires ?? []).flatMap(id => plugins.filter(p => p.id === id));
  if (plugin.state !== 'available') {
    const missing = needs.find(p => p.state !== 'available'), other = missing ? pluginPresentation(missing).displayName : 'another plugin';
    return { installed: true, title: 'Needs ' + other, body: `${name} needs ${other}, which isn't part of this installation. Reinstall Rho with the full plugin set to add it.`, about: missing };
  }
  if (!plugin.projectEnabled) return { installed: true, title: 'Off in ' + project, body: `Your Agent can't use ${name} in this project. Whoever runs Rho can turn it on for this project.` };
  if (!plugin.dependenciesSatisfied) {
    const waiting = needs.find(p => !(p.state === 'available' && p.projectEnabled && p.dependenciesSatisfied)), other = waiting ? pluginPresentation(waiting).displayName : 'another plugin';
    return { installed: true, title: 'Waiting for ' + other, body: `${name} needs ${other}, which ${waiting && !waiting.projectEnabled ? 'is off' : "can't be used yet"} in ${project}.`, about: waiting };
  }
  if (plugin.nativeAvailability && plugin.nativeAvailability.state !== 'present') return { installed: true, title: plugin.nativeAvailability.title ?? 'External tool availability is unknown', body: plugin.nativeAvailability.body ?? 'Whoever runs Rho can check the selected external tool.' };
  return null;
}
function Installed({ problem }: { problem: Problem | null }) {
  return problem?.installed === false ? <span className="plugin-installed absent">Not installed</span>
    : <span className="plugin-installed"><Icon name="check" size={12} stroke={2} />Installed</span>;
}

// The Plugins sidebar: all plugins, then each plugin of this installation.
export function PluginNavigation({ catalog, pluginId, onSelect }: { catalog?: CapabilityCatalog; pluginId: string; onSelect: (id: string) => void }) {
  const plugins = catalog?.plugins ?? [], installed = plugins.filter(p => p.selected && p.packagePresent), absent = plugins.filter(p => !installed.includes(p));
  const row = (plugin: CapabilityPlugin) => <button key={plugin.id} className="nav-row" aria-current={pluginId === plugin.id ? 'page' : undefined} onClick={() => onSelect(plugin.id)}>
    <PluginSymbol plugin={plugin} size="small" /><span className="nav-row-name">{pluginPresentation(plugin).displayName}</span>
  </button>;
  return <>
    <div className="project-heading"><strong>Plugins</strong>{catalog && <span>{installed.length} built-in plugins</span>}</div>
    <button className="nav-row" aria-current={!pluginId ? 'page' : undefined} onClick={() => onSelect('')}><Icon name="grid" size={16} stroke={1.8} /><span className="nav-row-name">All plugins</span></button>
    {installed.length > 0 && <><span className="section-label" id="nav-installed">Installed</span>
      <div role="group" aria-labelledby="nav-installed" className="nav-group">{installed.map(row)}</div></>}
    {absent.length > 0 && <><span className="section-label" id="nav-absent">Not installed</span>
      <div role="group" aria-labelledby="nav-absent" className="nav-group">{absent.map(row)}</div></>}
  </>;
}

// How the open project uses a plugin, for Information.
function inProject(plugin: CapabilityPlugin, state: Problem | null) {
  if (!plugin.projectEnabled) return { on: false, text: "Off in this project." };
  if (state) return { on: false, text: 'On, but ' + state.title.charAt(0).toLowerCase() + state.title.slice(1) + '.' };
  return { on: true, text: 'On. Each Agent uses the operations its connection grants.' };
}

export function PluginCatalog({ client, projectId, canManage, catalog, project, pluginId, onSelect: setPluginId, back: leave }: {
  client: BrowserClient; projectId: string; canManage: boolean; catalog: CapabilityCatalog; project: string; pluginId: string; onSelect: (id: string) => void;
  back?: { label: string; run: () => void };
}) {
  const [copied, setCopied] = useState<number | null>(null), [copyError, setCopyError] = useState('');
  const [query, setQuery] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>()), shown = useRef(pluginId);
  const selected = catalog.plugins.find(p => p.id === pluginId);
  // Opening a plugin focuses its title; returning to the catalog, by any route, focuses the card it came from.
  useLayoutEffect(() => {
    setCopied(null); setCopyError('');
    if (pluginId) heading.current?.focus();
    else if (shown.current) cards.current.get(shown.current)?.focus();
    shown.current = pluginId;
  }, [pluginId]);
  async function copy(prompt: string, index: number) {
    setCopyError(''); setCopied(null);
    try { await navigator.clipboard.writeText(prompt); setCopied(index); }
    catch { setCopyError('Could not copy. Select and copy the prompt text instead.'); }
  }
  if (selected) {
    const p = pluginPresentation(selected), entries = pluginEntries(catalog, selected.id), state = problem(selected, catalog.plugins, project);
    const use = inProject(selected, state), native = selected.listing?.claudeCode;
    const readSkills = catalog.operations.some(o => o.method === 'skill.read' && o.state === 'available' && o.authorized);
    const jump = (id: string) => { const target = document.getElementById(id); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'start' }); };
    const needs = p.dependencies ?? (selected.requires ?? []).map(pluginId => ({ pluginId, purpose: '' }));
    return <section className="page-section plugin-page plugin-detail">
      {/* Below 768 the sidebar is in the drawer, so the page offers its own way back. */}
      {leave ? <button className="plugin-back" onClick={leave.run}>{leave.label}</button> : <button className="plugin-back" onClick={() => setPluginId('')}>All plugins</button>}
      <header className="plugin-detail-heading">
        <PluginSymbol plugin={selected} size="large" />
        <div className="plugin-detail-title">
          <div><h1 ref={heading} tabIndex={-1}>{p.displayName}</h1>{p.tagline && <p className="plugin-tagline">{p.tagline}</p>}</div>
          <Installed problem={state} />
        </div>
      </header>
      {state && <div className="plugin-notice"><strong>{state.title}</strong><p>{state.body}</p>
        {state.about && <button className="plugin-about" onClick={() => setPluginId(state.about!.id)}><PluginSymbol plugin={state.about} size="small" />About {pluginPresentation(state.about).displayName}</button>}
      </div>}
      <nav className="plugin-sections" aria-label="Plugin entries">
        <button onClick={() => jump('plugin-views-title')}>Views <strong>{entries.views.length}</strong></button>
        <button onClick={() => jump('plugin-skills-title')}>Skills <strong>{entries.skills.length}</strong></button>
        <button onClick={() => jump('plugin-actions-title')}>Operations <strong>{entries.operations.length}</strong></button>
      </nav>
      {p.description && <p className="plugin-description">{p.description}</p>}
      <PluginViews entries={entries} note={p.viewNote} />
      <section className="plugin-entry-section plugin-skills" aria-labelledby="plugin-skills-title">
        <h2 id="plugin-skills-title" tabIndex={-1}>Skills <span className="plugin-count">{entries.skills.length}</span></h2>
        <p className="plugin-section-note">Guidance shipped by this plugin, separate from the Skills your project keeps.</p>
        {!entries.skills.length && <p className="plugin-empty">No Skill is declared by this plugin.</p>}
        <ul>{entries.skills.map(skill => <PluginSkill key={projectId + ':' + skill.id + ':' + skill.digest} skill={skill} client={client} projectId={projectId}
          available={readSkills && (catalog.skills ?? []).some(s => s.id === skill.id && s.digest === skill.digest)} />)}</ul>
        {native && <details className="plugin-native plugin-entry-details"><summary>Claude Code integration</summary>
          <p>This plugin also declares native entries for Claude Code sessions Rho starts.</p>
          {native.skills?.map(s => <p key={s.name}><strong>Skill /{s.name}</strong> · <code>{s.skill}</code><br />{s.description}</p>)}
          {native.hooks?.map((h, i) => <p key={i}><strong>{h.event} hook</strong> · {h.matcher}<br />From <code>{selected.package}{h.entry.slice(1)}</code>{h.timeoutSeconds && ` · ${h.timeoutSeconds} s timeout`}</p>)}
        </details>}
      </section>
      {p.examplePrompts.length > 0 && <section className="plugin-prompts" aria-labelledby="plugin-prompts-title">
        <h2 id="plugin-prompts-title" className="visually-hidden">Example prompts</h2>
        <ul>{p.examplePrompts.map((prompt, index) => <li key={index}><span>{prompt}</span><button aria-label={'Copy prompt ' + (index + 1)} onClick={() => void copy(prompt, index)}><Icon name="copy" size={13} stroke={1.7} />{copied === index ? 'Copied' : 'Copy'}</button></li>)}</ul>
        <p className="plugin-prompts-note">Copy one and ask your Agent.</p>
        <p className="plugin-copy-status" role="status">{copyError || (copied !== null ? 'Prompt copied.' : '')}</p>
      </section>}
      <section className="plugin-entry-section plugin-actions" aria-labelledby="plugin-actions-title">
        <h2 id="plugin-actions-title" tabIndex={-1}>Operations <span className="plugin-count">{entries.operations.length}</span></h2>
        <p className="plugin-section-note">The plugin’s capabilities, grouped by what they do. A connected Agent receives its granted subset.</p>
        <ul>{entries.actions.map(entry => <li key={entry.displayName}>
          <span className="plugin-entry-symbol" aria-hidden="true"><Icon name={entry.runsCode ? 'run' : entry.readOnly ? 'eye' : 'prompt'} size={16} stroke={1.7} /></span>
          <span className="plugin-entry-copy"><span className="plugin-entry-name">{entry.displayName}</span>{entry.description && <span className="plugin-entry-description">{entry.description}</span>}
            <span className="plugin-entry-identity">{entry.identities.map(id => <code key={id}>{id} </code>)}</span>
          </span><Markers presentation={entry} />
        </li>)}</ul>
        <PluginMcp catalog={catalog} entries={entries} />
      </section>
      <section className="plugin-information" aria-labelledby="plugin-information-title">
        <h2 id="plugin-information-title">Information</h2>
        <dl>
          {state?.installed !== false && <><dt>In {project}</dt><dd className="plugin-use"><span className={'status-dot' + (use.on ? ' live' : '')} />{use.text}</dd></>}
          {needs.length > 0 && <><dt>Works with</dt><dd className="plugin-needs">{needs.map(({ pluginId, purpose }) => {
            const other = catalog.plugins.find(plugin => plugin.id === pluginId);
            return other && <span className="plugin-dependency" key={pluginId}><button onClick={() => setPluginId(pluginId)}><PluginSymbol plugin={other} size="small" />{pluginPresentation(other).displayName}</button>{purpose && <span>{purpose}</span>}</span>;
          })}</dd></>}
          {p.uses && <><dt>Uses</dt><dd>{p.uses}</dd></>}
          {p.developer && <><dt>Developer</dt><dd>{p.developer}</dd></>}
          {p.category && <><dt>Category</dt><dd>{p.category}</dd></>}
          {selected.version && <><dt>Capability version</dt><dd>{selected.version}</dd></>}
          {selected.packageVersion && <><dt>Package version</dt><dd>{selected.packageVersion}</dd></>}
          {p.license && <><dt>License</dt><dd>{p.license}</dd></>}
          <dt>Package</dt><dd><code>{selected.package}</code></dd>
          {p.links?.filter(link => { try { return new URL(link.url).protocol === 'https:'; } catch { return false; } }).map(link => <div className="plugin-link-row" key={link.label}><dt>{link.label}</dt><dd><a href={link.url} target="_blank" rel="noreferrer">{link.label}<span aria-hidden="true"> ↗</span></a></dd></div>)}
        </dl>
      </section>
    </section>;
  }
  const visible = catalog.plugins.filter(p => pluginMatches(catalog, p, query));
  const absent = visible.filter(p => problem(p, catalog.plugins, project)?.installed === false);
  const workspaceSkills = (catalog.skills ?? []).filter(s => s.owner === 'rho' && JSON.stringify(s).toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="page-section plugin-page">
    <header className="plugin-page-heading"><h1>Plugins</h1><p>Discover the views, Skills and operations your plugins provide.</p></header>
    <div className="plugin-search"><label htmlFor="plugin-search">Find a plugin or capability</label><input id="plugin-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Try data flow, Markdown, a Skill or an operation name" maxLength={256} /></div>
    {catalog.operations.some(o => o.method === 'extension.list' && o.state === 'available' && o.authorized)
      ? <ThirdPartyPlugins client={client} projectId={projectId} canManage={canManage} query={query} />
      : <p className="plugin-empty">Third-party plugin information is not granted to this tab.</p>}
    {!visible.length && <p className="plugin-empty" role="status">No built-in plugins match “{query}”. <button onClick={() => setQuery('')}>Clear search</button></p>}
    {/* Plugins that are not part of this installation form their own group, last. */}
    {[...pluginGroups(visible.filter(p => !absent.includes(p))), { category: 'Not installed', plugins: absent }].filter(group => group.plugins.length).map(group => <section className="plugin-group" key={group.category}>
      {group.category && <h2>{group.category}</h2>}
      <div className="plugin-grid">{group.plugins.map(plugin => {
        const p = pluginPresentation(plugin), state = problem(plugin, catalog.plugins, project);
        const entries = pluginEntries(catalog, plugin.id);
        return <button className={'plugin-card' + (state?.installed === false ? ' absent' : '')} key={plugin.id} ref={element => { if (element) cards.current.set(plugin.id, element); else cards.current.delete(plugin.id); }} onClick={() => setPluginId(plugin.id)}>
          <PluginSymbol plugin={plugin} />
          <span className="plugin-card-copy"><strong>{p.displayName}</strong>{state ? <span className="plugin-card-state">{state.title}</span> : <span className="plugin-tagline">{p.tagline}</span>}
            <span className="plugin-card-entries">{entries.views.length} views · {entries.skills.length} Skills · {entries.operations.length} operations</span>
          </span>
          <svg className="plugin-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>;
      })}</div>
    </section>)}
    {workspaceSkills.length > 0 && <section className="plugin-entry-section plugin-skills plugin-workspace-skills" aria-labelledby="workspace-skills-title">
      <h2 id="workspace-skills-title">Rho workspace Skills <span className="plugin-count">{workspaceSkills.length}</span></h2>
      <p className="plugin-section-note">Provided by the application for working across plugins. Project Skills are kept separately in your project’s Skills page.</p>
      <ul>{workspaceSkills.map(skill => <PluginSkill key={projectId + ':' + skill.id + ':' + skill.digest} skill={skill} client={client} projectId={projectId}
        available={catalog.operations.some(o => o.method === 'skill.read' && o.state === 'available' && o.authorized)} />)}</ul>
    </section>}
  </section>;
}
