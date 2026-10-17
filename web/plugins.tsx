import { useEffect, useRef, useState } from 'react';
import type { CapabilityCatalog, CapabilityPlugin, EntryPresentation } from '../src/browser.js';
import { pluginEntries, pluginGroups, pluginPresentation } from '../src/plugin-presentation.js';
import { Icon } from './icons.js';

function Markers({ presentation }: { presentation?: EntryPresentation }) {
  return <span className="plugin-markers">
    {presentation?.readOnly === true && <span className="plugin-marker">Read-only</span>}
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

export function PluginCatalog({ catalog, project, pluginId, onSelect: setPluginId, back: leave }: {
  catalog: CapabilityCatalog; project: string; pluginId: string; onSelect: (id: string) => void;
  back?: { label: string; run: () => void };
}) {
  const [copied, setCopied] = useState<number | null>(null), [copyError, setCopyError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>()), returnTo = useRef('');
  const selected = catalog.plugins.find(p => p.id === pluginId);
  // Opening a plugin focuses its title; going back focuses the card it was opened from.
  useEffect(() => {
    setCopied(null); setCopyError('');
    if (pluginId) heading.current?.focus();
    else if (returnTo.current) { cards.current.get(returnTo.current)?.focus(); returnTo.current = ''; }
  }, [pluginId]);
  function back() { returnTo.current = pluginId; setPluginId(''); }
  async function copy(prompt: string, index: number) {
    setCopyError(''); setCopied(null);
    try { await navigator.clipboard.writeText(prompt); setCopied(index); }
    catch { setCopyError('Could not copy. Select and copy the prompt text instead.'); }
  }
  if (selected) {
    const p = pluginPresentation(selected), entries = pluginEntries(catalog, selected.id), state = problem(selected, catalog.plugins, project);
    return <section className="page-section plugin-page plugin-detail">
      <button className="plugin-back" onClick={leave?.run ?? back}>{leave?.label ?? 'Back to plugins'}</button>
      <header className="plugin-detail-heading">
        <span className="plugin-symbol" aria-hidden="true"><Icon name="plugins" /></span>
        <div><h1 ref={heading} tabIndex={-1}>{p.displayName}</h1><p className="plugin-tagline">{p.tagline}</p></div>
        <Markers presentation={p} />
        <Installed problem={state} />
      </header>
      {state && <div className="plugin-notice"><strong>{state.title}</strong><p>{state.body}</p>
        {state.about && <button className="plugin-about" onClick={() => setPluginId(state.about!.id)}><span className="plugin-about-symbol" aria-hidden="true"><Icon name="plugins" size={12} stroke={2} /></span>About {pluginPresentation(state.about).displayName}</button>}
      </div>}
      {p.examplePrompts.length > 0 && <section className="plugin-prompts" aria-labelledby="plugin-prompts-title">
        <h2 id="plugin-prompts-title">Example prompts</h2>
        <ul>{p.examplePrompts.map((prompt, index) => <li key={index}><span>{prompt}</span><button aria-label={'Copy prompt ' + (index + 1)} onClick={() => void copy(prompt, index)}>{copied === index ? 'Copied' : 'Copy'}</button></li>)}</ul>
        <p className="plugin-copy-status" role="status">{copyError || (copied !== null ? 'Prompt copied.' : '')}</p>
      </section>}
      <section className="plugin-entry-section" aria-labelledby="plugin-actions-title">
        <h2 id="plugin-actions-title">Actions</h2>
        <ul>{entries.actions.map(entry => <li key={entry.displayName}><span>{entry.displayName}</span><Markers presentation={entry} /></li>)}</ul>
      </section>
      <section className="plugin-entry-section" aria-labelledby="plugin-views-title">
        <h2 id="plugin-views-title">Views</h2>
        <ul>{entries.views.filter(view => view.displayName).map(view => <li key={view.id}><span>{view.displayName}</span><Markers presentation={view} />{view.ui !== 'available' && <span className="plugin-view-state">Not in this build yet</span>}</li>)}</ul>
        <p className="plugin-view-note">{p.viewNote}</p>
      </section>
      <section className="plugin-information" aria-labelledby="plugin-information-title">
        <h2 id="plugin-information-title">Information</h2>
        <dl><dt>Category</dt><dd>{p.category}</dd><dt>Version</dt><dd>{selected.version ?? ''}</dd><dt>Package</dt><dd><code>{selected.package}</code></dd></dl>
      </section>
    </section>;
  }
  return <section className="page-section plugin-page">
    <header className="plugin-page-heading"><h1>Plugins</h1></header>
    {/* Plugins that are not part of this installation form their own group, last. */}
    {[...pluginGroups(catalog.plugins.filter(p => problem(p, catalog.plugins, project)?.installed !== false)),
      { category: 'Not installed', plugins: catalog.plugins.filter(p => problem(p, catalog.plugins, project)?.installed === false) }].filter(group => group.plugins.length).map(group => <section className="plugin-group" key={group.category}>
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
