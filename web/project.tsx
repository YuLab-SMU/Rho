import { useState } from 'react';
import type { BrowserClient, CapabilityCatalog, CompositionSummary, ProjectSummary, ResourceSummary, WorkspaceSnapshot } from '../src/browser.js';
import { projectName, SourceFolders, when } from './home.js';
import { Icon, type IconName } from './icons.js';
import { renders } from './rendered.js';

export type Section = 'documents' | 'files';
export interface Entry { path: string; name: string; kind: 'file' | 'folder'; bytes: number; hidden: boolean }
export function size(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)) + ' ' + units[unit];
}
export function resourceIcon(kind: string): IconName { return kind === 'table' ? 'table' : kind === 'image' ? 'image' : 'file'; }
export function availability(resource: ResourceSummary) {
  return resource.availability === 'available' ? 'Available' : resource.availability === 'partial' ? 'Partly readable' : resource.availability === 'missing' ? "Can't be read" : 'Not checked';
}
function views(composition: CompositionSummary) { return composition.views.length + (composition.views.length === 1 ? ' view' : ' views'); }
function sourcePath(project: ProjectSummary, value: string) {
  const source = project.sources?.find(s => value.startsWith('@' + s.id + '/'));
  return source ? source.name + '/' + value.slice(source.id.length + 2) : value;
}
// A document viewer exists only when this build renders a component that binds documents.
function documentViewer(catalog: CapabilityCatalog) {
  const viewer = catalog.components.find(c => Object.values(c.bindings).includes('document') && renders(c.id, c.version));
  return viewer ? viewer.presentation?.displayName ?? viewer.id : 'Not in this build';
}

export function ProjectNavigation({ project, location, snapshot, overview, compositionId, onOverview, onLayout, onSection }: {
  project: ProjectSummary; location: string; snapshot: WorkspaceSnapshot | null; overview: boolean; compositionId: string;
  onOverview: () => void; onLayout: (id: string) => void; onSection: (section: Section) => void;
}) {
  const layouts = snapshot?.compositions ?? [], operations = snapshot?.operations.length ?? 0;
  return <>
    <div className="project-heading"><strong>{projectName(project)}</strong><span>{location}</span></div>
    <button className="nav-row" aria-current={overview ? 'page' : undefined} onClick={onOverview}><Icon name="overview" size={16} stroke={1.8} /><span className="nav-row-name">Overview</span></button>
    <span className="section-label" id="nav-layouts">Layouts</span>
    <div role="group" aria-labelledby="nav-layouts" className="nav-group">
      {layouts.map(c => <button key={c.compositionId} className="nav-row" aria-current={!overview && compositionId === c.compositionId ? 'page' : undefined} onClick={() => onLayout(c.compositionId)}>
        <Icon name="layout" size={16} stroke={1.8} /><span className="nav-row-name">{c.compositionId}</span><span className="nav-row-count">{views(c)}</span>
      </button>)}
      {snapshot && !layouts.length && <p className="nav-empty">None saved yet</p>}
    </div>
    <span className="section-label" id="nav-content">Content</span>
    <div role="group" aria-labelledby="nav-content" className="nav-group">
      <button className="nav-row" onClick={() => onSection('documents')}><Icon name="document" size={16} stroke={1.8} /><span className="nav-row-name">Documents</span><span className="nav-row-count">{snapshot?.documents.length ?? ''}</span></button>
      <button className="nav-row" onClick={() => onSection('files')}><Icon name="folder" size={16} stroke={1.8} /><span className="nav-row-name">Files</span><span className="nav-row-count">{snapshot?.resources.length ?? ''}</span></button>
      {operations > 0 && <div className="nav-row nav-fact"><span className="nav-row-name">Retained operations</span><span className="nav-row-count">{operations}</span></div>}
    </div>
  </>;
}

export function ProjectOverview({ project, location, snapshot, onLayout, client, onProjectChanged, onOpened }: { project: ProjectSummary; location: string; snapshot: WorkspaceSnapshot; onLayout: (id: string) => void; client: BrowserClient; onProjectChanged: (p: ProjectSummary) => void; onOpened?: (compositionId: string) => void }) {
  const [adding, setAdding] = useState(false), [error, setError] = useState('');
  const [folder, setFolder] = useState<{ entries: Entry[]; total: number; truncated: boolean; path: string } | null>(null), [reading, setReading] = useState(false), [openProblem, setOpenProblem] = useState('');
  // "Nothing happened" is not an answer: this asks the service what is wrong and
  // shows the next action beside each finding.
  const [doctor, setDoctor] = useState<Array<{ id: string; state: 'ok' | 'warn' | 'fail'; detail: string; remedy: string }> | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
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
  return <section className="overview" aria-labelledby="overview-title">
    <header className="overview-header">
      <h1 id="overview-title">{projectName(project)}</h1>
      <p><span>{location}</span>{added.text && <> · <span title={added.full}>added {added.text.replace(/^[TY]/, c => c.toLowerCase())}</span></>}</p>
    </header>
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
    <section className="overview-section" aria-labelledby="overview-sources">
      <h2 id="overview-sources">Source folders</h2>
      <SourceFolders folders={project.sources ?? [{ id: project.id, root: project.root, name: projectName(project) }]} busy={adding} onAdd={() => void add()} />
      {error && <p className="field-hint project-problem" role="alert">{error}</p>}
    </section>
    {snapshot.compositions.length ? <section className="overview-section" aria-labelledby="overview-layouts">
      <h2 id="overview-layouts" tabIndex={-1}>Layouts <span>{snapshot.compositions.length}</span></h2>
      <table><thead><tr><th>Name</th><th className="column-state">Views</th></tr></thead>
        <tbody>{snapshot.compositions.map(c => <tr key={c.compositionId}>
          <td><button className="overview-link" onClick={() => onLayout(c.compositionId)}><Icon name="layout" size={16} stroke={1.8} />{c.compositionId}</button></td>
          <td className="column-state">{views(c)}</td>
        </tr>)}</tbody></table>
    </section> : <div className="layout-empty">
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeDasharray="3 2.4" /></svg>
      <div><strong>No saved layout yet</strong><p>A layout appears here once you or an Agent saves one for this project. What you have open and the folder's files are listed below.</p></div>
    </div>}
    <section className="overview-section" aria-labelledby="overview-documents">
      <h2 id="overview-documents" tabIndex={-1}>Documents <span>{docs.length}</span></h2>
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
  </section>;
}
