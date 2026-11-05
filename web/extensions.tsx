import { useEffect, useRef, useState } from 'react';
import type { BrowserClient } from '../src/browser.js';
import type { extensionDirectory } from '../src/extension-directory.js';
import type { InstalledExtension } from '../src/extensions.js';

// The frame shares no origin, storage or credentials with the application. Its
// only application entry is its own plugin's declared operations at this digest.
export function ExtensionView({ client, projectId, plugin, viewId }: { client: BrowserClient; projectId: string; plugin: InstalledExtension; viewId: string }) {
  const frame = useRef<HTMLIFrameElement>(null), [html, setHtml] = useState(''), [error, setError] = useState(''), [attempt, retry] = useState(0);
  useEffect(() => {
    let alive = true; setError(''); setHtml('');
    client.call('extension.content', { projectId, pluginId: plugin.id, expectedDigest: plugin.digest, kind: 'view', entryId: viewId }).then(result => { if (alive) setHtml(result.text as string); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [client, projectId, plugin.id, plugin.digest, viewId, attempt]);
  useEffect(() => {
    if (!html) return;
    const token = crypto.randomUUID(); let active = true, initialized = false, pending = 0;
    const bridge = `<script>(()=>{const token=${JSON.stringify(token)},waiting=new Map();let next=0;window.rho={call:(operation,input={},changeId=crypto.randomUUID())=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{waiting.delete(id);reject(new Error('No reply received. Keep changeId '+changeId+' and observe the original invocation.'))},60000);waiting.set(id,{resolve,reject,timer});parent.postMessage({type:'rho-plugin-call',token,id,operation,input,changeId},'*')})};addEventListener('message',event=>{if(event.source!==parent||event.data?.token!==token||event.data?.type!=='rho-plugin-reply')return;const p=waiting.get(event.data.id);if(!p)return;waiting.delete(event.data.id);clearTimeout(p.timer);event.data.error?p.reject(new Error(event.data.error)):p.resolve(event.data.value)});})();<\/script>`;
    const message = async (event: MessageEvent) => {
      if (!active || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'rho-html-ready' && !initialized) { initialized = true; frame.current?.contentWindow?.postMessage({ type: 'rho-html-page', html: /<head[\s>]/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + bridge) : bridge + html }, '*'); return; }
      const data = event.data;
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
  return <div className="extension-view">{error ? <p role="alert">{error} <button onClick={() => retry(x => x + 1)}>Retry</button></p> : !html ? <p role="status">Opening plugin…</p> : <iframe key={attempt + ':' + plugin.digest} ref={frame} title={plugin.title} src="/extension-frame.html" sandbox="allow-scripts allow-forms" />}</div>;
}

export function ThirdPartyPlugins({ client, projectId, canManage }: { client: BrowserClient; projectId: string; canManage: boolean }) {
  const [directory, setDirectory] = useState<typeof extensionDirectory>([]);
  const [plugins, setPlugins] = useState<InstalledExtension[]>([]), [source, setSource] = useState(''), [busy, setBusy] = useState(''), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [opened, setOpened] = useState<{ plugin: InstalledExtension; viewId: string } | null>(null), [skill, setSkill] = useState<{ title: string; text: string } | null>(null);
  const refresh = async () => { const result = await client.call('extension.list', { projectId }); setPlugins(result.plugins as InstalledExtension[]); setDirectory(result.directory as typeof extensionDirectory); };
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
  return <section className="third-party-plugins" aria-labelledby="third-party-title">
    <header><h2 id="third-party-title">Third-party plugins</h2><p>Install independent packages to add tools, Skills and views. They can run native code with your permissions. Choose sources you trust.</p></header>
    {canManage && <form className="plugin-install" onSubmit={e => { e.preventDefault(); void act('Install plugin', async () => { await client.call('extension.install', { source: source.trim() }, AbortSignal.timeout(240000)); setSource(''); }); }}>
      <label htmlFor="plugin-source">Package source</label><div><input id="plugin-source" value={source} onChange={e => setSource(e.target.value)} placeholder="npm package, local folder, .tgz or git+https source" required /><button disabled={!!busy || !source.trim()}>{busy === 'Install plugin' ? 'Installing…' : 'Install plugin'}</button></div>
    </form>}
    <p role="status">{busy && busy !== 'Install plugin' ? busy + '…' : message}</p>{error && <p role="alert" className="extension-error">{error} <button disabled={!!busy} onClick={() => void act('Refresh plugins', refresh)}>Refresh</button></p>}
    {!plugins.length && <p>No third-party plugins installed.</p>}
    <div className="extension-list">{plugins.map(p => <article key={p.id}>
      <div className="extension-heading"><h3>{p.title}</h3><span>{p.version} · {p.enabled ? 'Enabled' : 'Disabled'}</span></div><p>{p.description}</p>
      <p className="extension-source">{p.source}</p>
      <div className="extension-actions">
        <button disabled={!!busy || !p.enabled} onClick={() => void act('Open plugin', async () => { const plugin = await client.call('extension.describe', { projectId, pluginId: p.id }) as unknown as InstalledExtension; if (!plugin.manifest.views.length) { setMessage('This plugin has no view. Use its operations from your Agent.'); return; } setOpened({ plugin, viewId: plugin.manifest.views[0].id }); setSkill(null); })}>Open</button>
        <button disabled={!!busy} onClick={() => void act('Read plugin guide', async () => { const plugin = await client.call('extension.describe', { projectId, pluginId: p.id }) as unknown as InstalledExtension; const entry = plugin.manifest.skills[0]; if (!entry) { setSkill({ title: p.title, text: 'This plugin has no Skill. Read extension.describe for its operation schemas.' }); return; } const result = await client.call('extension.content', { projectId, pluginId: p.id, expectedDigest: p.digest, kind: 'skill', entryId: entry.id }); setSkill({ title: entry.title, text: result.text as string }); })}>Guide</button>
        {canManage && <><button disabled={!!busy} onClick={() => void act('Update plugin', async () => { await client.call('extension.install', { source: p.source, replace: p.id, expectedDigest: p.digest }, AbortSignal.timeout(240000)); if (opened?.plugin.id === p.id) setOpened(null); })}>Update</button><button disabled={!!busy} onClick={() => void manage(p, p.enabled ? 'disable' : 'enable')}>{p.enabled ? 'Disable' : 'Enable'}</button><button disabled={!!busy} onClick={() => void manage(p, 'remove')}>Remove</button></>}
      </div>
      <details><summary>Package identity</summary><dl><dt>Package</dt><dd>{p.name}</dd><dt>Digest</dt><dd>{p.digest}</dd>{p.sourceCommit && <><dt>Git commit</dt><dd>{p.sourceCommit}</dd></>}</dl></details>
    </article>)}</div>
    {skill && <section className="extension-guide"><h3>{skill.title}</h3><button onClick={() => setSkill(null)}>Close guide</button><pre>{skill.text}</pre></section>}
    {opened && <section><div className="extension-heading"><h3>{opened.plugin.title}</h3><button onClick={() => setOpened(null)}>Close view</button></div>{opened.plugin.manifest.views.length > 1 && <select aria-label="Plugin view" value={opened.viewId} onChange={e => setOpened({ ...opened, viewId: e.target.value })}>{opened.plugin.manifest.views.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select>}<ExtensionView key={opened.plugin.digest + opened.viewId} {...opened} client={client} projectId={projectId} /></section>}
    {canManage && directory.filter(entry => !plugins.some(p => p.id === entry.id)).map(entry => <article className="extension-discovery" key={entry.id}><h3>{entry.title} <small>{entry.version}</small></h3><p>{entry.description}</p><p>{entry.needs}</p><div className="extension-actions"><button disabled={!!busy} onClick={() => void act('Install ' + entry.title, () => client.call('extension.install', { source: entry.source }, AbortSignal.timeout(240000)))}>Install {entry.title}</button><a href={entry.repository} target="_blank" rel="noreferrer">Source and documentation ↗</a></div><details><summary>Installation source</summary><p className="extension-source">{entry.source}</p></details></article>)}
    <details className="extension-development"><summary>Develop and contribute a plugin</summary><p>Start with <code>rho plugin create my-plugin</code>, then <code>rho plugin dev ./my-plugin</code>. Rho watches your package and installs valid changes. Reopen its view after an update.</p><p>Build your package, check it with <code>rho plugin check</code>, and share a Git source or npm tarball. You own its repository and releases.</p><a href="https://github.com/YuLab-SMU/Rho/blob/main/docs/THIRD-PARTY-PLUGINS.md" target="_blank" rel="noreferrer">Authoring and contribution guide ↗</a></details>
  </section>;
}
