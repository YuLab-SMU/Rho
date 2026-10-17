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

function notice(plugin: CapabilityPlugin) {
  if (!plugin.selected) return 'Not selected in this build.';
  if (!plugin.packagePresent) return 'The plugin package is missing. Ask the local operator to check this installation.';
  if (plugin.state !== 'available') return plugin.reason ?? 'This plugin is unavailable.';
  if (!plugin.projectEnabled) return 'Off for this project. Ask the local operator to enable it.';
  if (!plugin.dependenciesSatisfied) return 'A required plugin is unavailable in this project.';
  return '';
}

export function PluginCatalog({ catalog }: { catalog: CapabilityCatalog }) {
  const [pluginId, setPluginId] = useState('');
  const [copied, setCopied] = useState<number | null>(null), [copyError, setCopyError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>());
  const selected = catalog.plugins.find(p => p.id === pluginId);
  useEffect(() => {
    setCopied(null); setCopyError('');
    if (pluginId) heading.current?.focus();
  }, [pluginId]);
  function back() {
    setPluginId('');
    requestAnimationFrame(() => cards.current.get(pluginId)?.focus());
  }
  async function copy(prompt: string, index: number) {
    setCopyError(''); setCopied(null);
    try { await navigator.clipboard.writeText(prompt); setCopied(index); }
    catch { setCopyError('Could not copy. Select and copy the prompt text instead.'); }
  }
  if (selected) {
    const p = pluginPresentation(selected), entries = pluginEntries(catalog, selected.id), reason = notice(selected);
    return <section className="page-section plugin-page plugin-detail">
      <button className="plugin-back" onClick={back}>Back to plugins</button>
      <header className="plugin-detail-heading">
        <span className="plugin-symbol" aria-hidden="true"><Icon name="plugins" /></span>
        <div><h1 ref={heading} tabIndex={-1}>{p.displayName}</h1><p className="plugin-tagline">{p.tagline}</p></div>
        <Markers presentation={p} />
      </header>
      {reason && <p className="plugin-notice">{reason}</p>}
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
    {pluginGroups(catalog.plugins).map(group => <section className="plugin-group" key={group.category}>
      {group.category && <h2>{group.category}</h2>}
      <div className="plugin-grid">{group.plugins.map(plugin => {
        const p = pluginPresentation(plugin), reason = notice(plugin);
        return <button className="plugin-card" key={plugin.id} ref={element => { if (element) cards.current.set(plugin.id, element); else cards.current.delete(plugin.id); }} onClick={() => setPluginId(plugin.id)}>
          <span className="plugin-symbol" aria-hidden="true"><Icon name="plugins" /></span>
          <span className="plugin-card-copy"><strong>{p.displayName}</strong><span className="plugin-tagline">{p.tagline}</span>{reason && <small>{reason}</small>}</span>
          <svg className="plugin-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>;
      })}</div>
    </section>)}
  </section>;
}
