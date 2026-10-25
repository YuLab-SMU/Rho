import { useEffect, useRef, useState } from 'react';
import type { BrowserClient, ProjectSummary, WorkspaceSnapshot } from '../src/browser.js';
import { executionWord, integrityWord, results, shortPath, type RunFacts } from '../src/execution-facts.js';
import { useRuns } from './executions.js';
import { projectName, SourceFolders, when } from './home.js';
import { Icon } from './icons.js';
import { availability, resourceIcon, size, type Entry, type Section } from './project.js';
import { RunView } from './shell/facts.js';

interface Props {
  project: ProjectSummary; location: string; snapshot: WorkspaceSnapshot; client: BrowserClient; section: Section;
  onSection: (section: Section) => void; onAgent: () => void;
  onLayout: (id: string, view?: string) => void; onProjectChanged: (project: ProjectSummary) => void; onOpened: (id: string) => void;
}
export function ProjectOverview({ project, location, snapshot, client, section, onSection, onAgent, onLayout, onProjectChanged, onOpened }: Props) {
  const { runs, problem: runsProblem, readAgain } = useRuns(client, project.id, snapshot.cursor);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [folder, setFolder] = useState<{ entries: Entry[]; total: number; truncated: boolean; path: string } | null>(null);
  const [reading, setReading] = useState(false), [opening, setOpening] = useState(''), [fileError, setFileError] = useState(''), [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false), [sourceError, setSourceError] = useState(''), [doctorError, setDoctorError] = useState('');
  const [doctor, setDoctor] = useState<Array<{ id: string; state: string; detail: string; remedy: string }> | null>(null), [diagnosing, setDiagnosing] = useState(false);
  const readSequence = useRef(0), runDialog = useRef<HTMLDialogElement>(null);
  const isFiles = section === 'files' || section === 'documents';
  const places = new Map<string, { compositionId: string; viewId: string }>();
  const documents = new Map<string, { compositionId: string; viewId: string }>();
  for (const composition of snapshot.compositions) for (const view of composition.views) for (const binding of Object.values(view.bindings ?? {})) {
    if ('id' in binding && 'version' in binding) places.set(binding.id + '@' + binding.version, { compositionId: composition.compositionId, viewId: view.id });
    if ('documentId' in binding && 'kind' in binding && binding.kind === 'live-document') documents.set(String(binding.documentId), { compositionId: composition.compositionId, viewId: view.id });
  }
  const artifacts = results(snapshot.resources, runs ?? []);
  const orderedRuns = [...(runs ?? [])].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  async function listFolder(at = '') {
    const sequence = ++readSequence.current;
    setReading(true); setFileError('');
    try {
      const result = await client.call('project.entries', { projectId: project.id, ...(at ? { path: at } : {}) });
      if (sequence === readSequence.current) { setFolder(result); setQuery(''); }
    } catch (e) { if (sequence === readSequence.current) setFileError(e instanceof Error ? e.message : 'Could not read this folder. Try again.'); }
    finally { if (sequence === readSequence.current) setReading(false); }
  }
  useEffect(() => { if (isFiles && !folder && !reading) void listFolder(); }, [isFiles]);
  useEffect(() => () => { readSequence.current++; }, []);
  useEffect(() => { if (inspecting && !runDialog.current?.open) runDialog.current?.showModal(); }, [inspecting]);
  async function open(entry: Pick<Entry, 'path'>) {
    if (opening) return;
    setOpening(entry.path); setFileError('');
    try {
      const current = snapshot.compositions.find(c => c.compositionId === 'workspace');
      const result = await client.call('project.openFile', { projectId: project.id, path: entry.path, compositionId: 'workspace', expectedVersion: current?.version ?? 0, changeId: 'open-' + crypto.randomUUID() });
      onOpened(result.composition.compositionId);
    } catch (e) { setFileError(e instanceof Error ? e.message : 'Could not open this file. Try again.'); }
    finally { setOpening(''); }
  }
  async function add() {
    setAdding(true); setSourceError('');
    try { const result = await client.call('project.source.add', { projectId: project.id }, new AbortController().signal); if (result.project) onProjectChanged(result.project); }
    catch (e) { setSourceError(e instanceof Error ? e.message : 'Could not add the folder. Try again.'); }
    finally { setAdding(false); }
  }
  async function diagnose() {
    setDiagnosing(true); setDoctorError('');
    try { setDoctor((await client.call('project.doctor', { projectId: project.id }, new AbortController().signal)).checks); }
    catch (e) { setDoctorError(e instanceof Error ? e.message : 'Could not check this project. Try again.'); }
    finally { setDiagnosing(false); }
  }
  const runRow = (run: RunFacts) => <button className="activity-row" key={run.operationId} onClick={() => setInspecting(run.operationId)}>
    <span className={'activity-symbol ' + run.execution}><Icon name="run" size={16} /></span>
    <span className="activity-name"><strong>{run.operationId}</strong><small>{run.author} · {when(run.acceptedAt).text}</small></span>
    <span className={'state ' + run.execution}>{executionWord(run.execution)}</span><Icon name="chevron" size={13} />
  </button>;
  const error = (text: string, retry: () => void) => text && <div className="inline-error" role="alert"><p>{text}</p><button onClick={retry}>Try again</button></div>;
  const resultList = <ul className="result-list">{artifacts.map(({ resource, run, earlier }) => {
    const place = places.get(resource.id + '@' + resource.version);
    const content = <><span className="file-symbol"><Icon name={resourceIcon(resource.kind)} size={20} /></span><span className="result-name"><strong>{shortPath(resource.path)}</strong><small>{resource.kind}{earlier ? ` · ${earlier} earlier version${earlier === 1 ? '' : 's'}` : ''}{run ? ' · ' + run.operationId : ''}</small></span><span className="result-state">{run ? integrityWord(run.integrity) : availability(resource)}</span>{place && <Icon name="chevron" size={14} />}</>;
    return <li key={resource.id + resource.version}>{place ? <button className="result-row" onClick={() => onLayout(place.compositionId, place.viewId)}>{content}</button> : <div className="result-row">{content}<small>No open view</small></div>}</li>;
  })}</ul>;
  const title = isFiles ? 'Files' : section === 'activity' ? 'Activity' : section === 'settings' ? 'Project settings' : projectName(project);
  return <section className={'project-page overview ' + (isFiles ? 'files-page' : '')} aria-labelledby="overview-title">
    <header className="page-heading"><div><h1 id="overview-title">{title}</h1><p>{section === 'overview' ? location : projectName(project)}</p></div>
      {section === 'overview' && <button className="primary" onClick={onAgent}><Icon name="prompt" size={17} />Work with Agent</button>}
      {isFiles && <button onClick={() => void listFolder(folder?.path)} disabled={reading}><Icon name="refresh" size={15} />Refresh</button>}
    </header>
    {section === 'overview' && <>
      {snapshot.taskMap?.question && <div className="project-question"><Icon name="prompt" size={20} /><h2>{snapshot.taskMap.question}</h2></div>}
      <div className="project-columns">
        <div className="project-primary">
          {snapshot.compositions.length > 0 && <section className="project-section"><div className="section-heading"><h2>Continue working</h2></div><div className="workspace-list">{snapshot.compositions.map(c => <button key={c.compositionId} className="workspace-link" onClick={() => onLayout(c.compositionId)}><Icon name="layout" size={21} /><span><strong>{c.compositionId}</strong><small>{c.views.map(v => String((v.props as Record<string, unknown>).title ?? v.id)).join(' · ') || 'Empty workspace'}</small></span><Icon name="chevron" size={15} /></button>)}</div></section>}
          <section className="project-section"><div className="section-heading"><h2>Results</h2><button className="text-button" onClick={() => onSection('files')}>All files <Icon name="chevron" size={12} /></button></div>
            {artifacts.length ? resultList : <div className="empty-state"><Icon name="folder" size={28} /><h3>Your work starts here</h3><p>Open a file or give your Agent a task. Results will appear here as they are recorded.</p><button onClick={() => onSection('files')}>Browse files</button></div>}
          </section>
          {snapshot.taskMap?.items.length ? <section className="project-section"><div className="section-heading"><h2>From your Agent</h2></div><ul className="agent-notes">{snapshot.taskMap.items.map(item => <li key={item.id} data-fact="agent"><strong>{item.title}</strong>{item.summary && <p>{item.summary}</p>}<small>{snapshot.taskMap!.vocabulary.states[item.state]?.label ?? item.state}</small></li>)}</ul></section> : null}
        </div>
        <aside className="project-recent"><div className="section-heading"><h2>Recent activity</h2><button className="text-button" onClick={() => onSection('activity')}>View all</button></div>
          {error(runsProblem, readAgain)}{runs === null && !runsProblem ? <p className="muted" role="status">Reading activity…</p> : orderedRuns.length ? <div className="activity-list">{orderedRuns.slice(0, 5).map(runRow)}</div> : <p className="quiet-empty">No runs yet.</p>}
          <div className="project-shortcuts"><button className="text-button" onClick={() => onSection('files')}><Icon name="folder" size={16} />Browse project files</button><button className="text-button" onClick={() => onSection('settings')}><Icon name="context" size={16} />Project settings</button></div>
        </aside>
      </div>
    </>}
    {isFiles && <>
      {snapshot.documents.length > 0 && <section className="project-section"><div className="section-heading"><h2>Open documents</h2></div><div className="document-list">{snapshot.documents.map(d => { const place = documents.get(d.id); return <button key={d.id} className="document-link" disabled={!!opening} onClick={() => place ? onLayout(place.compositionId, place.viewId) : void open(d)}><Icon name="document" size={18} /><span>{shortPath(d.path)}</span>{d.dirty && <span className="unsaved-dot" title="Unsaved changes" aria-label="Unsaved changes" />}</button>; })}</div></section>}
      <section className="project-section" aria-label="Project files">
        <div className="file-toolbar"><div className="folder-location">{folder?.path && <button className="icon-button" aria-label="Up one folder" onClick={() => void listFolder(folder.path.split('/').slice(0, -1).join('/'))}><Icon name="chevron" size={16} /></button>}<strong>{folder?.path || projectName(project)}</strong></div><label className="search-field"><Icon name="search" size={17} /><input aria-label="Filter files" placeholder="Filter files…" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
        {error(fileError, () => void listFolder(folder?.path))}
        {reading && <p className="loading-inline" role="status">Reading folder…</p>}
        {folder && <div className="file-table-wrap" aria-busy={reading}><table className="file-table"><thead><tr><th>Name</th><th>Type</th><th>Size</th></tr></thead><tbody>{folder.entries.filter(e => !query || e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(entry => <tr key={entry.path}><td><button className="file-open" disabled={!!opening || reading} onClick={() => void (entry.kind === 'folder' ? listFolder(entry.path) : open(entry))}><Icon name={entry.kind === 'folder' ? 'folder' : 'file'} size={19} />{entry.name}{opening === entry.path && <span role="status">Opening…</span>}</button></td><td>{entry.kind === 'folder' ? 'Folder' : entry.name.split('.').at(-1)?.toUpperCase() || 'File'}</td><td>{entry.kind === 'folder' ? '—' : size(entry.bytes)}</td></tr>)}</tbody></table>
          {!folder.entries.some(e => !query || e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <div className="empty-state compact"><p>{query ? 'No files match your search.' : 'This folder is empty.'}</p>{query && <button onClick={() => setQuery('')}>Clear search</button>}</div>}
          {folder.truncated && <p className="muted">Showing {folder.entries.length} of {folder.total} entries.</p>}
        </div>}
      </section>
      {snapshot.resources.length > 0 && <section className="project-section"><div className="section-heading"><h2>Registered results</h2></div>{resultList}</section>}
    </>}
    {section === 'activity' && <section className="project-section">{error(runsProblem, readAgain)}{runs === null ? <p role="status">Reading activity…</p> : orderedRuns.length ? <div className="activity-list">{orderedRuns.map(runRow)}</div> : <div className="empty-state"><Icon name="run" size={28} /><h3>No runs yet</h3><p>Execution records will appear here when work starts.</p><button onClick={onAgent}>Work with Agent</button></div>}</section>}
    {section === 'settings' && <div className="settings-sections"><section className="project-section"><h2>Source folders</h2><SourceFolders folders={project.sources ?? [{ id: project.id, root: project.root, name: projectName(project) }]} busy={adding} onAdd={() => void add()} />{error(sourceError, () => void add())}</section>
      <section className="project-section"><div className="section-heading"><h2>Project health</h2><button disabled={diagnosing} onClick={() => void diagnose()}>{diagnosing ? 'Checking…' : 'Check project'}</button></div>{doctor ? <ul className="health-list">{doctor.map(c => <li key={c.id}><span className={'state ' + c.state}>{c.state === 'ok' ? 'Ready' : c.state === 'fail' ? 'Blocked' : 'Check'}</span><div><p>{c.detail}</p>{c.remedy && <small>{c.remedy}</small>}</div></li>)}</ul> : <p className="muted">Check the tools and capabilities available to this project.</p>}{error(doctorError, () => void diagnose())}</section></div>}
    {inspecting && <dialog ref={runDialog} className="run-dialog" aria-label={inspecting} onClose={() => setInspecting(null)} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}><button className="icon-button run-dialog-close" aria-label="Close" onClick={() => runDialog.current?.close()}><Icon name="close" size={18} /></button><RunView key={inspecting} snapshot={snapshot} client={client} operationId={inspecting} runs={runs} readRuns={readAgain} onOpenRun={setInspecting} opener={ref => { const place = places.get(ref.id + '@' + ref.version); return place ? () => onLayout(place.compositionId, place.viewId) : null; }} /></dialog>}
  </section>;
}
