import { Component, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { View, fixture, manifest } from 'virtual:rho-preview';
import 'rho-preview-theme';
import './preview.css';
class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <p className="preview-error" role="alert">View failed: {this.state.error}</p> : this.props.children; }
}
function Preview() {
  const [mode, setMode] = useState('ready'), [width, setWidth] = useState('100%'), [value, setValue] = useState(JSON.stringify(fixture.props, null, 2));
  const [props, setProps] = useState(fixture.props), [problem, setProblem] = useState(''), [revision, setRevision] = useState(0);
  const [calls, setCalls] = useState<string[]>([]);
  const client = useMemo(() => ({ call: async (method: string, _input: unknown, signal?: AbortSignal) => {
    setCalls(previous => [...previous.slice(-19), method]);
    if (!manifest.requiredOperations.includes(method)) throw new Error('Preview: undeclared operation ' + method);
    if (mode === 'error') throw new Error('Preview: the owner is unavailable.');
    if (mode === 'loading') return new Promise((_, reject) => { if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError')); else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
    if (!Object.hasOwn(fixture.responses, method)) throw new Error('Add a preview response for ' + method);
    return structuredClone(fixture.responses[method]);
  } }), [mode, revision]);
  return <div className="preview-app">
    <header><strong>Rho plugin preview</strong><span>{manifest.component}</span><small>Fixture data · no project connection</small></header>
    <div className="preview-controls"><label>State <select aria-label="State" value={mode} onChange={e => { setMode(e.target.value); setCalls([]); }}><option value="ready">Ready</option><option value="loading">Loading</option><option value="error">Owner error</option><option value="unbound">Missing binding</option></select></label>
      <label>Width <select aria-label="Width" value={width} onChange={e => setWidth(e.target.value)}><option value="100%">Fill</option><option value="768px">768 px</option><option value="390px">390 px</option></select></label><button onClick={() => setRevision(n => n + 1)}>Remount view</button></div>
    <div className="preview-layout"><main className="preview-stage"><div className="preview-view" style={{ width }}><Boundary key={mode + ':' + revision}><View viewId="preview" view={{ id: 'preview', component: manifest.component, version: manifest.version, props, bindings: mode === 'unbound' ? {} : fixture.bindings }} projectId="preview-project" snapshot={{ ...(fixture.snapshot ?? {}), project: { id: 'preview-project', name: 'Preview' }, documents: fixture.documents ?? [], resources: fixture.resources ?? [], catalog: { operations: manifest.requiredOperations.map((method: string) => ({ method, state: 'available', authorized: true })) } }} client={client} active contextTarget={null} headerTarget={null} principalId="preview-author" /></Boundary></div></main>
      <aside className="preview-inspector"><label htmlFor="props">View props</label><textarea id="props" value={value} onChange={e => setValue(e.target.value)} rows={10} /><button onClick={() => { try { const next = JSON.parse(value); if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('Props must be an object.'); setProps(next); setProblem(''); } catch (error) { setProblem((error as Error).message); } }}>Apply props</button>{problem && <p role="alert">{problem}</p>}<h2>Observed calls</h2><p className="muted">Last 20 calls, without input data.</p><ol>{calls.map((method, index) => <li key={index}><code>{method}</code></li>)}</ol><p className="muted">Edit the source or preview.json to refresh this preview. Refresh resets local state.</p></aside>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
