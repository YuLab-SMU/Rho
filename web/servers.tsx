import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { Icon } from './icons.js';
import { at, languageName, languages, latestSessions, useAuthors, useKernel, versionOf, type Session } from './notebook.js';
import './servers.css';

// Where the live sessions run: this machine, or a folder on a server the person reaches with
// ssh. Each place says what a connection to it last saw (its system, its folder, R and Python
// there), which sessions run there now, and where each language's next session starts. A place's
// files are listed as the server has them, and a file is copied into the project to be looked at
// in its own viewer; a copy says when the file on the server has changed since.
type Places = RhoOutput<'kernel.places'>;
type Place = Places['places'][number];
type Check = NonNullable<Place['check']>;
type Listing = RhoOutput<'kernel.place.list'>;
type Language = Session['language'];
const failure = (error: unknown) => error instanceof Error ? error.message : 'The server could not be reached.';
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const day = (iso: string) => { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? at(iso) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };

// The project's places, read again whenever the sessions change.
export function usePlaces(client: BrowserClient, projectId: string, cursor: number) {
  const [places, setPlaces] = useState<Places | null>(null);
  const [problem, setProblem] = useState('');
  const again = () => client.call('kernel.places', { projectId }).then(value => { setPlaces(value); setProblem(''); }, error => setProblem(failure(error)));
  useEffect(() => { void again(); }, [client, projectId, cursor]);
  return { places, problem, again, setPlaces };
}
// Where a session runs, as a phrase: "on Lab server", or nothing for this machine.
export const whereOf = (session: Pick<Session, 'place'> | undefined) => session?.place ? 'on ' + session.place.label : '';

// A file named in a session on a server is shown in the Servers view, in its folder there.
let asked: { placeId: string; path: string; at: number } | null = null;
const listeners = new Set<() => void>();
export function showOnServer(placeId: string, path: string) { asked = { placeId, path, at: Date.now() }; for (const listener of listeners) listener(); }
const useAsked = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => asked);

// Which place a language's next cell runs in, beside the language chip: the live session's place,
// else the one the project chose. Choosing another changes where the next session starts; a live
// session stays where it is until it is stopped.
export function PlaceChip({ client, projectId, language, session, places, onChanged }: { client: BrowserClient; projectId: string; language: Language; session: Session | undefined; places: Places | null; onChanged: (places: Places) => void }) {
  const [problem, setProblem] = useState('');
  if (!places || !places.places.length) return null;
  const live = session && session.state !== 'ended' ? session : undefined, chosen = places.use[language];
  const label = (id: string) => id === 'local' ? 'This machine' : places.places.find(p => p.placeId === id)?.label ?? id;
  const shown = live ? (live.place ? live.place.label : 'This machine') : label(chosen);
  const choose = (id: string) => client.call('kernel.place.set', { projectId, use: { [language]: id } }).then(onChanged, error => setProblem(failure(error)));
  return <details className="sv-chip">
    <summary title={`Where ${languageName[language]} runs`}><Icon name={(live ? live.place : chosen !== 'local') ? 'server' : 'monitor'} size={11} stroke={2} />{shown}<Icon name="updown" size={10} stroke={2.2} /></summary>
    <div className="sv-chip-menu" role="group" aria-label={`Where ${languageName[language]} runs`}>
      {['local', ...places.places.map(p => p.placeId)].map(id => <button key={id} type="button" aria-pressed={chosen === id} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void choose(id); }}>
        <Icon name={id === 'local' ? 'monitor' : 'server'} size={14} /><span>{label(id)}</span>{chosen === id && <Icon name="check" size={13} />}</button>)}
      {live && (live.place?.placeId ?? 'local') !== chosen && <p>The live {languageName[language]} session stays {live.place ? 'on ' + live.place.label : 'on this machine'} until it is stopped; the next one starts on {label(chosen)}.</p>}
      {problem && <p className="inline-error">{problem}</p>}
    </div>
  </details>;
}

export function ServersPane({ client, snapshot, onPath }: { client: BrowserClient; snapshot: WorkspaceSnapshot; onPath?: (path: string) => void }) {
  const projectId = snapshot.project.id;
  const { places, problem, setPlaces } = usePlaces(client, projectId, snapshot.cursor);
  const { read } = useKernel(client, projectId, snapshot.cursor);
  const latest = useMemo(() => latestSessions(read), [read]);
  const who = useAuthors(snapshot);
  const [form, setForm] = useState<Place | 'new' | null>(null);
  const [checking, setChecking] = useState<string[]>([]);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [browsing, setBrowsing] = useState<{ placeId: string; path: string; focus?: string } | null>(null);
  const request = useAsked();
  useEffect(() => { if (request) setBrowsing({ placeId: request.placeId, path: request.path.replace(/\/?[^/]*$/, ''), focus: request.path.split('/').at(-1) }); }, [request?.at]);
  const id = useId();
  if (!places) return <div className="nb-pane"><p className="nb-empty-line">{problem || 'Reading where the sessions run…'}</p></div>;

  const name = (by: string) => { const n = who(by).name; return n === 'You' ? 'you' : n; };
  const sessionsOn = (placeId: string) => languages.map(l => latest[l]).filter((s): s is Session => !!s && (s.place?.placeId ?? 'local') === placeId);
  const use = (language: Language, placeId: string) => client.call('kernel.place.set', { projectId, use: { [language]: placeId } }).then(setPlaces, error => setProblems(p => ({ ...p, [placeId]: failure(error) })));
  async function check(place: Place) {
    setChecking(c => [...c, place.placeId]); setProblems(p => ({ ...p, [place.placeId]: '' }));
    try { const { check } = await client.call('kernel.place.check', { projectId, placeId: place.placeId }); setPlaces(now => now && { ...now, places: now.places.map(p => p.placeId === place.placeId ? { ...p, check } : p) }); }
    catch (error) { setProblems(p => ({ ...p, [place.placeId]: failure(error) })); }
    finally { setChecking(c => c.filter(x => x !== place.placeId)); }
  }
  async function remove(place: Place) {
    if (!window.confirm(`Remove ${place.label}? Sessions will no longer start there; files copied from it stay in the project.`)) return;
    try { setPlaces(await client.call('kernel.place.set', { projectId, remove: place.placeId })); if (browsing?.placeId === place.placeId) setBrowsing(null); }
    catch (error) { setProblems(p => ({ ...p, [place.placeId]: failure(error) })); }
  }
  const runsHere = (placeId: string) => <span className="sv-runs" role="group" aria-label="New sessions start here"><small>New sessions</small>{languages.map(l => <button key={l} type="button" aria-pressed={places.use[l] === placeId} title={places.use[l] === placeId ? `New ${languageName[l]} sessions start here` : `Start new ${languageName[l]} sessions here`} onClick={() => void use(l, placeId)}>{languageName[l]}</button>)}</span>;

  return <div className="nb-pane sv-pane" aria-labelledby={id}>
    <header className="sv-head">
      <h2 id={id} className="nb-pane-state">Where code runs</h2>
      {form !== 'new' && <button className="secondary" onClick={() => setForm('new')}><Icon name="plus" size={13} stroke={2} />Add a server</button>}
    </header>
    <p className="sv-lede">R and Python run on this machine or on a server you reach with ssh. Each language's next session starts where it is marked.</p>
    {form === 'new' && <PlaceForm client={client} projectId={projectId} places={places.places} onDone={(next, added) => { setForm(null); if (next) setPlaces(next); if (added) void check(added); }} />}
    <ul className="sv-places">
      <li className="sv-place">
        <div className="sv-place-head"><Icon name="monitor" size={16} /><strong>This machine</strong>{runsHere('local')}</div>
        <Sessions sessions={sessionsOn('local')} />
      </li>
      {places.places.map(place => {
        const busy = checking.includes(place.placeId), lost = sessionsOn(place.placeId).filter(s => s.ending === 'disconnected');
        return <li key={place.placeId} className={'sv-place' + (browsing?.placeId === place.placeId ? ' open' : '')}>
          {form !== 'new' && form?.placeId === place.placeId
            ? <PlaceForm client={client} projectId={projectId} places={places.places} editing={place} onDone={(next, changed) => { setForm(null); if (next) setPlaces(next); if (changed) void check(changed); }} />
            : <>
              <div className="sv-place-head"><Icon name="server" size={16} /><strong>{place.label}</strong>{runsHere(place.placeId)}</div>
              <p className="sv-where"><code>{place.destination}</code><span>{place.check?.folder ?? place.folder}</span></p>
              <CheckLine check={place.check} busy={busy} name={name} />
              {place.setup && <details className="sv-setup"><summary>Before a session starts</summary><pre>{place.setup}</pre></details>}
              <Sessions sessions={sessionsOn(place.placeId).filter(s => s.state !== 'ended')} />
              {lost.map(s => <p key={s.sessionId} className="sv-lost"><Icon name="offline" size={13} />The {languageName[s.language]} session lost its connection at {at(s.endedAt!)}. Its process there{s.pid ? ` (${s.pid})` : ''} was not seen to end, and the cell it was running may have gone on.</p>)}
              {problems[place.placeId] && <p className="inline-error" role="alert">{problems[place.placeId]}</p>}
              <footer className="sv-actions">
                <button className="secondary" disabled={busy} onClick={() => void check(place)}><Icon name="signal" size={13} />{busy ? 'Checking…' : 'Check'}</button>
                <button className="secondary" aria-pressed={browsing?.placeId === place.placeId} onClick={() => setBrowsing(browsing?.placeId === place.placeId ? null : { placeId: place.placeId, path: '' })}><Icon name="folder" size={13} />Files</button>
                <span className="sv-by">Named by {name(place.by)} · {day(place.at)}</span>
                <button className="text-button" onClick={() => setForm(place)}>Edit</button>
                <button className="text-button" disabled={sessionsOn(place.placeId).some(s => s.state !== 'ended')} title={sessionsOn(place.placeId).some(s => s.state !== 'ended') ? 'A live session runs there' : undefined} onClick={() => void remove(place)}>Remove</button>
              </footer>
            </>}
        </li>;
      })}
    </ul>
    {!places.places.length && form !== 'new' && <p className="nb-empty-line">No servers yet. Add one with its ssh name (a Host in your ssh config, or user@host) and the folder you work in there, or ask the Agent to set one up.</p>}
    {browsing && places.places.some(p => p.placeId === browsing.placeId) && <Files key={browsing.placeId} client={client} projectId={projectId} place={places.places.find(p => p.placeId === browsing.placeId)!} start={browsing.path} focus={browsing.focus}
      copies={places.copies.filter(c => c.placeId === browsing.placeId)} onCopied={copy => setPlaces(now => now && { ...now, copies: [...now.copies.filter(c => c.to !== copy.to), copy] })} onPath={onPath} />}
  </div>;
}

function CheckLine({ check, busy, name }: { check: Check | null; busy: boolean; name: (by: string) => string }) {
  if (busy && !check) return <p className="sv-check">Connecting…</p>;
  if (!check) return <p className="sv-check">Not checked yet.</p>;
  const missing = [check.r && check.jsonlite === false && 'jsonlite for R', check.python && check.matplotlib === false && 'matplotlib for figures in Python'].filter(Boolean);
  return <div className={'sv-check' + (check.ok ? '' : ' problem')}>
    {check.ok ? <p>{[check.system, check.r?.replace(/^R version (\S+).*$/, 'R $1') ?? 'no R', check.python ?? 'no Python'].filter(Boolean).join(' · ')}{check.host && <span className="sv-host"> · {check.host}</span>}</p> : <p>{check.problem}</p>}
    {missing.length > 0 && <p className="sv-missing">Not installed there: {missing.join(', ')}.</p>}
    <small>{busy ? 'Checking again…' : `Checked by ${name(check.by)} at ${day(check.at)} · ${(check.ms / 1000).toFixed(1)} s`}</small>
  </div>;
}

function Sessions({ sessions }: { sessions: Session[] }) {
  const live = sessions.filter(s => s.state !== 'ended');
  if (!live.length) return null;
  return <ul className="sv-sessions">{live.map(s => <li key={s.sessionId} className={s.state}>
    <span className={'nb-dot ' + s.state} aria-hidden="true" />{versionOf(s)} · {s.state === 'busy' ? 'running a cell' : s.state === 'starting' ? 'starting' : 'idle'} · {s.variables.length + s.variablesOmitted} {s.variables.length + s.variablesOmitted === 1 ? 'value' : 'values'}
    {s.host && s.place && <small> · on {s.host}{s.pid ? `, process ${s.pid}` : ''}</small>}
  </li>)}</ul>;
}

// A place is named by the person here, or by the Agent through the same operation.
function PlaceForm({ client, projectId, places, editing, onDone }: { client: BrowserClient; projectId: string; places: Place[]; editing?: Place; onDone: (places: Places | null, changed?: Place) => void }) {
  const [label, setLabel] = useState(editing?.label ?? '');
  const [destination, setDestination] = useState(editing?.destination ?? '');
  const [folder, setFolder] = useState(editing?.folder ?? '~/');
  const [setup, setSetup] = useState(editing?.setup ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const id = useId();
  // The place's id comes from its name, and stays when it is renamed.
  const placeId = editing?.placeId ?? (() => {
    const base = (label.trim() || destination.split(/[@:/]/).filter(Boolean).at(-1) || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 28) || 'server';
    let candidate = base === 'local' ? 'local-server' : base, n = 2;
    while (places.some(p => p.placeId === candidate)) candidate = `${base}-${n++}`;
    return candidate;
  })();
  async function save() {
    setBusy(true); setProblem('');
    try {
      const next = await client.call('kernel.place.set', { projectId, place: { placeId, label: label.trim() || destination.trim(), destination: destination.trim(), folder: folder.trim(), setup } });
      onDone(next, next.places.find(p => p.placeId === placeId));
    } catch (error) { setProblem(failure(error)); }
    finally { setBusy(false); }
  }
  return <form className="sv-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <h3>{editing ? `Edit ${editing.label}` : 'Add a server'}</h3>
    <label htmlFor={id + 'd'}>ssh name<small>A Host in your ssh config, user@host or ssh://user@host:port. ssh logs in with your own keys and agent; it never asks for a password here.</small></label>
    <input id={id + 'd'} value={destination} onChange={e => setDestination(e.target.value)} placeholder="lab-server or me@lab.example.org" autoComplete="off" spellCheck={false} required />
    <label htmlFor={id + 'f'}>Folder there<small>Where sessions run and paths start. ~ is your home there.</small></label>
    <input id={id + 'f'} value={folder} onChange={e => setFolder(e.target.value)} placeholder="~/projects/rnaseq" autoComplete="off" spellCheck={false} required />
    <label htmlFor={id + 'n'}>Name<small>How Rho names it.</small></label>
    <input id={id + 'n'} value={label} onChange={e => setLabel(e.target.value)} placeholder={destination || 'Lab server'} maxLength={80} />
    <label htmlFor={id + 's'}>Before a session starts<small>Shell lines run in the folder first, as in your terminal there.</small></label>
    <textarea id={id + 's'} value={setup} onChange={e => setSetup(e.target.value)} rows={2} placeholder={'module load R/4.3\nconda activate rnaseq'} spellCheck={false} />
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    <div className="sv-form-foot">
      <button type="button" className="text-button" onClick={() => onDone(null)}>Cancel</button>
      <button type="submit" className="primary" disabled={busy || !destination.trim() || !folder.trim()}>{busy ? 'Saving…' : editing ? 'Save and check' : 'Add and check'}</button>
    </div>
  </form>;
}

// A folder of a place as the server lists it now. A file opens from its copy in the project; one
// not copied yet, or changed on the server since, is copied first.
function Files({ client, projectId, place, start, focus, copies, onCopied, onPath }: {
  client: BrowserClient; projectId: string; place: Place; start: string; focus?: string; copies: Places['copies']; onCopied: (copy: Places['copies'][number]) => void; onPath?: (path: string) => void;
}) {
  const [path, setPath] = useState(start);
  const [listing, setListing] = useState<Listing | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState('');
  const [copying, setCopying] = useState('');
  const [copyProblem, setCopyProblem] = useState<{ path: string; text: string } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => setPath(start), [start]);
  useEffect(() => {
    let live = true;
    setReading(true); setProblem('');
    client.call('kernel.place.list', { projectId, placeId: place.placeId, path }).then(value => { if (live) setListing(value); }, error => { if (live) { setProblem(failure(error)); setListing(null); } }).finally(() => { if (live) setReading(false); });
    return () => { live = false; };
  }, [client, projectId, place.placeId, path, round]);
  useEffect(() => { if (focus && listing) document.querySelector(`[data-remote="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'nearest' }); }, [focus, listing]);
  const parts = path ? path.split('/') : [];
  const full = (entry: string) => (path ? path + '/' : '') + entry;
  async function open(file: string, fresh: boolean) {
    const copy = copies.find(c => c.path === file);
    if (copy && !fresh) { onPath?.(copy.to); return; }
    setCopying(file); setCopyProblem(null);
    try { const { copy } = await client.call('kernel.place.copy', { projectId, placeId: place.placeId, path: file }); onCopied(copy); onPath?.(copy.to); }
    catch (error) { setCopyProblem({ path: file, text: failure(error) }); }
    finally { setCopying(''); }
  }
  return <section className="sv-files" aria-label={`Files on ${place.label}`}>
    <header>
      <h3>Files on {place.label}</h3>
      <button className="text-button" disabled={reading} title="List the folder again" onClick={() => setRound(r => r + 1)}><Icon name="refresh" size={13} />{reading ? 'Listing…' : 'Refresh'}</button>
    </header>
    <nav className="sv-crumbs" aria-label="Folder">
      <button onClick={() => setPath('')}>{listing && !path ? listing.folder : place.folder}</button>
      {parts.map((part, i) => <span key={i}>/<button onClick={() => setPath(parts.slice(0, i + 1).join('/'))}>{part}</button></span>)}
    </nav>
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    {listing && !problem && (!listing.entries.length ? <p className="nb-empty-line">This folder is empty.</p>
      : <ul className="sv-entries">{listing.entries.map(entry => {
        const file = full(entry.name), copy = copies.find(c => c.path === file);
        const changed = copy && (copy.bytes !== entry.bytes || copy.modifiedAt !== entry.modifiedAt);
        return <li key={entry.name} data-remote={entry.name} className={entry.name === focus && path === start ? 'focus' : ''}>
          {entry.kind === 'folder' || entry.kind === 'link'
            ? <button className="sv-entry" onClick={() => setPath(file)}><Icon name={entry.kind === 'link' ? 'link' : 'folder'} size={14} /><span>{entry.name}</span></button>
            : <button className="sv-entry" disabled={entry.kind !== 'file' || copying === file} title={copy ? `Open the copy in ${copy.to}` : 'Copy it into the project and open it'} onClick={() => void open(file, false)}><Icon name="file" size={14} /><span>{entry.name}</span></button>}
          <small>{entry.kind === 'file' ? size(entry.bytes) : ''}</small>
          <small>{entry.modifiedAt ? day(entry.modifiedAt) : ''}</small>
          {entry.kind === 'file' && <span className="sv-copy">
            {copying === file ? 'Copying…' : copy ? <>{changed ? <button className="text-button" title={`Copied ${day(copy.copiedAt)}; the file on ${place.label} has changed since`} onClick={() => void open(file, true)}>Changed · copy again</button> : <span title={copy.to}>Copied</span>}</> : null}
          </span>}
          {copyProblem?.path === file && <p className="inline-error" role="alert">{copyProblem.text}</p>}
        </li>;
      })}</ul>)}
    {listing && (listing.omitted > 0 || listing.cut) && <p className="nb-note">{listing.omitted > 0 ? `${listing.omitted} more entries are not listed.` : 'The listing was cut at its size limit.'}</p>}
    <p className="nb-note">Opening a file copies it into the project under <code>remote/{place.placeId}/</code>; the file on the server is not changed.</p>
  </section>;
}
