import { useState } from 'react';
import type { BrowserClient } from '../src/browser.js';
import type { ExtensionMarket, MarketEntry, MarketChange } from '../src/extension-markets.js';
import type { InstalledExtension } from '../src/extensions.js';
import './extension-markets.css';

export function ExtensionMarkets({ client, markets, installed, canManage, query, changed }: {
  client: BrowserClient; markets: ExtensionMarket[]; installed: InstalledExtension[];
  canManage: boolean; query: string; changed: () => Promise<void>;
}) {
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const act = async (label: string, run: () => Promise<void>) => {
    setBusy(label); setError(''); setMessage('');
    try { await run(); await changed(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };
  const configure = (input: MarketChange, label: string) => act(label, async () => {
    const result = await client.call('extension.market.change', input);
    if (input.action === 'add') { setUrl(''); setMessage('Market added. Search its plugins above.'); }
    else if (input.action === 'remove') setMessage('Market removed. Installed plugins are kept.');
    else setMessage(result.markets.find(m => m.id === input.id)?.error ? 'Refresh failed. The last successful index is still available.' : 'Market refreshed.');
  });
  const install = (market: ExtensionMarket, entry: MarketEntry) => act('Installing ' + entry.title + '…', async () => {
    const previous = installed.find(p => p.id === entry.id);
    await client.call('extension.install', { source: entry.source, market: { id: market.id, expectedDigest: market.digest, pluginId: entry.id }, ...(previous ? { replace: previous.id, expectedDigest: previous.digest } : {}) }, AbortSignal.timeout(240000));
    setMessage(entry.title + ' ' + entry.version + ' installed.');
  });
  const matches = (entry: MarketEntry, market: ExtensionMarket) => JSON.stringify([entry, market.title]).toLowerCase().includes(query.trim().toLowerCase());
  const entries = markets.flatMap(market => market.plugins.filter(entry => matches(entry, market) && !installed.some(p => p.id === entry.id && p.version === entry.version)).map(entry => ({ market, entry })));
  return <section className="extension-markets" aria-label="Remote plugin markets">
    <details open={!markets.length}>
      <summary>Plugin markets <span>({markets.length})</span></summary>
      <p>Add a market index to find plugins from another publisher. Refresh reads its latest directory; installation is a separate action.</p>
      {canManage && <form onSubmit={event => { event.preventDefault(); void configure({ action: 'add', url: url.trim() }, 'Reading market…'); }}>
        <label htmlFor="market-url">Market index URL</label>
        <div className="market-input"><input id="market-url" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://publisher.example/rho-plugins.json" required /><button disabled={!!busy || !url.trim()}>Add market</button></div>
      </form>}
      {markets.map(market => <article className="market-source" key={market.id} data-market-id={market.id}>
        <div className="market-heading"><strong>{market.title}</strong><span>{market.plugins.length} {market.plugins.length === 1 ? 'plugin' : 'plugins'}</span></div>
        <a href={market.url} target="_blank" rel="noreferrer">{market.url}</a>
        <p>Last successful refresh: {new Date(market.fetchedAt).toLocaleString()}</p>
        {market.error && <p className="market-cached" role="status">Refresh failed: {market.error} Showing the saved index.</p>}
        {canManage && <div className="market-actions"><button disabled={!!busy} onClick={() => void configure({ action: 'refresh', id: market.id, expectedRevision: market.revision }, 'Refreshing market…')}>Refresh {market.title}</button><button disabled={!!busy} onClick={() => void configure({ action: 'remove', id: market.id, expectedRevision: market.revision }, 'Removing market…')}>Remove {market.title}</button></div>}
      </article>)}
    </details>
    {(busy || message) && <p role="status">{busy || message}</p>}
    {error && <p className="market-error" role="alert">{error} <button onClick={() => void changed()}>Reload list</button></p>}
    {markets.length > 0 && entries.length > 0 && <div className="market-results"><h3>From your markets</h3>{entries.map(({ market, entry }) => <article className="market-entry" key={market.id + ':' + entry.id} data-market-entry={entry.id}>
      <div className="market-heading"><h4>{entry.title}</h4><span>{entry.version}</span></div><p>{entry.description}</p>
      <p className="market-origin">From {market.title}{market.error ? ' · saved index, last refresh failed' : ''}</p><p>{entry.needs}</p>
      <div className="market-actions">{canManage && <button disabled={!!busy} onClick={() => void install(market, entry)}>{installed.some(p => p.id === entry.id) ? 'Replace with ' : 'Install '}{entry.title} {entry.version}</button>}<a href={entry.repository} target="_blank" rel="noreferrer">Source and documentation ↗</a></div>
      <details><summary>Installation source</summary><code>{entry.source}</code></details>
    </article>)}</div>}
    {query.trim() && markets.length > 0 && !entries.length && !installed.some(p => markets.some(m => m.plugins.some(e => e.id === p.id && e.version === p.version && matches(e, m)))) && <p>No plugins in your markets match “{query}”.</p>}
  </section>;
}
