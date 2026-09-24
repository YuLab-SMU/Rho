import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PluginViewConnection } from '../../sdk/plugin-protocol/index.js';
import { HostClient, message } from './host-client';
import { createPluginWindowClosures, createPluginWindowState, createPluginWindowViews } from './plugin-window-client';
import { pluginLayoutDocument, pluginLayoutModel, pluginLayoutViews, namePluginLayoutViews } from './plugin-layout';
import { PluginLayoutHost } from './plugin-layout-host';
import { mountPluginFrame } from './plugin-frame';

function ConnectedFrame({ client, project, connection, failed }: {
  client: HostClient; project: string; connection: PluginViewConnection; failed(error: string): void;
}) {
  const container = useRef<HTMLDivElement>(null), report = useRef(failed); report.current = failed;
  useEffect(() => {
    if (container.current) return mountPluginFrame(container.current, client, project, connection, error => report.current(error));
  }, [client, project, connection]);
  return <div ref={container} style={{ width: '100%', height: '100%' }} />;
}

/** Scientific content is entirely contributed. The containing window only
 * observes layouts, retains isolated documents and requests cooperative close. */
export function PluginWorkspace({ client, project }: { client: HostClient; project: string }) {
  const [owners] = useState(() => ({ layout: createPluginWindowState(client, project), views: createPluginWindowViews(client, project), closes: createPluginWindowClosures(client, project) }));
  const saved = useSyncExternalStore(owners.layout.subscribe, owners.layout.getSnapshot);
  const views = useSyncExternalStore(owners.views.subscribe, owners.views.getSnapshot);
  const closes = useSyncExternalStore(owners.closes.subscribe, owners.closes.getSnapshot);
  const [dock, setDock] = useState(() => pluginLayoutModel(saved.layout));
  const applied = useRef(saved.layout);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const observe = async () => {
      try {
        const state = owners.layout.getSnapshot();
        if (!state.dirty && !state.saving) await owners.layout.load();
        const layout = owners.layout.getSnapshot().saved;
        if (stopped) return;
        if (layout) {
          owners.views.observe(layout);
          await Promise.allSettled(pluginLayoutViews(layout.layout).map(id => {
            const entry = owners.views.getSnapshot().get(id);
            return entry && !entry.connected && !entry.error ? owners.views.connect(id) : Promise.resolve();
          }));
          if (!stopped) await owners.views.inspectHidden();
        }
        if (!stopped) setError('');
      } catch (error) { if (!stopped) setError(message(error)); }
      finally { if (!stopped) timer = setTimeout(() => void observe(), 1500); }
    };
    void observe();
    return () => { stopped = true; clearTimeout(timer); owners.layout.stop(); owners.views.stop(); owners.closes.stop(); };
  }, [owners]);
  useEffect(() => {
    if (saved.layout === applied.current) return;
    applied.current = saved.layout;
    setDock(pluginLayoutModel(saved.layout, new Map([...views].map(([id, entry]) => [id, entry.title]))));
  }, [saved.layout, views]);
  useEffect(() => {
    namePluginLayoutViews(dock, new Map([...views].map(([id, entry]) => [id, entry.title])));
  }, [dock, views]);
  const close = async (id: string) => {
    try {
      await owners.layout.save();
      const record = await owners.closes.close(id);
      owners.views.confirmedClosed(record);
      await owners.layout.load(); setError('');
    } catch (error) { setError(message(error)); }
  };
  const retryLayout = async () => { try { await owners.layout.save(); setError(''); } catch (error) { setError(message(error)); } };
  const frames = [...views].map(([id, entry]) => {
    const connection = owners.views.connection(id);
    return { id, title: entry.title, content: <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {connection && <ConnectedFrame client={client} project={project} connection={connection} failed={error => owners.views.failed(id, error)} />}
      {(!connection || entry.error) && <div className="empty" role={entry.error ? 'alert' : 'status'} style={{ position: 'absolute', inset: 0, background: 'var(--color-surface)' }}>
        {entry.error || 'Connecting view…'}
        {entry.error && <button onClick={() => void owners.views.retry(id).catch(error => setError(message(error)))}>Reconnect this view</button>}
      </div>}
    </div> };
  });
  return <main aria-label="Plugin workspace" style={{ height: '100dvh', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    {(error || saved.error || saved.saving || [...closes.values()].some(entry => entry.busy || entry.error)) && <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border)', overflowWrap: 'anywhere', maxHeight: '30vh', overflow: 'auto' }}>
      {(error || saved.error) && <div role="alert">{saved.error || error}</div>}
      {saved.saving && <span role="status">Saving layout…</span>}
      {saved.error && <><button onClick={() => void retryLayout()}>Retry original layout save</button><button disabled={saved.saving} onClick={() => void owners.layout.discardAndReload().catch(error => setError(message(error)))}>Use saved layout</button></>}
      {[...closes].map(([id, entry]) => <div key={id}>
        {entry.busy ? <span role="status">Saving and closing {views.get(id)?.title ?? id}…</span> : <><span>{entry.error}</span> <button onClick={() => void close(id)}>{entry.confirmedFailure ? 'Try closing again' : 'Retry original close'}</button></>}
      </div>)}
    </div>}
    <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
      <PluginLayoutHost model={dock} frames={frames} close={id => void close(id)} changed={() => {
        try { owners.layout.change(pluginLayoutDocument(dock)); applied.current = owners.layout.getSnapshot().layout; void owners.layout.save().catch(error => setError(message(error))); }
        catch (error) { setError(message(error)); }
      }} />
      {saved.saved && pluginLayoutViews(saved.layout).length === 0 && <div className="empty" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>No views are open in this window.</div>}
    </div>
  </main>;
}

export function PluginWorkspaceWindow() {
  const [connection, setConnection] = useState<{ client: HostClient; project: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let client: HostClient | undefined, stopped = false;
    try {
      client = HostClient.fromLocation(); const current = client;
      void client.info().then(info => {
        if (!info.project_root) throw new Error('Select a project before opening this window.');
        if (!stopped) setConnection({ client: current, project: info.project_root });
      }).catch(error => { if (!stopped) setError(message(error)); });
    } catch (error) { setError(message(error)); }
    return () => { stopped = true; client?.stopReads(); };
  }, []);
  return connection ? <PluginWorkspace {...connection} /> : <div className="empty" role={error ? 'alert' : 'status'}>{error || 'Opening window…'}</div>;
}
