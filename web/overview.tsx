import { useEffect, useRef, useState } from 'react';
import type { BrowserClient, CapabilityCatalog, ProjectSummary, ResourceSummary, WorkspaceSnapshot } from '../src/browser.js';
import { attention, executionWord, integrityWord, producerOf, readRuns, results, shortPath } from '../src/execution-facts.js';
import { term } from '../src/task-frame.js';
import { useRuns } from './executions.js';
import { projectName, SourceFolders, when } from './home.js';
import { Icon } from './icons.js';
import { availability, resourceIcon, size, views, type Entry, type Section } from './project.js';
import { renders } from './rendered.js';
import { RunView } from './shell/facts.js';

// The project page, loaded when a project opens rather than with the home page.
// A document viewer exists only when this build renders a component that binds documents.
function documentViewer(catalog: CapabilityCatalog) {
  const viewer = catalog.components.find(c => Object.values(c.bindings).includes('document') && renders(c.id, c.version));
  return viewer ? viewer.presentation?.displayName ?? viewer.id : 'Not in this build';
}
function sourcePath(project: ProjectSummary, value: string) {
  const source = project.sources?.find(s => value.startsWith('@' + s.id + '/'));
  return source ? source.name + '/' + value.slice(source.id.length + 2) : value;
}
// The project page answers, in order: what is this work about, what did the owners
// observe, which artifact carries the result, what did the Agent declare, and only
// then the execution ledger. Files, documents and diagnostics stay reachable but sit
// where a reader goes to check rather than where they arrive.
export function ProjectOverview({ project, location, snapshot, onLayout, client, onProjectChanged, onOpened }: { project: ProjectSummary; location: string; snapshot: WorkspaceSnapshot; onLayout: (id: string, view?: string) => void; client: BrowserClient; onProjectChanged: (p: ProjectSummary) => void; onOpened?: (compositionId: string) => void }) {
  const [adding, setAdding] = useState(false), [error, setError] = useState('');
  const [folder, setFolder] = useState<{ entries: Entry[]; total: number; truncated: boolean; path: string } | null>(null), [reading, setReading] = useState(false), [openProblem, setOpenProblem] = useState('');
  // "Nothing happened" is not an answer: this asks the service what is wrong and
  // shows the next action beside each finding.
  const [doctor, setDoctor] = useState<Array<{ id: string; state: 'ok' | 'warn' | 'fail'; detail: string; remedy: string }> | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  // Read again when the project changes, so the counts and records never describe an older state.
  const { runs, problem: runsProblem, readAgain } = useRuns(client, project.id, snapshot.cursor);
  // A run that needs attention opens from here in the same view the workspace gives it.
  const [inspecting, setInspecting] = useState<string | null>(null);
  async function diagnose() {
    setDiagnosing(true); setError('');
    try { setDoctor((await client.call('project.doctor', { projectId: project.id }, new AbortController().signal)).checks); }
    catch (e) { setError(e instanceof Error ? e.message : 'The project could not be checked.'); }
    finally { setDiagnosing(false); }
  }
  async function listFolder(at = '') {
    setReading(true); setError('');
    try {
      const result = await client.call('project.entries', at ? { projectId: project.id, path: at } : { projectId: project.id }, new AbortController().signal);
      setFolder({ entries: result.entries, total: result.total, truncated: result.truncated, path: result.path });
    }
    catch (e) { setError(e instanceof Error ? e.message : 'The folder could not be listed.'); }
    finally { setReading(false); }
  }
  async function open(entry: Entry) {
    setOpenProblem('');
    const current = snapshot.compositions.find(c => c.compositionId === 'workspace');
    try {
      // One conditional step: the server opens the document and places it in the tab's layout.
      const result = await client.call('project.openFile', { projectId: project.id, path: entry.path, compositionId: 'workspace', expectedVersion: current?.version ?? 0, changeId: 'open-' + entry.path.replace(/[^A-Za-z0-9._:@-]/g, '-').slice(0, 90) + '-' + Date.now() });
      if (onOpened) onOpened(result.composition.compositionId);
    } catch (e) { setOpenProblem(e instanceof Error ? e.message : 'The file could not be opened.'); }
  }
  async function add() {
    setAdding(true); setError('');
    try { const result = await client.call('project.source.add', { projectId: project.id }, new AbortController().signal); if (result.project) onProjectChanged(result.project); }
    catch (e) { setError(e instanceof Error ? e.message : 'The folder could not be added. Try again.'); }
    finally { setAdding(false); }
  }
  const added = when(project.openedAt), docs = snapshot.documents, files = snapshot.resources, viewer = documentViewer(snapshot.catalog);
  const map = snapshot.taskMap, reading2 = runs ? readRuns(runs) : null, watching = runs ? attention(runs) : [];
  // Every artifact version, newest first, with the view that already shows it.
  const places = new Map<string, { compositionId: string; viewId: string }>();
  for (const composition of snapshot.compositions) for (const view of composition.views) for (const binding of Object.values(view.bindings ?? {})) {
    const id = (binding as { id?: string }).id;
    if (id && !places.has(id)) places.set(id, { compositionId: composition.compositionId, viewId: view.id });
  }
  const artifacts = runs ? results(files, runs) : [];
  const checked = runs ? runs.some(run => run.domain === 'checked') : false;
  const runDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = runDialog.current; if (inspecting && element && !element.open) element.showModal(); }, [inspecting]);
  return <section className="overview" aria-labelledby="overview-title">
    <header className="overview-header">
      <h1 id="overview-title">{projectName(project)}</h1>
      <p><span>{location}</span>{added.text && <> · <span title={added.full}>added {added.text.replace(/^[TY]/, c => c.toLowerCase())}</span></>}</p>
    </header>
    <section className="overview-inquiry" aria-labelledby="overview-question">
      <h2 id="overview-question" tabIndex={-1}>{map?.question ?? 'No question has been declared for this project yet.'}</h2>
      {reading2 && <p className="overview-tally">
        <span>{runs!.length} {runs!.length === 1 ? 'run' : 'runs'} · {reading2.completed} completed{reading2.failed ? ' · ' + reading2.failed + ' failed' : ''}{reading2.moving ? ' · ' + reading2.moving + ' running' : ''}{reading2.unknown ? ' · ' + reading2.unknown + ' unknown' : ''}</span>
        {map && map.items.length > 0 && <span>{map.items.length} items the Agent declared</span>}
        {/* Executing code says nothing about whether a result is right; the absence
            of a domain check is a fact worth stating next to the run counts. */}
        <span>{checked ? 'a domain check was recorded' : 'no domain check recorded'}</span>
      </p>}
      {runsProblem && <p className="field-hint project-problem" role="alert">{runsProblem}</p>}
      {watching.length > 0 && <ul className="overview-attention">
        {watching.map(item => <li key={item.kind + item.operationId}>
          <button className="overview-attention-row" onClick={() => setInspecting(item.operationId)}>
            <span className={'state ' + item.kind}>{item.text}</span>
            <Icon name="chevron" size={11} stroke={1.8} />
          </button>
        </li>)}
      </ul>}
    </section>
    {artifacts.length > 0 && <section className="overview-section" aria-labelledby="overview-artifacts">
      <h2 id="overview-artifacts">Results</h2>
      <ul className="overview-artifacts">
        {artifacts.map(({ resource, run, earlier }) => {
          const place = places.get(resource.id);
          const body = <>
            <span className="overview-artifact-name"><Icon name={resourceIcon(resource.kind)} size={16} stroke={1.8} />{shortPath(resource.path)}</span>
            <span className="overview-artifact-origin">{run ? `${run.operationId} · ${executionWord(run.execution)}` : 'no recorded execution'}{earlier ? ` · ${earlier} earlier version${earlier === 1 ? '' : 's'}` : ''}</span>
            <span className={'state ' + (run?.execution === 'failed' ? 'failed' : run?.integrity === 'verified' ? 'good' : 'unknown')}>{run ? integrityWord(run.integrity) : 'unchecked'}</span>
          </>;
          return <li key={resource.id}>{place ? <button className="overview-artifact" onClick={() => onLayout(place.compositionId, place.viewId)}>{body}</button> : <div className="overview-artifact">{body}</div>}</li>;
        })}
      </ul>
    </section>}
    {map && map.items.length > 0 && <section className="overview-section" aria-labelledby="overview-items">
      <h2 id="overview-items">What the Agent declared</h2>
      <ol className="overview-items">
        {map.items.map(item => {
          const state = term(map, 'states', item.state), next = map.next.includes(item.id);
          // An item may name the exact artifact version it produced; that link wins
          // over a layout view because it opens the object itself.
          const named = item.artifact ? files.find(resource => resource.id === item.artifact!.id && resource.version === item.artifact!.version) : undefined;
          const view = named ? places.get(named.id) : item.view ? places.get(item.view) ?? { compositionId: map.compositionId ?? 'workspace', viewId: item.view } : undefined;
          const body = <>
            <span className="overview-item-title">{item.title}</span>
            {named && <span className="overview-item-artifact">{shortPath(named.path)}</span>}
            {/* The Agent's own state, so it gets a neutral mark: green is for facts an
                owner verified, and a declared "done" is not one of those. */}
            <span className={'overview-item-state state ' + (state.role === 'waiting' || state.role === 'working' ? 'pending' : 'declared')}>{state.label}</span>
            {next && <span className="overview-item-next">declared next</span>}
          </>;
          return <li key={item.id}>{view ? <button className="overview-item" onClick={() => onLayout(view.compositionId, view.viewId)}>{body}</button> : <div className="overview-item">{body}</div>}</li>;
        })}
      </ol>
    </section>}
    {runs && runs.length > 0 && <details className="overview-more">
      <summary>Execution records <span>{runs.length}</span></summary>
      <table><thead><tr><th>Operation</th><th className="column-state">Execution</th><th className="column-wide">Artifacts</th><th className="column-short optional">By</th></tr></thead>
        <tbody>{runs.map(run => <tr key={run.operationId}>
          <td><button className="overview-link" onClick={() => setInspecting(run.operationId)}>{run.operationId}</button></td>
          <td className="column-state"><span className={'state ' + (run.execution === 'completed' ? 'good' : run.execution === 'failed' ? 'failed' : run.execution === 'unknown' ? 'unknown' : 'pending')}>{executionWord(run.execution)}</span></td>
          <td className="column-wide meta">{run.declared.length === 0 ? '—' : `${run.declared.length - run.missing.length} of ${run.declared.length} on disk · ${integrityWord(run.integrity)}`}</td>
          <td className="column-short optional meta">{run.author}</td>
        </tr>)}</tbody></table>
      {runs.length === 0 && <p className="overview-none">Nothing has run in this project.</p>}
    </details>}
    <details className="overview-more" id="overview-documents-wrap">
      <summary>Documents and files <span>{docs.length} open · {files.length} registered</span></summary>
      <section className="overview-section" aria-labelledby="overview-documents">
        <h2 id="overview-documents" tabIndex={-1}>Documents</h2>
        {docs.length ? <table><thead><tr><th>Name</th><th className="column-short optional">Version</th><th className="column-state">State</th><th className="column-wide optional">Viewer</th></tr></thead>
          <tbody>{docs.map(d => <tr key={d.id}>
            <td><span className="overview-name"><Icon name="file" size={16} stroke={1.8} />{sourcePath(project, d.path)}</span></td>
            <td className="column-short optional">{d.version}</td>
            <td className="column-state"><span className={'state ' + (d.dirty ? 'pending' : 'good')}>{d.dirty ? 'Unsaved changes' : 'Saved'}</span></td>
            <td className="column-wide optional meta">{viewer}</td>
          </tr>)}</tbody></table> : <p className="overview-none">No documents are open in this project.</p>}
      </section>
      <section className="overview-section" aria-labelledby="overview-files">
        <h2 id="overview-files" tabIndex={-1}>Files <span>{folder ? folder.total : files.length}</span></h2>
        {folder ? <>
          <p className="field-hint">
            <span className="overview-name">{folder.path || projectName(project)}</span>
            {folder.path ? <button className="link" onClick={() => void listFolder(folder.path.split('/').slice(0, -1).join('/'))}>Up one folder</button> : null}
          </p>
          {folder.entries.length ? <table><thead><tr><th>Name</th><th className="column-short optional">Kind</th><th className="column-wide">Size</th></tr></thead>
            <tbody>{folder.entries.map(entry => <tr key={entry.path}>
              <td><button className="overview-link" onClick={() => void (entry.kind === 'folder' ? listFolder(entry.path) : open(entry))}><Icon name={entry.kind === 'folder' ? 'folder' : 'file'} size={16} stroke={1.8} />{entry.name}</button></td>
              <td className="column-short optional">{entry.kind === 'folder' ? 'Folder' : 'File'}</td>
              <td className="column-wide muted">{entry.kind === 'folder' ? '' : size(entry.bytes)}</td>
            </tr>)}</tbody></table> : <p className="overview-none">This folder has no files yet.</p>}
          {folder.truncated && <p className="field-hint">Showing the first {folder.entries.length} of {folder.total} entries.</p>}
          {openProblem && <p className="field-hint project-problem" role="alert">{openProblem}</p>}
          <p className="field-hint"><button className="link" onClick={() => setFolder(null)}>Hide folder contents</button></p>
        </> : <>
          <p className="overview-none">Open a file from this folder to read and edit it here.</p>
          <p className="field-hint"><button className="primary" disabled={reading} onClick={() => void listFolder()}>{reading ? 'Reading…' : 'Browse this folder…'}</button></p>
        </>}
        {files.length ? <table><thead><tr><th>Registered</th><th className="column-short optional">Kind</th><th className="column-state">State</th><th className="column-wide">Size</th></tr></thead>
          <tbody>{files.map(r => <tr key={r.id}>
            <td><span className="overview-name"><Icon name={resourceIcon(r.kind)} size={16} stroke={1.8} />{sourcePath(project, r.path)}</span></td>
            <td className="column-short optional">{r.kind.charAt(0).toUpperCase() + r.kind.slice(1)}</td>
            <td className="column-state"><span className={'state ' + (r.availability === 'available' ? 'good' : 'unknown')}>{availability(r)}</span></td>
            <td className="column-wide muted">{(r.availability === 'available' ? '' : 'Last seen ') + size(r.bytes)}</td>
          </tr>)}</tbody></table> : null}
      </section>
    </details>
    <details className="overview-more">
      <summary>This project's setup</summary>
      <section className="overview-section" aria-labelledby="overview-sources">
        <h2 id="overview-sources">Source folders</h2>
        <SourceFolders folders={project.sources ?? [{ id: project.id, root: project.root, name: projectName(project) }]} busy={adding} onAdd={() => void add()} />
        {error && <p className="field-hint project-problem" role="alert">{error}</p>}
      </section>
      {snapshot.compositions.length > 0 && <section className="overview-section" aria-labelledby="overview-layouts">
        <h2 id="overview-layouts" tabIndex={-1}>Layouts <span>{snapshot.compositions.length}</span></h2>
        <table><thead><tr><th>Name</th><th className="column-state">Views</th></tr></thead>
          <tbody>{snapshot.compositions.map(c => <tr key={c.compositionId}>
            <td><button className="overview-link" onClick={() => onLayout(c.compositionId)}><Icon name="layout" size={16} stroke={1.8} />{c.compositionId}</button></td>
            <td className="column-state">{views(c)}</td>
          </tr>)}</tbody></table>
      </section>}
      <section className="overview-section" aria-labelledby="overview-doctor">
        <h2 id="overview-doctor">Can this project do work?</h2>
        {doctor ? <>
          {doctor.map(check => <p key={check.id} className={'field-hint ' + (check.state === 'fail' ? 'project-problem' : '')}>
            <span className={'state ' + (check.state === 'ok' ? 'good' : check.state === 'warn' ? 'pending' : 'failed')}>{check.state === 'ok' ? 'Ready' : check.state === 'warn' ? 'Check' : 'Blocked'}</span>{' '}
            {check.detail}{check.remedy && <> — {check.remedy}</>}
          </p>)}
          <p className="field-hint"><button className="link" onClick={() => setDoctor(null)}>Hide the checks</button></p>
        </> : <p className="field-hint"><button disabled={diagnosing} onClick={() => void diagnose()}>{diagnosing ? 'Checking…' : 'Check this project…'}</button> What Rho can and cannot do here, with the next action for anything wrong.</p>}
      </section>
    </details>
    {/* Every way out goes through close(), so focus returns to the run that opened it. */}
    {inspecting && <dialog ref={runDialog} className="run-dialog" aria-label={inspecting} onClose={() => setInspecting(null)}
      onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      <button className="icon-button run-dialog-close" aria-label="Close" onClick={() => runDialog.current?.close()}><Icon name="close" size={14} stroke={2} /></button>
      <RunView key={inspecting} snapshot={snapshot} client={client} operationId={inspecting} runs={runs} readRuns={readAgain} onOpenRun={setInspecting}
        opener={ref => { const place = places.get(ref.id); return place ? () => onLayout(place.compositionId, place.viewId) : null; }} />
    </dialog>}
  </section>;
}
