import { useEffect, useId, useMemo, useState } from 'react';
import type { BrowserClient, ViewDescription, WorkspaceSnapshot } from '../../src/browser.js';
import { executionWord } from '../../src/execution-facts.js';
import type { Live } from './live.js';
import { runObject } from './facts.js';

// The form for one action an Agent proposed: its
// inputs as fields the person reads and edits, checked by the owner's own contract, and
// submitted once under the operationId the Agent chose. That identity is what makes a
// refresh or a second click safe: the owner answers it with the run it already accepted.
type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; oneOf?: Schema[]; anyOf?: Schema[]; minimum?: number; maximum?: number };
type Problem = { path: string; message: string; fix?: string };
type Value = unknown;

const kind = (schema: Schema | undefined) => Array.isArray(schema?.type) ? undefined : schema?.type;
const admitsString = (schema: Schema | undefined): boolean => !!schema && (kind(schema) === 'string' || !!schema.oneOf?.some(admitsString) || !!schema.anyOf?.some(admitsString));
const admitsNull = (schema: Schema | undefined): boolean => !!schema && (kind(schema) === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')) || !!schema.oneOf?.some(admitsNull) || !!schema.anyOf?.some(admitsNull));
// A reference pins an exact file, document or resource version by its digest. A person reads
// it by name; changing which version runs is the Agent's to propose, so it is not edited here.
const pinned = (value: Value): boolean => typeof value === 'string' ? /^[a-f0-9]{64}$/.test(value) : !!value && typeof value === 'object' && Object.values(value).some(pinned);
function referenceName(value: Value, snapshot: WorkspaceSnapshot): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, any>;
  if (typeof v.path === 'string') return v.kind === 'disk' ? `${v.path} · the saved file the Agent proposed` : v.path;
  if (typeof v.documentId === 'string') { const doc = snapshot.documents.find(d => d.id === v.documentId); return doc ? `${doc.path} · version ${v.version}` : 'A document that is not open in this project'; }
  const ref = v.resource ?? v;
  if (typeof ref.id === 'string') { const r = snapshot.resources.find(x => x.id === ref.id && x.version === ref.version); return r ? `${r.path} · the version the Agent proposed` : 'A file version that is not registered here'; }
  return null;
}
// A field is drawn as a control when its schema and its value say plainly what it is;
// everything else is edited as JSON, which loses nothing.
function control(schema: Schema | undefined, value: Value): 'text' | 'optional-text' | 'number' | 'boolean' | 'choice' | 'lines' | 'reference' | 'object' | 'json' {
  if (!schema) return 'json';
  if (pinned(value) && (!Array.isArray(value) || value.every(item => typeof item === 'string' || pinned(item)))) return 'reference';
  if (schema.enum?.every(option => typeof option === 'string')) return 'choice';
  const type = kind(schema);
  if (type === 'string' && (value === undefined || typeof value === 'string')) return 'text';
  if (!type && admitsString(schema) && admitsNull(schema) && (value === null || typeof value === 'string')) return 'optional-text';
  if ((type === 'number' || type === 'integer') && (value === undefined || typeof value === 'number')) return 'number';
  if (type === 'boolean' && (value === undefined || typeof value === 'boolean')) return 'boolean';
  if (type === 'array' && Array.isArray(value) && value.every(item => typeof item === 'string') && admitsString(schema.items)) return 'lines';
  if (type === 'object' && schema.properties && !schema.oneOf && !schema.anyOf && value !== null && typeof value === 'object' && !Array.isArray(value)) return 'object';
  return 'json';
}

export function ActionForm({ view, snapshot, client, live }: { view: ViewDescription; snapshot: WorkspaceSnapshot; client: BrowserClient; live: Live }) {
  const props = view.props as { title?: string; action: string; actionVersion: string; operationId: string; input: Record<string, Value>; repairOf?: string };
  const action = snapshot.catalog.actions.find(a => a.id === props.action && a.version === props.actionVersion);
  const schema = (action?.inputSchema ?? {}) as Schema;
  const [input, setInput] = useState<Record<string, Value>>(() => structuredClone(props.input ?? {}));
  const [unparsed, setUnparsed] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Problem[] | null>(null), [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false), [refusal, setRefusal] = useState(''), [lost, setLost] = useState(false);
  const allowed = (method: string) => snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized);
  const run = live.runs?.find(r => r.operationId === props.operationId);
  const body = useMemo(() => ({ projectId: snapshot.project.id, operationId: props.operationId, action: props.action, actionVersion: props.actionVersion, input, ...(props.repairOf ? { repairOf: props.repairOf } : {}) }), [snapshot.project.id, props.operationId, props.action, props.actionVersion, props.repairOf, input]);
  // The owner's contract decides what is valid; the form only shows where.
  useEffect(() => {
    if (run || !allowed('protocol.validate')) return;
    let current = true; setChecking(true);
    const timer = setTimeout(() => {
      client.call('protocol.validate', { method: 'action.submit', body }, AbortSignal.timeout(15000))
        .then(result => { if (current) setProblems(result.problems.map(p => ({ path: p.path, message: p.message, fix: p.fix }))); }, () => { if (current) setProblems(null); })
        .finally(() => { if (current) setChecking(false); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [body, run, client]);
  const blocked = Object.keys(unparsed).length > 0 || checking || !!problems?.length;
  async function submit() {
    setSubmitting(true); setRefusal(''); setLost(false);
    // The owner checks the proposal against its own contract; the form does not narrow it in advance.
    try { await client.call('action.submit', body as never, AbortSignal.timeout(60000)); }
    catch (error) {
      // A refusal names its kind. A reply that never arrived does not, and the run may exist:
      // the project's runs say whether it does, and sending the same operationId again is safe.
      const refused = (error as { error?: { kind?: string; message?: string } })?.error;
      if (refused?.kind) setRefusal(refused.message ?? 'The owner did not accept this run.');
      else setLost(true);
    }
    finally { setSubmitting(false); live.readRuns(); }
  }
  const at = (path: string) => (problems ?? []).filter(p => p.path === path || p.path.startsWith(path + '/') || p.path.startsWith(path + '.'));
  const problemPath = (key: string) => '/input/' + key;
  if (!action) return <section className="shell-action" data-owner-body="" aria-label={props.title ?? props.action}>
    <h2>{props.title ?? props.action}</h2><p role="status">{props.action} {props.actionVersion} is not registered in this project.</p>
  </section>;
  return <section className="shell-action" data-owner-body="" data-rho-action-form={props.operationId} aria-label={props.title ?? props.action}>
    <h2>{props.title ?? action.presentation?.displayName ?? props.action}</h2>
    <p className="shell-action-identity"><code>{props.operationId}</code> · {action.presentation?.displayName ?? props.action} {props.actionVersion}{props.repairOf ? <> · repairs <code>{props.repairOf}</code></> : null}</p>
    {run ? <p role="status" data-rho-submitted={props.operationId}>
      Submitted · <span className={'shell-state ' + run.execution}>{executionWord(run.execution)}</span>{' '}
      <button className="shell-link" onClick={() => { const o = runObject(live, run.operationId); if (o) live.act({ kind: 'open', target: o }); }}>Open run</button>
    </p> : <form onSubmit={event => { event.preventDefault(); if (!blocked && !submitting) void submit(); }}>
      {Object.entries(schema.properties ?? {}).filter(([key]) => key in input || schema.required?.includes(key)).map(([key, field]) =>
        <Field key={key} name={key} path={problemPath(key)} schema={field} value={input[key]} snapshot={snapshot} problems={at(problemPath(key))}
          onValue={value => setInput(previous => ({ ...previous, [key]: value }))}
          onUnparsed={(path, text) => setUnparsed(previous => { const next = { ...previous }; if (text === null) delete next[path]; else next[path] = text; return next; })} />)}
      {problems && at('/input').filter(p => !Object.keys(schema.properties ?? {}).some(key => p.path.startsWith(problemPath(key)))).map((p, i) => <p key={i} role="alert" className="shell-field-problem">{p.message}{p.fix ? ' · ' + p.fix : ''}</p>)}
      {refusal && <p role="alert" className="shell-field-problem">{refusal}</p>}
      {lost && <p role="status" data-rho-lost={props.operationId}>The reply did not arrive, and the project's runs do not show {props.operationId} yet. Sending it again cannot start a second run.</p>}
      <div className="shell-action-submit">
        <button type="submit" disabled={blocked || submitting || !allowed('action.submit')}>{submitting ? 'Submitting…' : lost ? 'Send again' : 'Run'}</button>
        {checking ? <span role="status">Checking…</span> : problems?.length ? <span role="status">{problems.length} to fix</span> : null}
      </div>
    </form>}
  </section>;
}

function Field({ name, path, schema, value, snapshot, problems, onValue, onUnparsed }: { name: string; path: string; schema: Schema; value: Value; snapshot: WorkspaceSnapshot; problems: Problem[]; onValue: (value: Value) => void; onUnparsed: (path: string, text: string | null) => void }) {
  const id = useId(), how = control(schema, value), said = problems.filter(p => how !== 'object' || p.path === path);
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [parseProblem, setParseProblem] = useState('');
  const described = said.length || parseProblem ? id + '-problem' : undefined;
  const common = { id, 'aria-invalid': !!described || undefined, 'aria-describedby': described };
  let editor;
  if (how === 'object') {
    const record = value as Record<string, Value>;
    return <fieldset className="shell-field-group"><legend>{name}</legend>
      {Object.entries(schema.properties ?? {}).filter(([key]) => key in record || schema.required?.includes(key)).map(([key, field]) =>
        <Field key={key} name={key} path={path + '/' + key} schema={field} value={record[key]} snapshot={snapshot} problems={problems.filter(p => p.path === path + '/' + key || p.path.startsWith(path + '/' + key + '/'))} onValue={next => onValue({ ...record, [key]: next })} onUnparsed={onUnparsed} />)}
      {said.map((p, i) => <p key={i} role="alert" className="shell-field-problem">{p.message}{p.fix ? ' · ' + p.fix : ''}</p>)}
    </fieldset>;
  }
  if (how === 'reference') {
    const names = (Array.isArray(value) ? value : [value]).map(item => typeof item === 'string' ? (pinned(item) ? 'A pinned version' : item) : referenceName(item, snapshot) ?? 'A pinned reference');
    return <div className="shell-field">
      <span className="shell-field-name" id={id}>{name}</span>
      <ul className="shell-field-references" aria-labelledby={id} data-rho-reference={name}>{names.map((label, i) => <li key={i}>{label}</li>)}</ul>
      {said.length > 0 && <p role="alert" className="shell-field-problem">{said.map(p => p.message + (p.fix ? ' · ' + p.fix : '')).join(' · ')}</p>}
    </div>;
  }
  if (how === 'choice') editor = <select {...common} value={String(value ?? '')} onChange={e => onValue(e.target.value)}>{(schema.enum as string[]).map(option => <option key={option} value={option}>{option}</option>)}</select>;
  else if (how === 'text') editor = <input {...common} value={String(value ?? '')} onChange={e => onValue(e.target.value)} />;
  // Empty means none: the owner's contract accepts no value here, and no word stands in for it.
  else if (how === 'optional-text') editor = <input {...common} value={typeof value === 'string' ? value : ''} onChange={e => onValue(e.target.value === '' ? null : e.target.value)} />;
  else if (how === 'number') editor = <input {...common} type="number" value={value === undefined ? '' : String(value)} min={schema.minimum} max={schema.maximum} step={kind(schema) === 'integer' ? 1 : 'any'} onChange={e => onValue(e.target.value === '' ? undefined : Number(e.target.value))} />;
  else if (how === 'boolean') editor = <input {...common} type="checkbox" checked={value === true} onChange={e => onValue(e.target.checked)} />;
  else if (how === 'lines') editor = <textarea {...common} rows={Math.min(8, Math.max(2, (value as string[]).length + 1))} value={(value as string[]).join('\n')} onChange={e => onValue(e.target.value === '' ? [] : e.target.value.split('\n'))} />;
  else editor = <textarea {...common} className="shell-field-json" rows={Math.min(10, Math.max(2, text.split('\n').length))} value={text} spellCheck={false} onChange={e => {
    setText(e.target.value);
    try { onValue(JSON.parse(e.target.value)); setParseProblem(''); onUnparsed(path, null); }
    catch { setParseProblem('Not valid JSON yet'); onUnparsed(path, e.target.value); }
  }} />;
  return <div className={'shell-field' + (how === 'boolean' ? ' inline' : '')}>
    <label htmlFor={id}>{name}{how === 'lines' ? ' · one per line' : how === 'json' ? ' · JSON' : ''}</label>
    {editor}
    {described && <p id={id + '-problem'} role="alert" className="shell-field-problem">{[parseProblem, ...said.map(p => p.message + (p.fix ? ' · ' + p.fix : ''))].filter(Boolean).join(' · ')}</p>}
  </div>;
}
