import * as React from 'react';

function Icon({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#226d56"/><text x="16" y="23" textAnchor="middle" fill="white" fontSize="28" fontFamily="Georgia,serif">ρ</text></svg>;
}

export const name = 'dsh-rho';
export const inject = ['slots'];
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
  function Workspace() {
    const [result, setResult] = React.useState(null), [error, setError] = React.useState('');
    const [attempt, retry] = React.useReducer(n => n + 1, 0);
    React.useEffect(() => {
      const controller = new AbortController();
      setResult(null); setError('');
      fetch('/api/dsh-rho/workspace', { signal: controller.signal, credentials: 'same-origin' })
        .then(async response => {
          const value = await response.json();
          if (!response.ok) throw new Error(value.error);
          if (!controller.signal.aborted) setResult(value);
        }).catch(failure => { if (!controller.signal.aborted) setError(failure.message || 'Could not read the Rho connection.'); });
      return () => controller.abort();
    }, [attempt]);
    function open() {
      try {
        if (!openBrowser) throw new Error('Open a conversation to use the Harness browser, or use the system browser below.');
        openBrowser(result.url);
      } catch (failure) { setError(failure.message); }
    }
    return <section className="rho-launcher" aria-label="Rho workspace"><style>{styles}</style>
      <div className="rho-launcher-inner">
        <header><Icon size={48}/><div><h1>Rho</h1><p>Your analysis workspace</p></div></header>
        <div className="rho-launcher-card">
          <h2>Work in Rho</h2>
          <p>Open your shared Notebook, code, tables and figures in the full Rho workspace.</p>
          <div className="rho-launcher-actions">
            <button className="primary" disabled={!result} onClick={open}>Open Rho workspace</button>
            {result && <a href={result.url} target="_blank" rel="noreferrer">Open in system browser</a>}
          </div>
          {!result && !error && <p role="status">Reading the Rho connection…</p>}
          {error && <div role="alert"><p>{error}</p><button onClick={retry}>Try again</button></div>}
        </div>
        <p className="rho-launcher-hint">Select a result in Rho and use Copy request to continue in your Harness conversation.</p>
      </div>
    </section>;
  }
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'rho', order: 30, label: 'Rho' }, Workspace));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'rho' }, Workspace));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'rho', order: 30, label: 'Rho' }, Icon));
}

const styles = `
.rho-launcher{height:100%;overflow:auto;color:var(--dsw-alias-label-primary,inherit);font:inherit;box-sizing:border-box}
.rho-launcher-inner{max-width:760px;margin:0 auto;padding:48px 28px}.rho-launcher header{display:flex;align-items:center;gap:16px;margin-bottom:32px}
.rho-launcher h1{font-size:28px;margin:0 0 4px}.rho-launcher h2{font-size:20px;margin:0 0 12px}.rho-launcher p{line-height:1.65;margin:0}
.rho-launcher header p,.rho-launcher-hint{color:var(--dsw-alias-label-secondary,#858b93)}.rho-launcher-card{border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:16px;padding:28px}
.rho-launcher-actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin:24px 0 12px}.rho-launcher button{font:inherit;padding:10px 16px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:9px;color:inherit;background:transparent;cursor:pointer}
.rho-launcher button.primary{color:white;background:#226d56;border-color:#226d56}.rho-launcher button:disabled{opacity:.5;cursor:default}.rho-launcher a{color:inherit;text-underline-offset:3px}.rho-launcher button:focus-visible,.rho-launcher a:focus-visible{outline:2px solid #51b599;outline-offset:3px}
.rho-launcher [role=alert]{margin-top:16px}.rho-launcher [role=alert] button{margin-top:12px}.rho-launcher-hint{margin-top:24px!important;font-size:14px}
@media(max-width:520px){.rho-launcher-inner{padding:28px 16px}.rho-launcher-card{padding:20px}.rho-launcher-actions{align-items:flex-start;flex-direction:column}}
`;
