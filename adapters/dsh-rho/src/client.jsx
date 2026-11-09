import * as React from 'react';

function Icon({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#226d56"/><text x="16" y="23" textAnchor="middle" fill="white" fontSize="28" fontFamily="Georgia,serif">ρ</text></svg>;
}

export const name = 'dsh-rho';
export const inject = ['slots'];

const CONFIG_FIELDS = [
  { key: 'command', label: 'Rho command', kind: 'text', fallback: 'rho', hint: 'Executable used for the MCP bridge. Use an absolute path in Desktop.' },
  { key: 'connectionFile', label: 'Agent connection file', kind: 'text', fallback: '', hint: 'Absolute path to this project’s Rho agent connection file. Keep the file outside the project.' },
  { key: 'connectionFiles', label: 'Other connection files', kind: 'lines', fallback: [], hint: 'One absolute path per line, one per project.' },
  { key: 'args', label: 'Extra arguments', kind: 'lines', fallback: [], hint: 'One argument per line, placed before --mcp.' },
  { key: 'maxBridges', label: 'Conversation bridge limit', kind: 'number', fallback: 8, min: 1, hint: 'Maximum simultaneous Rho bridges (default 8).' },
  { key: 'toolCallTimeoutMs', label: 'Tool reply timeout (ms)', kind: 'number', fallback: 300000, min: 1000, hint: 'MCP reply wait. A Notebook cell is not limited by this.' },
];

function fieldText(value, kind) {
  if (kind === 'lines') return Array.isArray(value) ? value.join('\n') : '';
  return value === undefined || value === null ? '' : String(value);
}

function fieldValue(text, kind) {
  if (kind === 'lines') return text.split('\n').map(line => line.trim()).filter(Boolean);
  if (kind === 'number') return Number(text);
  return text;
}

function configStore(scope) {
  let snapshot = scope.getSnapshot();
  const listeners = new Set();
  const unsubscribe = scope.subscribe(() => {
    snapshot = scope.getSnapshot();
    for (const listener of listeners) listener();
  });
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    set: (field, value) => scope.set(field, value),
    dispose: unsubscribe,
  };
}

function ConfigCard({ view, configScope }) {
  const store = React.useMemo(() => configStore(configScope), [configScope]);
  React.useEffect(() => () => store.dispose(), [store]);
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const value = snapshot?.value && typeof snapshot.value === 'object' ? snapshot.value : {};
  const [draft, setDraft] = React.useState(() => Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, fieldText(value[field.key] ?? field.fallback, field.kind)])));
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const serialized = JSON.stringify(value);
  React.useEffect(() => {
    setDraft(Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, fieldText(value[field.key] ?? field.fallback, field.kind)])));
  }, [serialized]);
  const disabled = snapshot?.status !== 'ready' || snapshot?.writable === false || saving;
  if (view === 'summary') return <span>Rho connection and bridge settings</span>;
  const changes = CONFIG_FIELDS.flatMap(field => {
    const next = fieldValue(draft[field.key] ?? '', field.kind);
    if (field.kind === 'number' && (!Number.isSafeInteger(next) || next < field.min)) {
      return [{ error: field.label + ' needs a whole number of at least ' + field.min + '.' }];
    }
    return JSON.stringify(next) === JSON.stringify(value[field.key] ?? field.fallback) ? [] : [{ field: field.key, value: next }];
  });
  const invalid = changes.find(change => change.error);
  async function save() {
    if (invalid || !changes.length) return;
    setSaving(true); setMessage('');
    try {
      for (const change of changes) await store.set(change.field, change.value);
      setMessage(changes.length + ' setting(s) saved. Turn the Rho bundle off and on to apply connection or command changes.');
    } catch (error) { setMessage('Could not save: ' + (error?.message || 'the configuration was refused.')); }
    finally { setSaving(false); }
  }
  return <section className="rho-config" aria-label="Rho plugin settings"><style>{styles}</style>
    <h2>Rho connection</h2>
    <p>These values are the bundle’s configuration. The connection files are credentials; keep their contents out of chats, packages and Git.</p>
    {snapshot?.status === 'unavailable' && <p role="status">This profile does not expose bundle configuration here. Edit cordis.patch.yml instead.</p>}
    {snapshot?.writable === false && <p role="status">Configuration is read-only in this profile.</p>}
    {CONFIG_FIELDS.map(field => <label className="rho-config-row" key={field.key}>
      <span className="rho-config-label">{field.label}</span>
      {field.kind === 'lines'
        ? <textarea rows={2} value={draft[field.key] ?? ''} disabled={disabled} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} />
        : <input type={field.kind === 'number' ? 'number' : 'text'} value={draft[field.key] ?? ''} disabled={disabled} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} />}
      <span className="rho-config-hint">{field.hint}</span>
    </label>)}
    {invalid && <p role="alert">{invalid.error}</p>}
    <div className="rho-config-actions">
      <button className="primary" disabled={disabled || !!invalid || !changes.length} onClick={save}>Save settings</button>
      {message && <p role="status">{message}</p>}
    </div>
  </section>;
}

export function apply(ctx) {
  let openBrowser;
  ctx.inject(['sidebarRight', 'sidebarRightTabs', 'layout'], scope => {
    openBrowser = url => {
      if (!scope.sidebarRightTabs.get('browser')) throw new Error('The Harness browser is unavailable here. Use Open in system browser.');
      const panel = scope.layout.panelInfo.getSnapshot().activePanelId;
      scope.layout.selectPanel(null);
      try {
        if (scope.sidebarRight.mounted.getSnapshot() === undefined) throw new Error('Open a conversation first, or use Open in system browser.');
        scope.sidebarRight.openTab('browser', { params: { url } });
      } catch (failure) { scope.layout.selectPanel(panel); throw failure; }
    };
    scope.on('dispose', () => { openBrowser = undefined; });
  });
  function Workspace({ sessionId }) {
    const selectedSession = React.useRef(sessionId);
    selectedSession.current = sessionId;
    const [result, setResult] = React.useState(null), [error, setError] = React.useState('');
    const [details, setDetails] = React.useState(null);
    const [attempt, retry] = React.useReducer(n => n + 1, 0);
    const retrySession = React.useRef(null);
    React.useEffect(() => {
      const controller = new AbortController();
      const method = retrySession.current === sessionId ? 'POST' : 'GET';
      retrySession.current = null;
      setResult(null); setError(''); setDetails(null);
      if (!sessionId) { setError('Open a Harness conversation in the project you want to use.'); return () => controller.abort(); }
      fetch('/api/dsh-rho/workspace?' + new URLSearchParams({ sessionId }), { method, signal: controller.signal, credentials: 'same-origin' })
        .then(async response => {
          const value = await response.json();
          if (controller.signal.aborted) return;
          setDetails(value);
          if (!response.ok) throw new Error(value.error);
          setResult(value);
        }).catch(failure => { if (!controller.signal.aborted) setError(failure.message || 'Could not read the Rho connection.'); });
      return () => controller.abort();
    }, [attempt, sessionId]);
    // A newly selected conversation must never render the previous one's link, even for one frame.
    const current = result?.sessionId === sessionId ? result : null;
    async function open() {
      try {
        if (!openBrowser) throw new Error('Open a conversation to use the Harness browser, or use the system browser below.');
        const response = await fetch('/api/dsh-rho/workspace?' + new URLSearchParams({ sessionId }), { method: 'POST', credentials: 'same-origin' });
        const value = await response.json();
        if (selectedSession.current !== sessionId) return;
        if (!response.ok) { setResult(null); setDetails(value); throw new Error(value.error); }
        setResult(value);
        openBrowser(value.url);
      } catch (failure) { if (selectedSession.current === sessionId) setError(failure.message); }
    }
    return <section className="rho-launcher" aria-label="Rho workspace"><style>{styles}</style>
      <div className="rho-launcher-inner">
        <header><Icon size={48}/><div><h1>Rho</h1><p>This conversation’s project</p></div></header>
        <div className="rho-launcher-card">
          <h2>{current ? current.name : 'Connect this project'}</h2>
          {current ? <><p className="rho-launcher-path">{current.root}</p><p className="rho-launcher-address">{new URL(current.url).origin}</p><p>{current.toolsReady ? 'Rho tools and this workspace use the same project.' : 'Rho tools will connect to this project when the conversation resumes.'}</p></>
            : <p>Rho opens the project used by this Harness conversation.</p>}
          <div className="rho-launcher-actions">
            <button className="primary" disabled={!current} onClick={open}>Open Rho workspace</button>
            {current && <a href={current.url} target="_blank" rel="noreferrer">Open in system browser</a>}
          </div>
          {!current && !error && <p role="status">Checking this project’s Rho connection…</p>}
          {current?.observationReady && <p>Conversation, operations and results are visible in Rho. Input stays in Harness.</p>}
          {current?.observationError && <p role="alert">{current.observationError} <button onClick={() => { retrySession.current = sessionId; retry(); }}>Try again</button></p>}
          {error && <div role="alert"><p>{error}</p>{details?.conversationRoot && <p className="rho-launcher-path">{details.conversationRoot}</p>}
            {!!details?.projects?.length && <><p className="rho-launcher-other">Configured Rho projects:</p><ul>{details.projects.map(project => <li key={project.url}><strong>{project.name}</strong><div className="rho-launcher-path">{project.root}</div></li>)}</ul></>}
            {details?.unavailable > 0 && <p>{details.unavailable} configured connection(s) could not be reached.</p>}
            <button onClick={() => { retrySession.current = sessionId; retry(); }}>Try again</button></div>}
        </div>
        <p className="rho-launcher-hint">Select a result in Rho and use Copy request to continue in your Harness conversation.</p>
      </div>
    </section>;
  }
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'rho', order: 30, label: 'Rho' }, Workspace));
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: 'rho', children: { 'rho.workspace': { kind: 'single', scope: 'session-maybe' } } }, ({ renderSlot }) => renderSlot('rho.workspace', {}));
    yield ctx.slots.register({ name: 'rho.workspace' }, Workspace);
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'rho', order: 30, label: 'Rho' }, Icon));
  // The plugin page renders a bundle's own configuration through this keyed
  // slot. Register only while the Host serves this bundle's Config namespace,
  // so a profile without configuration shows no empty card.
  ctx.inject(['configForms'], scope => {
    const forms = scope.configForms;
    if (!forms || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return;
    const configScope = forms.get('dsh-rho');
    if (!configScope || typeof configScope.getSnapshot !== 'function') return;
    scope.effect(() => forms.whileServed(['dsh-rho'], () =>
      scope.slots.inject('plugins.bundle.config', () =>
        scope.slots.register({ name: 'plugins.bundle.config', key: 'dsh-rho' },
          props => <ConfigCard {...props} configScope={configScope} />)
      )
    ), 'dsh-rho: plugins-page card');
  });
}

const styles = `
.rho-launcher{height:100%;overflow:auto;color:var(--dsw-alias-label-primary,inherit);font:inherit;box-sizing:border-box}
.rho-launcher-inner{max-width:760px;margin:0 auto;padding:48px 28px}.rho-launcher header{display:flex;align-items:center;gap:16px;margin-bottom:32px}
.rho-launcher h1{font-size:28px;margin:0 0 4px}.rho-launcher h2{font-size:20px;margin:0 0 12px}.rho-launcher p{line-height:1.65;margin:0}
.rho-launcher header p,.rho-launcher-hint{color:var(--dsw-alias-label-secondary,#858b93)}.rho-launcher-card{border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:16px;padding:28px}
.rho-launcher-actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin:24px 0 12px}.rho-launcher button{font:inherit;padding:10px 16px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:9px;color:inherit;background:transparent;cursor:pointer}
.rho-launcher button.primary{color:white;background:#226d56;border-color:#226d56}.rho-launcher button:disabled{opacity:.5;cursor:default}.rho-launcher a{color:inherit;text-underline-offset:3px}.rho-launcher button:focus-visible,.rho-launcher a:focus-visible{outline:2px solid #51b599;outline-offset:3px}
.rho-launcher [role=alert]{margin-top:16px}.rho-launcher [role=alert] button{margin-top:12px}.rho-launcher-hint{margin-top:24px!important;font-size:14px}
.rho-launcher-path{overflow-wrap:anywhere;font-size:14px;margin:10px 0!important}.rho-launcher-address{font-size:13px;opacity:.75;margin-bottom:16px!important}.rho-launcher-other{margin-top:20px!important}.rho-launcher li{margin-bottom:12px}
.rho-config{font:inherit;color:var(--dsw-alias-label-primary,inherit);padding:4px 0}.rho-config h2{font-size:18px;margin:0 0 8px}.rho-config p{line-height:1.6;margin:0 0 16px}
.rho-config-row{display:grid;gap:6px;margin:16px 0}.rho-config-label{font-weight:500}.rho-config-hint{font-size:12px;opacity:.7;line-height:1.5}
.rho-config input,.rho-config textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:8px;padding:8px 10px;width:100%;box-sizing:border-box;resize:vertical}
.rho-config input:focus-visible,.rho-config textarea:focus-visible{outline:2px solid #51b599;outline-offset:2px}
.rho-config input:disabled,.rho-config textarea:disabled{opacity:.5}
.rho-config-actions{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:20px}.rho-config-actions p{margin:0;flex:1;min-width:200px}
.rho-config button{font:inherit;padding:10px 16px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:9px;color:inherit;background:transparent;cursor:pointer}
.rho-config button.primary{color:white;background:#226d56;border-color:#226d56}.rho-config button:disabled{opacity:.5;cursor:default}
@media(max-width:520px){.rho-launcher-inner{padding:28px 16px}.rho-launcher-card{padding:20px}.rho-launcher-actions{align-items:flex-start;flex-direction:column}}
`;
