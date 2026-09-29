import { useEffect, useState } from 'react';
import type { HostClient } from './host-client';
import { message } from './host-client';
import { PluginLauncher } from './plugin-launcher';

export function PluginLauncherPanel({ client, project, refresh }: { client: HostClient; project: string; refresh(): Promise<void> }) {
  const [launcher] = useState(() => new PluginLauncher(client, project));
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [choice, setChoice] = useState(''), [, render] = useState(0);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); await refresh(); } catch (error) { setError(message(error)); }
    finally { setBusy(false); render(value => value + 1); }
  };
  useEffect(() => { void act(() => launcher.load()); }, [launcher]);
  return <section className="plugin-start" aria-label="Open workspace view">
    <h1>Open a workspace view</h1>
    <p>No views are open in this window.</p>
    {launcher.launch ? <>
      <p>{launcher.launch.choice.title} · {launcher.launch.pending ? 'An original request needs inspection.' : 'Preparation is retained.'}</p>
      {launcher.launch.pending ? <div className="dialog-actions">
        <button disabled={busy} onClick={() => void act(() => launcher.inspect())}>Inspect original request</button>
        <button disabled={busy} onClick={() => void act(() => launcher.dispatch())}>Retry original request</button>
      </div> : <div className="dialog-actions">
        <button className="primary" disabled={busy} onClick={() => void act(() => launcher.continue())}>Continue opening view</button>
        <button disabled={busy} onClick={() => void act(() => launcher.reset())}>{launcher.launch.instance ? 'Keep instance and choose another view' : 'Choose another view'}</button>
      </div>}
    </> : launcher.choices.length ? <form onSubmit={event => { event.preventDefault(); void act(() => launcher.choose(choice)); }}>
      <label>Installed workspace view<select value={choice} disabled={busy} onChange={event => setChoice(event.target.value)}>
        <option value="">Select a view…</option>
        {launcher.choices.map(item => <option key={item.id} value={item.id}>{item.title} · {item.inspection.manifest.version} · {item.inspection.summary.revision.slice(7, 15)} · {item.artifact.slice(7, 15)}</option>)}
      </select></label>
      <p>{launcher.choices.find(item => item.id === choice)?.description}</p>
      <button className="primary" disabled={busy || !choice}>Open view</button>
    </form> : !busy && <p>No standalone workspace views are installed. Import a workspace plugin with the Rho recovery CLI, then refresh. Packages are never installed automatically.</p>}
    <button disabled={busy} onClick={() => void act(() => launcher.load())}>Refresh installed views</button>
    {busy && <p role="status">Opening workspace…</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
