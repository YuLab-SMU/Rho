import { useEffect, useRef, useState } from 'react';
import type { BrowserClient } from '../src/browser.js';
import { Icon } from './icons.js';
import type { extensionDirectory } from '../src/extension-directory.js';
import type { InstalledExtension } from '../src/extensions.js';

// The frame shares no origin, storage or credentials with the application. Its
// only application entry is its own plugin's declared operations at this digest.
export function ExtensionView({ client, projectId, plugin, viewId }: { client: BrowserClient; projectId: string; plugin: InstalledExtension; viewId: string }) {
  const frame = useRef<HTMLIFrameElement>(null), [html, setHtml] = useState(''), [error, setError] = useState(''), [attempt, retry] = useState(0);
  // The frame follows the page's own height, within bounds, so a short page is not a tall white box.
  const [height, setHeight] = useState(360);
  useEffect(() => {
    let alive = true; setError(''); setHtml('');
    client.call('extension.content', { projectId, pluginId: plugin.id, expectedDigest: plugin.digest, kind: 'view', entryId: viewId }).then(result => { if (alive) setHtml(result.text as string); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [client, projectId, plugin.id, plugin.digest, viewId, attempt]);
  useEffect(() => {
    if (!html) return;
    const token = crypto.randomUUID(); let active = true, initialized = false, pending = 0;
    const bridge = `<script>(()=>{const token=${JSON.stringify(token)},waiting=new Map();let next=0;window.rho={call:(operation,input={},changeId=crypto.randomUUID())=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{waiting.delete(id);reject(new Error('No reply received. Keep changeId '+changeId+' and observe the original invocation.'))},60000);waiting.set(id,{resolve,reject,timer});parent.postMessage({type:'rho-plugin-call',token,id,operation,input,changeId},'*')})};addEventListener('message',event=>{if(event.source!==parent||event.data?.token!==token||event.data?.type!=='rho-plugin-reply')return;const p=waiting.get(event.data.id);if(!p)return;waiting.delete(event.data.id);clearTimeout(p.timer);event.data.error?p.reject(new Error(event.data.error)):p.resolve(event.data.value)});const size=()=>parent.postMessage({type:'rho-plugin-size',token,height:document.documentElement.scrollHeight},'*');addEventListener('load',size);new ResizeObserver(size).observe(document.documentElement);})();<\/script>`;
    const message = async (event: MessageEvent) => {
      if (!active || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'rho-html-ready' && !initialized) { initialized = true; frame.current?.contentWindow?.postMessage({ type: 'rho-html-page', html: /<head[\s>]/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + bridge) : bridge + html }, '*'); return; }
      const data = event.data;
      if (data?.type === 'rho-plugin-size' && data.token === token) { const wanted = Math.ceil(Number(data.height)); if (Number.isFinite(wanted)) setHeight(Math.min(900, Math.max(200, wanted))); return; }
      if (data?.type !== 'rho-plugin-call' || data.token !== token) return;
      const reply = (result: object) => { if (active) frame.current?.contentWindow?.postMessage({ type: 'rho-plugin-reply', token, id: data.id, ...result }, '*'); };
      if (pending >= 4) { reply({ error: 'This view already has four pending calls. Wait for one to finish.' }); return; }
      pending++;
      try { const value = await client.call('extension.call', { projectId, pluginId: plugin.id, expectedDigest: plugin.digest, operation: data.operation, input: data.input, changeId: data.changeId }); reply({ value }); }
      catch (e) { reply({ error: e instanceof Error ? e.message : String(e) }); }
      finally { pending--; }
    };
    window.addEventListener('message', message); return () => { active = false; window.removeEventListener('message', message); };
  }, [html, client, projectId, plugin.id, plugin.digest, attempt]);
  return <div className="extension-view">{error ? <p role="alert">{error} <button onClick={() => retry(x => x + 1)}>Retry</button></p> : !html ? <p role="status">Opening plugin…</p> : <iframe key={attempt + ':' + plugin.digest} ref={frame} title={plugin.title} src="/extension-frame.html" sandbox="allow-scripts allow-forms" style={{ height }} />}</div>;
}

export function ThirdPartyPlugins({ client, projectId, canManage, query = '' }: { client: BrowserClient; projectId: string; canManage: boolean; query?: string }) {
  const [directory, setDirectory] = useState<typeof extensionDirectory>([]);
  const [plugins, setPlugins] = useState<InstalledExtension[]>([]), [source, setSource] = useState(''), [busy, setBusy] = useState(''), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [opened, setOpened] = useState<{ plugin: InstalledExtension; viewId: string } | null>(null), [skill, setSkill] = useState<{ pluginId: string; title: string; text: string; entryId: string; digest: string } | null>(null);
  const refresh = async () => {
    const result = await client.call('extension.list', { projectId });
    // The small index contains package summaries, not entry manifests. Read each
    // installed descriptor before rendering its entries; listing executes no code.
    const described = await Promise.all(result.plugins.map(p => client.call('extension.describe', { projectId, pluginId: p.id })));
    setPlugins(described as unknown as InstalledExtension[]); setDirectory(result.directory as typeof extensionDirectory);
  };
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [client, projectId]);
  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label); setMessage(''); setError('');
    try { await run(); await refresh(); setMessage(label + ' finished.'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };
  const manage = (p: InstalledExtension, action: 'enable' | 'disable' | 'remove') => act(action === 'remove' ? 'Remove plugin' : action === 'enable' ? 'Enable plugin' : 'Disable plugin', async () => {
    await client.call('extension.manage', { pluginId: p.id, expectedDigest: p.digest, action });
    if (opened?.plugin.id === p.id) setOpened(null);
  });
  const matches = (value: unknown) => JSON.stringify(value).toLowerCase().includes(query.trim().toLowerCase());
  const visible = plugins.filter(matches);
  const read = (plugin: InstalledExtension, entry: InstalledExtension['manifest']['skills'][number]) => act('Read ' + entry.title, async () => {
    const result = await client.call('extension.content', { projectId, pluginId: plugin.id, expectedDigest: plugin.digest, kind: 'skill', entryId: entry.id });
    setSkill({ pluginId: plugin.id, title: entry.title, entryId: entry.id, digest: plugin.digest, text: result.text as string });
  });
  const chips = (p: InstalledExtension) => [{ icon: 'layout' as const, label: p.manifest.views.length ? 'UI' : 'No view', count: p.manifest.views.length || undefined, detail: p.manifest.views.length ? 'HTML pages of its own, each in a frame of its own' : 'No page of its own; your Agent uses it' },
    { icon: 'tool' as const, label: 'MCP tools', count: p.manifest.operations.length, detail: 'Operations an Agent calls through extension.call' }, { icon: 'book' as const, label: 'Skills', count: p.manifest.skills.length, detail: 'Instructions an Agent reads before using it' }];
  return <section className="third-party-plugins" aria-labelledby="third-party-title">
    <header><h2 id="third-party-title">Third-party plugins</h2><p>Independent packages that add tools, Skills and pages of their own. They run native code with your permissions, so choose sources you trust.</p></header>
    {canManage && <form className="plugin-install" onSubmit={e => { e.preventDefault(); void act('Install plugin', async () => { await client.call('extension.install', { source: source.trim() }, AbortSignal.timeout(240000)); setSource(''); }); }}>
      <label htmlFor="plugin-source">Package source</label><div><input id="plugin-source" value={source} onChange={e => setSource(e.target.value)} placeholder="npm package, local folder, .tgz or git+https source" required /><button disabled={!!busy || !source.trim()}>{busy === 'Install plugin' ? 'Installing…' : 'Install plugin'}</button></div>
    </form>}
    <p role="status" className="extension-status">{busy && busy !== 'Install plugin' ? busy + '…' : message}</p>{error && <p role="alert" className="extension-error">{error} <button disabled={!!busy} onClick={() => void act('Refresh plugins', refresh)}>Refresh</button></p>}
    {!plugins.length ? <p className="plugin-empty">No third-party plugin is installed in this Rho.</p> : !visible.length && <p className="plugin-empty">No installed third-party plugins match “{query}”.</p>}
    <div className="extension-list">{visible.map(p => <article key={p.id}>
      <header className="extension-head">
        <span className="extension-mark" aria-hidden="true">{(p.title || p.id).trim().charAt(0).toUpperCase() || '?'}</span>
        <div className="extension-title"><h3>{p.title}</h3><p>{p.description}</p></div>
        <span className={'extension-state' + (p.enabled ? ' on' : '')}><span className={'status-dot' + (p.enabled ? ' live' : '')} />{p.version} · {p.enabled ? 'Enabled' : 'Disabled'}</span>
      </header>
      <span className="plugin-kinds">{chips(p).map(c => <span key={c.label} className={'plugin-kind' + (c.label === 'UI' ? ' plugin-kind-ui' : c.label === 'No view' ? ' plugin-kind-page' : '')} title={c.detail}><Icon name={c.icon} size={12} stroke={1.8} />{c.label}{c.count !== undefined && <span className="plugin-kind-count">{c.count}</span>}</span>)}</span>
      <p className="extension-source">Installed from <code>{p.source}</code></p>
      <div className="extension-actions">
        <button disabled={!!busy || !p.enabled} onClick={() => void act('Open plugin', async () => { const plugin = await client.call('extension.describe', { projectId, pluginId: p.id }) as unknown as InstalledExtension; if (!plugin.manifest.views.length) { setMessage('This plugin has no view. Use its operations from your Agent.'); return; } setOpened({ plugin, viewId: plugin.manifest.views[0].id }); setSkill(null); })}>Open</button>
        {canManage && <><button disabled={!!busy} onClick={() => void act('Update plugin', async () => { await client.call('extension.install', { source: p.source, replace: p.id, expectedDigest: p.digest }, AbortSignal.timeout(240000)); if (opened?.plugin.id === p.id) setOpened(null); })}>Update</button><button disabled={!!busy} onClick={() => void manage(p, p.enabled ? 'disable' : 'enable')}>{p.enabled ? 'Disable' : 'Enable'}</button><button className="danger" disabled={!!busy} onClick={() => void manage(p, 'remove')}>Remove</button></>}
      </div>
      <div className="extension-entry-list">
        <h4>Views <span className="plugin-count">{p.manifest.views.length}</span></h4>
        {!p.manifest.views.length && <p className="plugin-empty">No view is declared.</p>}
        {p.manifest.views.map(view => <div className={'extension-entry' + (opened?.plugin.id === p.id && opened.viewId === view.id ? ' open' : '')} key={view.id}>
          <span className="plugin-entry-symbol" aria-hidden="true"><Icon name="layout" size={16} /></span>
          <span><strong>{view.title}</strong><code>{view.id} · {view.file}</code></span>
          <button disabled={!!busy || !p.enabled} onClick={() => { setOpened({ plugin: p, viewId: view.id }); setSkill(null); }}>Open {view.title}</button>
        </div>)}
        <h4>Skills <span className="plugin-count">{p.manifest.skills.length}</span></h4>
        {!p.manifest.skills.length && <p className="plugin-empty">No Skill is declared.</p>}
        {p.manifest.skills.map(entry => <div className="extension-entry" key={entry.id}>
          <span className="plugin-entry-symbol" aria-hidden="true"><Icon name="document" size={16} /></span>
          <span><strong>{entry.title}</strong><code>{entry.id} · {entry.file}</code></span>
          <button disabled={!!busy || !p.enabled} onClick={() => void read(p, entry)}>Read {entry.title}</button>
        </div>)}
      </div>
      {skill?.pluginId === p.id && <section className="extension-guide"><div className="extension-open-bar"><span><strong>{skill.title}</strong> · <code>{skill.entryId}</code> · package digest <code>{skill.digest.slice(0, 12)}…</code></span><button onClick={() => setSkill(null)}>Close guide</button></div><pre>{skill.text}</pre></section>}
      {opened?.plugin.id === p.id && <section className="extension-open"><div className="extension-open-bar"><span><strong>{opened.plugin.manifest.views.find(v => v.id === opened.viewId)?.title}</strong> · the package’s own page, in a frame that reaches nothing of Rho but this plugin’s operations</span><button onClick={() => setOpened(null)}>Close view</button></div><ExtensionView key={opened.plugin.digest + opened.viewId} {...opened} client={client} projectId={projectId} /></section>}
      <details className="extension-operations"><summary>MCP operations <span className="plugin-count">{p.manifest.operations.length}</span></summary>
        <p>Your Agent reads this package with <code>extension.describe</code> and invokes its declared operations with <code>extension.call</code> through the shared Rho MCP connection.</p>
        {p.manifest.operations.map(operation => <details className="plugin-operation" key={operation.id}><summary>{operation.title} · <code>{operation.id}</code></summary>
          <p>{operation.description}</p><p>Effect: {operation.effect}</p><p>Uses {operation.methods.map(m => <code key={m}>{m} </code>)}</p><pre>{JSON.stringify(operation.inputSchema, null, 2)}</pre>
        </details>)}
      </details>
      <details className="extension-identity"><summary>Package identity</summary><dl><dt>Package</dt><dd>{p.name}</dd><dt>Digest</dt><dd>{p.digest}</dd>{p.sourceCommit && <><dt>Git commit</dt><dd>{p.sourceCommit}</dd></>}</dl></details>
    </article>)}</div>
    {canManage && directory.filter(entry => !plugins.some(p => p.id === entry.id) && matches(entry)).map(entry => <article className="extension-discovery" key={entry.id}><h3>{entry.title} <small>{entry.version}</small></h3><p>{entry.description}</p><p>{entry.needs}</p><div className="extension-actions"><button disabled={!!busy} onClick={() => void act('Install ' + entry.title, () => client.call('extension.install', { source: entry.source }, AbortSignal.timeout(240000)))}>Install {entry.title}</button><a href={entry.repository} target="_blank" rel="noreferrer">Source and documentation ↗</a></div><details><summary>Installation source</summary><p className="extension-source">{entry.source}</p></details></article>)}
    <details className="extension-development"><summary>Develop and contribute a plugin</summary><p>Start with <code>rho plugin create my-plugin</code>, then <code>rho plugin dev ./my-plugin</code>. Rho watches your package and installs valid changes. Reopen its view after an update.</p><p>Build your package, check it with <code>rho plugin check</code>, and share a Git source or npm tarball. You own its repository and releases.</p><a href="https://github.com/YuLab-SMU/Rho/blob/main/docs/THIRD-PARTY-PLUGINS.md" target="_blank" rel="noreferrer">Authoring and contribution guide ↗</a></details>
  </section>;
}
