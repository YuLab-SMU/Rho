import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TableView } from '@rho-workspace/plugin-tables/ui';
import { MediaView } from '@rho-workspace/plugin-media/ui';

async function api(sessionId: string, body: any, signal?: AbortSignal) {
  const response = await fetch(new URL('api/dsh-rho', document.baseURI), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, sessionId }), signal });
  const reply = await response.json();
  if (!response.ok || !reply.ok) throw new Error(reply.error ?? 'The Rho connection did not answer.');
  return reply.value;
}

// One ephemeral selection owner for this displayed result. Tables still owns key
// semantics; the host validates chosen keys against the exact snapshot before use.
function viewClient(sessionId: string, onSelection: (keys: string[]) => void) {
  let selection: any = { version: 0, selection: null };
  const receipts = new Map<string, any>();
  return { async call(method: string, input: any, signal?: AbortSignal) {
    if (method === 'interaction.selection.read') return selection;
    if (method === 'interaction.selection.set') {
      if (receipts.has(input.changeId)) return receipts.get(input.changeId);
      if (input.expectedVersion !== selection.version) throw new Error('The selection changed. Select the rows again.');
      selection = { version: selection.version + 1, selection: input.selection };
      receipts.set(input.changeId, selection);
      if (receipts.size > 64) receipts.delete(receipts.keys().next().value!);
      onSelection(input.selection?.entities ?? []);
      return selection;
    }
    return api(sessionId, { action: 'call', method, input }, signal);
  } };
}

function Result({ result, sessionId, inputActions, openView }: any) {
  const [keys, setKeys] = useState<string[]>([]), [question, setQuestion] = useState('');
  const [failure, setFailure] = useState(''), [busy, setBusy] = useState(false);
  const client = useMemo(() => viewClient(sessionId, setKeys), [sessionId, result.resource.id]);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const resource = result.resource, ref = { id: resource.id, version: resource.version };
  const view = { id: 'dsh-rho-' + resource.id, props: { title: result.title }, bindings: { data: ref } };
  const ask = async () => {
    if (busy) return;
    const insertion = inputActions.captureInsertion();
    setBusy(true); setFailure('');
    try {
      const value = await api(sessionId, { action: 'question', callId: result.callId, resource: ref, entities: keys, question });
      if (!live.current) return;
      if (value.sessionId !== sessionId) throw new Error('The original session changed.');
      // The native input owns draft revision, Unicode, reference chips and undo.
      // A concurrent edit refuses insertion instead of overwriting the draft.
      if (!inputActions.insertText('\n\n' + value.text + '\n', { ...insertion, end: insertion.start })) throw new Error('Your chat draft changed while the context was read. Try again; the draft is intact.');
      inputActions.persistDraft();
      openView('chat', '');
    } catch (error: any) { if (live.current) setFailure(error.message); }
    finally { if (live.current) setBusy(false); }
  };
  return <section className="dsh-rho-result" aria-label={result.title}>
    <header><div><h2>{result.title}</h2><p>{resource.provenance.originalPath} <span title={resource.version}>· snapshot {resource.version.slice(0, 8)}</span></p></div><span className="dsh-rho-kind">{resource.kind === 'table' ? 'Table' : 'Figure'}</span></header>
    <div className="dsh-rho-view">
      {resource.kind === 'table' ? <TableView view={view} projectId={resource.projectId} client={client} active selectable={!!resource.format?.key} />
        : <MediaView view={view} projectId={resource.projectId} client={client} active mimeType={resource.format.mimeType} />}
    </div>
    <form className="dsh-rho-question" onSubmit={e => { e.preventDefault(); void ask(); }}>
      <label htmlFor={'rho-question-' + resource.id}>{keys.length ? `Ask about ${keys.length} selected ${keys.length === 1 ? 'row' : 'rows'}` : 'Ask about this result'}</label>
      <div><textarea id={'rho-question-' + resource.id} placeholder="What would you like to understand or change?" value={question} onChange={e => setQuestion(e.target.value)} rows={2} maxLength={2000} />
      <button type="submit" disabled={busy || !question.trim()}>{busy ? 'Preparing…' : 'Add question to chat'}</button></div>
      <p>The exact snapshot{keys.length ? ' and selected rows' : ''} will join your draft in this conversation. Send it from Chat.</p>
      {failure && <p role="alert">{failure}</p>}
    </form>
  </section>;
}

function SessionView(props: any) {
  const { sessionId } = props;
  const [results, setResults] = useState<any[]>([]), [selected, setSelected] = useState('');
  const [failure, setFailure] = useState(''), [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await api(sessionId, { action: 'list' }, signal);
      setResults(value.results); setFailure(''); setLoaded(true);
      setSelected(old => old && value.results.some((r: any) => r.callId === old) ? old : value.results.at(-1)?.callId ?? '');
    } catch (error: any) { if (!signal?.aborted) { setFailure(error.message); setLoaded(true); } }
  }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (!document.hidden) await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, 2000); };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  const result = results.find(r => r.callId === selected);
  return <div className="dsh-rho"><style>{styles}</style>
    <div className="dsh-rho-heading"><div><h1>Rho</h1><span>Results from this conversation</span></div><button onClick={() => void refresh()}>Refresh</button></div>
    {failure && <div className="dsh-rho-error" role="alert">{failure} <button onClick={() => void refresh()}>Try again</button></div>}
    {!results.length ? <div className="dsh-rho-empty"><h2>{loaded ? 'Bring your analysis into view' : 'Reading results…'}</h2>{loaded && <p>Ask the Agent to analyse your data and use <code>rho_present</code> for its tables and figures. They will appear here with the versions you can ask about.</p>}</div>
      : <div className="dsh-rho-workspace"><nav aria-label="Analysis results">{[...results].reverse().map(r => <button key={r.callId} aria-pressed={selected === r.callId} onClick={() => setSelected(r.callId)}><strong>{r.title}</strong><span>{r.resource.provenance.originalPath}</span><small>{r.resource.version.slice(0, 8)} · {r.resource.kind === 'table' ? 'Table' : 'Figure'}</small></button>)}</nav>
        {result && <Result key={sessionId + ':' + result.callId} {...props} result={result} />}</div>}
  </div>;
}

function RhoView(props: any) { return <SessionView key={props.sessionId} {...props} />; }

const styles = `
.dsh-rho{--surface:var(--dsw-alias-bg-base,#fff);--text:var(--dsw-alias-text-primary,#25312d);--text-muted:var(--dsw-alias-text-secondary,#64716a);--border:var(--dsw-alias-border-default,#dce3de);height:100%;min-height:0;display:flex;flex-direction:column;padding:20px 24px;box-sizing:border-box;color:var(--text);background:var(--surface);font:14px/1.5 system-ui,sans-serif}
.dsh-rho *{box-sizing:border-box}.dsh-rho button,.dsh-rho textarea{font:inherit}.dsh-rho button{cursor:pointer;border:1px solid var(--border);border-radius:8px;padding:7px 12px;background:var(--surface);color:var(--text)}.dsh-rho button:disabled{opacity:.45;cursor:default}.dsh-rho button:focus-visible,.dsh-rho textarea:focus-visible{outline:2px solid #24745c;outline-offset:2px}.dsh-rho h1,.dsh-rho h2,.dsh-rho p{margin:0}.dsh-rho-heading{display:flex;align-items:center;justify-content:space-between;padding-bottom:18px;gap:12px}.dsh-rho-heading>div{display:flex;align-items:baseline;gap:12px}.dsh-rho h1{font-size:22px;font-weight:650}.dsh-rho-heading span,.dsh-rho-result header p{color:var(--text-muted);font-size:12px}.dsh-rho-workspace{display:flex;gap:24px;flex:1;min-height:0}.dsh-rho nav{width:205px;flex-shrink:0;overflow:auto}.dsh-rho nav button{display:flex;flex-direction:column;align-items:flex-start;gap:5px;text-align:left;width:100%;margin-bottom:8px;padding:12px;border-color:transparent}.dsh-rho nav button[aria-pressed=true]{background:color-mix(in srgb,#24745c 9%,var(--surface));border-color:color-mix(in srgb,#24745c 25%,var(--border))}.dsh-rho nav span{font-size:12px;overflow-wrap:anywhere}.dsh-rho nav small{font-size:11px;color:var(--text-muted)}.dsh-rho-result{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}.dsh-rho-result header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:16px}.dsh-rho h2{font-size:18px;font-weight:600}.dsh-rho-result header p{overflow-wrap:anywhere;margin-top:3px}.dsh-rho-kind{font-size:11px;color:var(--text-muted);padding:3px 8px;border:1px solid var(--border);border-radius:6px}.dsh-rho-view{flex:1;min-height:180px;overflow:hidden}.dsh-rho-question{padding-top:16px;margin-top:12px;border-top:1px solid var(--border)}.dsh-rho-question label{font-size:13px;font-weight:600}.dsh-rho-question>div{display:flex;gap:10px;align-items:flex-end;margin:7px 0}.dsh-rho textarea{flex:1;min-width:0;resize:vertical;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);padding:9px 11px}.dsh-rho-question button{background:#24745c;color:#fff;border-color:#24745c}.dsh-rho-question p{font-size:11px;color:var(--text-muted)}.dsh-rho [role=alert]{color:#a03729}.dsh-rho-error{padding:10px;background:#fff3ed;border-radius:8px;margin-bottom:12px}.dsh-rho-empty{margin:auto;max-width:470px;text-align:center;padding:28px}.dsh-rho-empty p{color:var(--text-muted);margin-top:10px}.dsh-rho-empty code{font-size:12px}
@media(max-width:760px){.dsh-rho{padding:12px}.dsh-rho-heading>div{display:block}.dsh-rho-workspace{flex-direction:column;gap:12px;overflow:auto}.dsh-rho nav{width:100%;display:flex;gap:6px;flex-shrink:0;max-height:112px}.dsh-rho nav button{min-width:180px;width:180px;margin:0}.dsh-rho-result{min-height:460px}.dsh-rho-question>div{flex-direction:column;align-items:stretch}.dsh-rho textarea{width:100%}}
`;

export const name = 'dsh-rho';
export const inject = ['slots'];
export function apply(ctx: any) {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'rho', order: 25, label: () => 'Rho' }, RhoView));
}
