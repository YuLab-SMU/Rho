import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PluginViewConnection, PluginViewRecord, PluginViewCloseMode } from '../../sdk/plugin-protocol/index.js';
import { HostClient, message } from './host-client';
import { createPluginWindowClosures, createPluginWindowState, createPluginWindowViews } from './plugin-window-client';
import { pluginLayoutDocument, pluginLayoutModel, pluginLayoutViews, namePluginLayoutViews, pluginLayoutActionChangesDocument, focusPluginLayoutView, activePluginLayoutView } from './plugin-layout';
import { PluginLayoutHost } from './plugin-layout-host';
import { Modal } from "./primitives";
import { mountPluginFrame } from './plugin-frame';
import { PluginLauncherPanel } from './plugin-launcher-panel';
import { PluginWindowRecovery } from './plugin-window-recovery';
import {PluginSidebar} from './plugin-sidebar';

function ConnectedFrame({ client, project, connection, failed, refresh }: {
  client: HostClient; project: string; connection: PluginViewConnection; failed(error: string): void; refresh(): Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null), report = useRef(failed); report.current = failed;
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    if (container.current) return mountPluginFrame(container.current, client, project, connection, error => report.current(error), () => refreshRef.current());
  }, [client, project, connection]);
  return <div ref={container} style={{ width: '100%', height: '100%' }} />;
}

/** Scientific content is entirely contributed. The containing window only
 * observes layouts, retains isolated documents and requests cooperative close. */
export function PluginWorkspace({ client, project, testName }: { client: HostClient; project: string; testName?: string }) {
  const [owners] = useState(() => ({ layout: createPluginWindowState(client, project), views: createPluginWindowViews(client, project), closes: createPluginWindowClosures(client, project), recoveries: new PluginWindowRecovery(client, project) }));
  const saved = useSyncExternalStore(owners.layout.subscribe, owners.layout.getSnapshot);
  const views = useSyncExternalStore(owners.views.subscribe, owners.views.getSnapshot);
  const closes = useSyncExternalStore(owners.closes.subscribe, owners.closes.getSnapshot);
  const recoveries = useSyncExternalStore(owners.recoveries.subscribe, owners.recoveries.getSnapshot);
  const [dock, setDock] = useState(() => pluginLayoutModel(saved.layout));
  const applied = useRef(saved.layout);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<string | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const [recovery, setRecovery] = useState<{ record: PluginViewRecord; busy: boolean } | null>(null);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, observing: Promise<void> | null = null;
    const read = async () => {
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
    };
    const observe = (): Promise<void> => {
      if (observing) return observing;
      if (stopped) return Promise.resolve();
      clearTimeout(timer);
      observing = read().finally(() => { observing = null; if (!stopped) timer = setTimeout(() => void observe(), 1500); });
      return observing;
    };
    refresh.current = async () => {
      // A prior poll may have started before the mutation committed.
      if (observing) await observing;
      await observe();
      if (!stopped && document.visibilityState === 'visible') await new Promise<void>(done => requestAnimationFrame(() => done()));
    };
    void observe();
    return () => { stopped = true; clearTimeout(timer); owners.layout.stop(); owners.views.stop(); owners.closes.stop(); owners.recoveries.stop(); };
  }, [owners]);
  useEffect(() => {
    if (saved.layout === applied.current) return;
    applied.current = saved.layout;
    setDock(pluginLayoutModel(saved.layout, new Map([...views].map(([id, entry]) => [id, entry.title]))));
  }, [saved.layout, views]);
  useEffect(() => {
    namePluginLayoutViews(dock, new Map([...views].map(([id, entry]) => [id, entry.title])));
  }, [dock, views]);
  useEffect(() => {
    let frame = 0;
    const focused = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const id = document.activeElement?.closest<HTMLElement>('[data-plugin-frame]')?.dataset.pluginFrame;
        if (id) setActiveView(id);
      });
    };
    window.addEventListener('blur', focused);
    return () => {window.removeEventListener('blur', focused); cancelAnimationFrame(frame);};
  }, []);
  const focusView = (id: string) => {
    if (focusPluginLayoutView(dock, id)) setActiveView(id);
  };
  const navigation = [...views].flatMap(([id, entry]) => {
    const record = owners.views.connection(id)?.view;
    return record && entry.visible ? [{id, title: entry.title, plugin: record.instance.plugin, contribution: record.contribution}] : [];
  });
  const close = async (id: string, mode?: PluginViewCloseMode) => {
    try {
      await owners.layout.save();
      const record = await owners.closes.close(id, mode);
      owners.views.confirmedClosed(record);
      await owners.layout.load(); setError(''); return true;
    } catch (error) {
      // The per-view close entry and saved-layout owner already present their
      // own diagnostics. A shared banner would repeat the same failure.
      setError(owners.closes.getSnapshot().get(id)?.error || owners.layout.getSnapshot().error ? '' : message(error));
      return false;
    }
  };
  const inspectRecovery = async (id: string) => {
    try {
      const record = await owners.views.inspectForRecovery(id);
      if (record.closed) { owners.views.confirmedClosed(record); await owners.layout.load(); return; }
      setRecovery({ record, busy: false });
    } catch (error) { setError(message(error)); }
  };
  const retryLayout = async () => { try { await owners.layout.save(); setError(''); } catch (error) { setError(message(error)); } };
  const restoreView = async (id: string, retry = false) => {
    try {
      const record = await owners.views.inspectForRecovery(id);
      if (record.closed) { owners.views.confirmedClosed(record); await owners.layout.load(); return; }
      const connected = await (retry ? owners.recoveries.retryOriginal(record) : owners.recoveries.restore(record));
      if (connected) await owners.views.retry(id);
    } catch (error) { owners.views.failed(id, message(error)); }
  };
  const frames = [...views].map(([id, entry]) => {
    const connection = owners.views.connection(id);
    const recovering = recoveries.get(id);
    return { id, title: entry.title, content: <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {connection && <ConnectedFrame client={client} project={project} connection={connection} failed={error => owners.views.failed(id, error)} refresh={() => refresh.current()} />}
      {(!connection || entry.error) && <div className="empty" role={entry.error ? 'alert' : 'status'} style={{ position: 'absolute', inset: 0, background: 'var(--color-surface)' }}>
        {recovering?.busy ? <span role="status">Restoring saved view…</span> : <span>{recovering?.error || recovering?.message || entry.error || 'Connecting view…'}</span>}
        {entry.error && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button disabled={recovering?.busy} onClick={() => void restoreView(id)}>{recovering?.pending ? 'Check recovery status' : connection ? 'Reconnect this view' : 'Restore saved view'}</button>
          {recovering?.pending && <button disabled={recovering.busy} onClick={() => void restoreView(id, true)}>Retry original request</button>}
        </div>}
      </div>}
    </div> };
  });
  return <main aria-label="Plugin workspace" style={{ position: 'relative', height: '100dvh', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    {client.testProject && <div role="note" style={{ flex: 'none', padding: '8px 12px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-subtle)', overflowWrap: 'anywhere' }}>Disposable test workspace · {testName ?? client.testProject}</div>}
    {/* A routine save must not move tab controls or their sibling iframe layer
        underneath a pointer action that already started. */}
    {saved.saving && <div role="status" style={{ position: 'absolute', top: 4, right: 8, zIndex: 10, pointerEvents: 'none', padding: '4px 8px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 4 }}>Saving layout…</div>}
    {(error || saved.error || [...closes.values()].some(entry => entry.busy || entry.error)) && <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border)', overflowWrap: 'anywhere', maxHeight: '30vh', overflow: 'auto' }}>
      {(error || saved.error) && <div role="alert">{saved.error || error}</div>}
      {saved.error && <><button onClick={() => void retryLayout()}>Retry original layout save</button><button disabled={saved.saving} onClick={() => void owners.layout.discardAndReload().catch(error => setError(message(error)))}>Use saved layout</button></>}
      {[...closes].map(([id, entry]) => <div key={id}>
        {entry.busy ? <span role="status">Saving and closing {views.get(id)?.title ?? id}…</span> : <><span>{entry.error}</span> <button onClick={() => void close(id)}>{entry.confirmedFailure ? 'Try closing again' : 'Retry original close'}</button>{entry.confirmedFailure && <button onClick={() => void inspectRecovery(id)}>Close with saved state…</button>}</>}
      </div>)}
    </div>}
    {recovery && <Modal title="Close with saved state" description="Only saved view state will be kept. Unsaved changes may be lost. Running work is unaffected." onClose={() => { if (!recovery.busy) setRecovery(null); }}>
      <p>View: {views.get(recovery.record.view)?.title ?? recovery.record.contribution}</p>
      <p>Saved version: {recovery.record.state_version}</p>
      <div className="dialog-actions">
        <button disabled={recovery.busy} onClick={() => setRecovery(null)}>Keep view open</button>
        <button disabled={recovery.busy} onClick={() => {
          const record = recovery.record; setRecovery({ record, busy: true });
          void close(record.view, { kind: 'retain_acknowledged', expected_version: record.state_version }).finally(() => setRecovery(null));
        }}>Keep saved state and close</button>
      </div>
    </Modal>}
    <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
      <PluginSidebar views={navigation} active={activeView} focus={focusView} />
      <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
      <PluginLayoutHost model={dock} frames={frames} close={id => void close(id)} changed={action => {
        const selected = activePluginLayoutView(dock);
        if (selected) setActiveView(selected);
        if (!pluginLayoutActionChangesDocument(action)) return;
        try { owners.layout.change(pluginLayoutDocument(dock)); applied.current = owners.layout.getSnapshot().layout; void owners.layout.save().catch(error => setError(message(error))); }
        catch (error) { setError(message(error)); }
      }} />
      {saved.saved && pluginLayoutViews(saved.layout).length === 0 && (client.testProject
        ? <div className="empty" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>No views are open in this window.</div>
        : <div style={{ position: 'absolute', inset: 0, overflow: 'auto' }}><PluginLauncherPanel client={client} project={project} refresh={() => refresh.current()} /></div>)}
      </div>
    </div>
  </main>;
}

export function PluginWorkspaceWindow({ client: provided }: { client?: HostClient }) {
  const [connection, setConnection] = useState<{ client: HostClient; project: string; testName?: string } | null>(null);
  const [available, setAvailable] = useState<HostClient | null>(null);
  const [path, setPath] = useState(''), [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let client: HostClient | undefined, stopped = false;
    try {
      client = provided ?? HostClient.fromLocation(); const current = client;
      void client.info().then(async info => {
        if (!info.project_root) {
          if (current.testProject) throw new Error('Select a project before opening this test workspace.');
          if (!stopped) setAvailable(current);
          return;
        }
        const test = await current.testProjectObservation(info.project_root);
        if (!stopped) setConnection({ client: current, project: info.project_root, testName: test?.project.selection.name });
      }).catch(error => { if (!stopped) setError(message(error)); });
    } catch (error) { setError(message(error)); }
    return () => { stopped = true; client?.stopReads(); };
  }, [provided]);
  if (connection) return <PluginWorkspace {...connection} />;
  if (available) return <main className="plugin-start">
    <div className="welcome-mark">rho</div><h1>Your scientific workspace</h1>
    <p>Open a local project, then choose an installed workspace view.</p>
    <form onSubmit={event => {
      event.preventDefault(); setOpening(true); setError('');
      void available.selectProject(path.trim()).then(info => {
        if (!info.project_root) throw Error('The selected project was not opened.');
        setConnection({ client: available, project: info.project_root });
      }).catch(error => setError(message(error))).finally(() => setOpening(false));
    }}>
      <label>Absolute Project Path<input autoFocus value={path} onChange={event => setPath(event.target.value)} placeholder="/Users/…/project" disabled={opening} /></label>
      <button className="primary" disabled={opening || !path.trim()}>Open Project</button>
    </form>
    <button disabled={opening} onClick={() => {
      setOpening(true); setError('');
      void available.selectDemoProject().then(info => {
        if (!info.project_root) throw Error('The demo project was not opened.');
        setConnection({ client: available, project: info.project_root });
      }).catch(error => setError(message(error))).finally(() => setOpening(false));
    }}>Open Rho Demo</button>
    {opening && <p role="status">Opening project…</p>}{error && <p role="alert" className="error">{error}</p>}
  </main>;
  return <div className="empty" role={error ? 'alert' : 'status'}>{error || 'Opening window…'}</div>;
}
