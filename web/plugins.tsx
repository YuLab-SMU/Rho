import { useEffect, useRef, useState } from 'react';
import type { CapabilityCatalog, CapabilityPlugin, EntryPresentation } from '../src/browser.js';
import { pluginEntries, pluginGroups, pluginPresentation } from '../src/plugin-presentation.js';
import { Icon } from './icons.js';

function Markers({ presentation }: { presentation?: EntryPresentation }) {
  return <span className="plugin-markers">
    {presentation?.readOnly === true && <span className="plugin-marker">Reads</span>}
    {presentation?.runsCode === true && <span className="plugin-marker">Runs code</span>}
  </span>;
}

interface Problem { installed: boolean; title: string; body: string; about?: CapabilityPlugin }
// A usable plugin shows no state. An unusable one says the first reason and who can change it (U1-06c).
function problem(plugin: CapabilityPlugin, plugins: CapabilityPlugin[], project: string): Problem | null {
  const name = pluginPresentation(plugin).displayName;
  if (!plugin.selected || !plugin.packagePresent) return { installed: false, title: 'Not part of this installation', body: `Rho on this machine was installed without ${name}. Reinstall Rho with the full plugin set to add it.` };
  const needs = (plugin.requires ?? []).flatMap(id => plugins.filter(p => p.id === id));
  if (plugin.state !== 'available') {
    const missing = needs.find(p => p.state !== 'available'), other = missing ? pluginPresentation(missing).displayName : 'another plugin';
    return { installed: true, title: 'Needs ' + other, body: `${name} needs ${other}, which isn't part of this installation. Reinstall Rho with the full plugin set to add it.`, about: missing };
  }
  if (!plugin.projectEnabled) return { installed: true, title: 'Off in ' + project, body: `Claude Code can't use ${name} in this project. Whoever runs Rho can turn it on for this project.` };
  if (!plugin.dependenciesSatisfied) {
    const waiting = needs.find(p => !(p.state === 'available' && p.projectEnabled && p.dependenciesSatisfied)), other = waiting ? pluginPresentation(waiting).displayName : 'another plugin';
    return { installed: true, title: 'Waiting for ' + other, body: `${name} needs ${other}, which ${waiting && !waiting.projectEnabled ? 'is off' : "can't be used yet"} in ${project}.`, about: waiting };
  }
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
    <span className="nav-plugin-symbol" aria-hidden="true"><Icon name="plugins" size={12} stroke={2} /></span><span className="nav-row-name">{pluginPresentation(plugin).displayName}</span>
  </button>;
  return <>
    <div className="project-heading"><strong>Plugins</strong>{catalog && <span>{installed.length} installed on this machine</span>}</div>
    <button className="nav-row" aria-current={!pluginId ? 'page' : undefined} onClick={() => onSelect('')}><Icon name="grid" size={16} stroke={1.8} /><span className="nav-row-name">All plugins</span></button>
    {installed.length > 0 && <><span className="section-label" id="nav-installed">Installed</span>
      <div role="group" aria-labelledby="nav-installed" className="nav-group">{installed.map(row)}</div></>}
    {absent.length > 0 && <><span className="section-label" id="nav-absent">Not installed</span>
      <div role="group" aria-labelledby="nav-absent" className="nav-group">{absent.map(row)}</div></>}
  </>;
}

// How the open project uses a plugin, for Information.
function inProject(plugin: CapabilityPlugin, state: Problem | null) {
  if (!plugin.projectEnabled) return { on: false, text: "Off. Claude Code can't use it in this project." };
  if (state) return { on: false, text: 'On, but ' + state.title.charAt(0).toLowerCase() + state.title.slice(1) + '.' };
  return { on: true, text: 'On. Claude Code can use it in this project.' };
}

export function PluginCatalog({ catalog, project, pluginId, onSelect: setPluginId, back: leave }: {
  catalog: CapabilityCatalog; project: string; pluginId: string; onSelect: (id: string) => void;
  back?: { label: string; run: () => void };
}) {
  const [copied, setCopied] = useState<number | null>(null), [copyError, setCopyError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>()), shown = useRef(pluginId);
  const selected = catalog.plugins.find(p => p.id === pluginId);
  // Opening a plugin focuses its title; returning to the catalog, by any route, focuses the card it came from.
  useEffect(() => {
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
    const views = entries.views.filter(view => view.displayName), use = inProject(selected, state);
    const needs = (selected.requires ?? []).flatMap(id => catalog.plugins.filter(other => other.id === id));
    return <section className="page-section plugin-page plugin-detail">
      {/* Below 768 the sidebar is in the drawer, so the page offers its own way back. */}
      {leave ? <button className="plugin-back" onClick={leave.run}>{leave.label}</button> : <button className="plugin-back narrow-only" onClick={() => setPluginId('')}>All plugins</button>}
      <header className="plugin-detail-heading">
        <span className="plugin-symbol large" aria-hidden="true"><Icon name="plugins" size={28} stroke={1.6} /></span>
        <div className="plugin-detail-title">
          <div><h1 ref={heading} tabIndex={-1}>{p.displayName}</h1>{p.tagline && <p className="plugin-tagline">{p.tagline}</p>}</div>
          <Installed problem={state} />
        </div>
      </header>
      {state && <div className="plugin-notice"><strong>{state.title}</strong><p>{state.body}</p>
        {state.about && <button className="plugin-about" onClick={() => setPluginId(state.about!.id)}><span className="plugin-about-symbol" aria-hidden="true"><Icon name="plugins" size={12} stroke={2} /></span>About {pluginPresentation(state.about).displayName}</button>}
      </div>}
      {p.examplePrompts.length > 0 && <section className="plugin-prompts" aria-labelledby="plugin-prompts-title">
        <h2 id="plugin-prompts-title" className="visually-hidden">Example prompts</h2>
        <ul>{p.examplePrompts.map((prompt, index) => <li key={index}><span>{prompt}</span><button aria-label={'Copy prompt ' + (index + 1)} onClick={() => void copy(prompt, index)}><Icon name="copy" size={13} stroke={1.7} />{copied === index ? 'Copied' : 'Copy'}</button></li>)}</ul>
        <p className="plugin-prompts-note">Copy one and ask Claude Code.</p>
        <p className="plugin-copy-status" role="status">{copyError || (copied !== null ? 'Prompt copied.' : '')}</p>
      </section>}
      <section className="plugin-entry-section" aria-labelledby="plugin-actions-title">
        <h2 id="plugin-actions-title">What Claude Code can do with it</h2>
        <ul>{entries.actions.map(entry => <li key={entry.displayName}>
          <span className="plugin-entry-symbol" aria-hidden="true"><Icon name={entry.runsCode ? 'run' : entry.readOnly ? 'eye' : 'prompt'} size={16} stroke={1.7} /></span>
          <span className="plugin-entry-name">{entry.displayName}</span><Markers presentation={entry} />
        </li>)}</ul>
      </section>
      <section className="plugin-entry-section" aria-labelledby="plugin-views-title">
        <h2 id="plugin-views-title">Views <span className="plugin-count">{views.length}</span></h2>
        <ul>{views.map(view => <li key={view.id}>
          <span className="plugin-entry-symbol" aria-hidden="true"><Icon name="layout" size={16} stroke={1.7} /></span>
          <span className="plugin-entry-name">{view.displayName}</span>{view.ui !== 'available' && <span className="plugin-view-state">Not in this build yet</span>}
        </li>)}</ul>
        <p className="plugin-view-note">{p.viewNote}</p>
      </section>
      <section className="plugin-information" aria-labelledby="plugin-information-title">
        <h2 id="plugin-information-title">Information</h2>
        <dl>
          {state?.installed !== false && <><dt>In {project}</dt><dd className="plugin-use"><span className={'status-dot' + (use.on ? ' live' : '')} />{use.text}</dd></>}
          {needs.length > 0 && <><dt>Works with</dt><dd className="plugin-needs">{needs.map(other => <button key={other.id} onClick={() => setPluginId(other.id)}><span className="plugin-about-symbol" aria-hidden="true"><Icon name="plugins" size={12} stroke={2} /></span>{pluginPresentation(other).displayName}</button>)}</dd></>}
          {p.category && <><dt>Category</dt><dd>{p.category}</dd></>}
          {selected.version && <><dt>Version</dt><dd>{selected.version}</dd></>}
          <dt>Package</dt><dd><code>{selected.package}</code></dd>
        </dl>
      </section>
    </section>;
  }
  const absent = catalog.plugins.filter(p => problem(p, catalog.plugins, project)?.installed === false);
  return <section className="page-section plugin-page">
    <header className="plugin-page-heading"><h1>Plugins</h1><p>Plugins let Claude Code work with your code, data and figures, and let you see that work here.</p></header>
    {/* Plugins that are not part of this installation form their own group, last. */}
    {[...pluginGroups(catalog.plugins.filter(p => !absent.includes(p))), { category: 'Not installed', plugins: absent }].filter(group => group.plugins.length).map(group => <section className="plugin-group" key={group.category}>
      {group.category && <h2>{group.category}</h2>}
      <div className="plugin-grid">{group.plugins.map(plugin => {
        const p = pluginPresentation(plugin), state = problem(plugin, catalog.plugins, project);
        return <button className={'plugin-card' + (state?.installed === false ? ' absent' : '')} key={plugin.id} ref={element => { if (element) cards.current.set(plugin.id, element); else cards.current.delete(plugin.id); }} onClick={() => setPluginId(plugin.id)}>
          <span className="plugin-symbol" aria-hidden="true"><Icon name="plugins" /></span>
          <span className="plugin-card-copy"><strong>{p.displayName}</strong>{state ? <span className="plugin-card-state">{state.title}</span> : <span className="plugin-tagline">{p.tagline}</span>}</span>
          <svg className="plugin-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>;
      })}</div>
    </section>)}
  </section>;
}
