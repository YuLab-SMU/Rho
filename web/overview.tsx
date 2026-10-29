import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BrowserClient, CompositionSummary, ProjectSummary, WorkspaceSnapshot } from '../src/browser.js';
import { regions, type Region } from '../src/shell-layout.js';
import { executionWord, integrityWord, results, shortPath, type RunFacts } from '../src/execution-facts.js';
import { useRuns } from './executions.js';
import { projectName, place, SourceFolders, when } from './home.js';
import { Icon, type IconName } from './icons.js';
import { availability, fileIcon, resourceIcon, size, sourceLabels, type Entry, type Section, type SourceRow } from './project.js';
import { compositionName } from './canvas.js';
import { walkLimits, type ProjectFiles, type SourceItem } from './sources.js';
import { RunView } from './shell/facts.js';
import { AgentActivity } from './agent-activity.js';
import { AgentPage } from './agent-manage.js';
import { AgentAccess } from './agents.js';
import { SharedNotes, TouchedFiles, useProjectWork, WorkSessions } from './work-progress.js';
import { readPreview, type Preview } from './previews.js';
import './overview.css';

// The Graph's record, drawn small on the Overview; loaded with the Graph's own code.
const WorkStrip = lazy(() => import('./graph.js').then(module => ({ default: module.WorkStrip })));
// The newest result leads at twice the size; the rest fill whole rows beside and below it.
const figureCount = (total: number) => total >= 6 ? 6 : total >= 3 ? 3 : total;
const viewIcon = (component: string, title: string): IconName => /table/.test(component) ? 'table' : /media|image/.test(component) ? 'image'
  : /\.(R|r|py|sh|sql|js|ts)$/.test(title) ? 'code' : /document|editor|note/.test(component) ? 'document' : 'file';
// A figure or result as a picture of itself: an image's pixels, a table's first rows, or its kind.
function Thumb({ client, snapshot, item, modifiedAt }: { client: BrowserClient; snapshot: WorkspaceSnapshot; item: SourceItem; modifiedAt?: string }) {
  const previewable = /\.(png|jpe?g|svg|csv)$/i.test(item.path);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    if (!previewable) return;
    let live = true;
    readPreview(client, snapshot, { path: item.path, bytes: item.bytes, modifiedAt, resource: item.resource }).then(value => { if (live) setPreview(value); });
    return () => { live = false; };
  }, [item.path, item.bytes, modifiedAt, item.resource?.version]);
  if (previewable && !preview) return <span className="figure-thumb loading" aria-hidden="true" />;
  if (preview?.kind === 'image') return <span className="figure-thumb image"><img src={preview.url} alt="" /></span>;
  if (preview?.kind === 'table') return <span className="figure-thumb table" aria-hidden="true">
    <span style={{ gridTemplateColumns: `repeat(${preview.columns.length}, minmax(0, 1fr))` }}>
      {preview.columns.map(c => <b key={'h' + c}>{c}</b>)}
      {preview.rows.map((row, i) => preview.columns.map(c => <i key={i + c}>{row[c] === null || row[c] === undefined ? '' : String(row[c])}</i>))}
    </span>
  </span>;
  return <span className="figure-thumb kind" aria-hidden="true"><Icon name={fileIcon(item)} size={26} stroke={1.4} /></span>;
}

// A workspace drawn as its own arrangement: each split at its weights, each tab group as a
// pane naming its first view and how many more it holds.
function MiniLayout({ composition }: { composition: CompositionSummary }) {
  const root = regions(composition), views = new Map(composition.views.map(v => [v.id, v]));
  if (!root) return <span className="mini-layout empty">Empty workspace</span>;
  const draw = (region: Region): ReactNode => {
    if (region.kind === 'split') return <span className={'mini-split ' + region.axis}>{region.children.map((child, i) => <span key={child.id} style={{ flexGrow: region.weights[i] ?? 1 }}>{draw(child)}</span>)}</span>;
    const shown = region.views.flatMap(id => views.get(id) ?? []), first = shown[0];
    const title = first ? String(first.props.title ?? first.id) : '';
    return <span className="mini-pane">
      <span className="mini-tabs">{shown.slice(0, 5).map((v, i) => <i key={v.id} className={i === 0 ? 'on' : undefined} />)}</span>
      {first && <span className="mini-face"><Icon name={viewIcon(String(first.component), title)} size={13} /><span>{title}</span></span>}
      {shown.length > 1 && <small>+{shown.length - 1}</small>}
    </span>;
  };
  return <span className="mini-layout" aria-hidden="true">{draw(root)}</span>;
}

function shownPath(at: string, project: ProjectSummary) {
  if (!at) return projectName(project);
  const [head, ...rest] = at.split('/');
  const source = head.startsWith('@') ? project.sources?.find(entry => '@' + entry.id === head) : undefined;
  return [source ? source.name : head, ...rest].join('/');
}
interface Props {
  project: ProjectSummary; snapshot: WorkspaceSnapshot; client: BrowserClient; section: Section;
  // The workspace the person shares with the Agent, where an opened file goes.
  workspace: () => string;
  onSection: (section: Section) => void; onAgent: (conversationId?: string) => void;
  onLayout: (id: string, view?: string) => void; onProjectChanged: (project: ProjectSummary) => void; onOpened: (id: string, view?: string) => void;
  category?: SourceRow; files?: ProjectFiles; sources?: Record<SourceRow, SourceItem[]> | null; onFile?: (row: SourceRow, item: SourceItem) => void;
  // The Agent page: a tab opened from a narrower link has no conversations here, only its handoff.
  linked?: boolean; onPath?: (path: string) => void; onNewConversation?: () => void;
}
export function ProjectOverview({ project, snapshot, client, section, workspace, onSection, onAgent, onLayout, onProjectChanged, onOpened, category, files, sources, onFile, linked = false, onPath, onNewConversation }: Props) {
  // A linked tab's Agent sessions with access are read only while their section is open.
  const [outsideOpen, setOutsideOpen] = useState(false);
  const { runs, problem: runsProblem, readAgain } = useRuns(client, project.id, snapshot.cursor);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [folder, setFolder] = useState<{ entries: Entry[]; total: number; truncated: boolean; path: string } | null>(null);
  const [reading, setReading] = useState(false), [opening, setOpening] = useState(''), [fileError, setFileError] = useState(''), [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false), [sourceError, setSourceError] = useState(''), [doctorError, setDoctorError] = useState('');
  const [doctor, setDoctor] = useState<Array<{ id: string; state: string; detail: string; remedy: string }> | null>(null), [diagnosing, setDiagnosing] = useState(false);
  // Whether the project's own folder holds anything: one bounded listing, read only while the
  // project has nothing recorded, so an empty project can lead with the step that has content.
  const [rootEntries, setRootEntries] = useState<number | null>(null);
  const [hasWork, setHasWork] = useState(false);
  const workAllowed = snapshot.catalog.operations.some(o => o.method === 'project.work.read' && o.authorized);
  const work = useProjectWork(client, snapshot, section === 'overview' && workAllowed, setHasWork);
  const readSequence = useRef(0), runDialog = useRef<HTMLDialogElement>(null);
  const isFiles = section === 'files' || section === 'documents';
  const places = new Map<string, { compositionId: string; viewId: string }>();
  const documents = new Map<string, { compositionId: string; viewId: string }>();
  for (const composition of snapshot.compositions) for (const view of composition.views) for (const binding of Object.values(view.bindings ?? {})) {
    if ('id' in binding && 'version' in binding) places.set(binding.id + '@' + binding.version, { compositionId: composition.compositionId, viewId: view.id });
    if ('documentId' in binding && 'kind' in binding && binding.kind === 'live-document') documents.set(String(binding.documentId), { compositionId: composition.compositionId, viewId: view.id });
  }
  // A file snapshot taken to show a file is a view of that file, not a result of the work.
  const artifacts = results(snapshot.resources.filter(r => (r.provenance as { source?: string } | undefined)?.source !== 'current-filesystem-observation'), runs ?? []);
  const orderedRuns = [...(runs ?? [])].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  // Results and figures, newest first, as the sidebar lists them.
  const modified = new Map((files?.files ?? []).map(f => [f.path, f.modifiedAt] as const));
  const figures = [...(sources?.results ?? [])].sort((a, b) => (modified.get(b.path) ?? '').localeCompare(modified.get(a.path) ?? ''));
  const where = place(project);
  // Nothing recorded yet: no workspaces, results, question or Agent notes. Runs are read
  // separately, so an unread run list is not reported as an empty one, and nothing is painted
  // over an otherwise empty project until that read settles.
  const clean = !snapshot.compositions.length && !artifacts.length && !snapshot.taskMap?.question && !snapshot.taskMap?.items.length && !snapshot.conversations?.length && !hasWork;
  const settled = !clean || ((runs !== null || !!runsProblem) && rootEntries !== null);
  const emptyProject = section === 'overview' && clean && runs !== null && runs.length === 0 && rootEntries !== null;
  // The side column earns its place only when it has something to report.
  const recent = !!runsProblem || (runs?.length ?? 0) > 0;
  const touched = !!work.work && (work.work.files.length > 0 || work.work.omitted.fileReferences > 0);
  const side = recent || touched || workAllowed || snapshot.compositions.length > 0;
  const shownFigures = figureCount(figures.length);
  // An empty project leads with the step that has something behind it, and never with a claim
  // that could not be read: a failed listing keeps the Agent first.
  const browseLeads = (rootEntries ?? 0) > 0;
  const nextSteps = ([
    { key: 'files', label: 'Browse files', icon: 'folder', run: () => onSection('files'), primary: browseLeads },
    { key: 'agent', label: 'Work with Agent', icon: 'prompt', run: () => onAgent(), primary: !browseLeads },
  ] satisfies Array<{ key: string; label: string; icon: IconName; run: () => void; primary: boolean }>)
    .sort((left, right) => Number(right.primary) - Number(left.primary));
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
  // A failed read is not an empty folder; -1 keeps the Agent as the first step either way.
  useEffect(() => {
    if (section !== 'overview' || !clean) return;
    let live = true;
    client.call('project.entries', { projectId: project.id })
      .then(list => { if (live) setRootEntries(list.entries.length); }, () => { if (live) setRootEntries(-1); });
    return () => { live = false; };
  }, [client, project.id, section, clean]);
  useEffect(() => () => { readSequence.current++; }, []);
  useEffect(() => { if (inspecting && !runDialog.current?.open) runDialog.current?.showModal(); }, [inspecting]);
  async function open(entry: Pick<Entry, 'path'>) {
    if (opening) return;
    setOpening(entry.path); setFileError('');
    try {
      const target = workspace(), current = snapshot.compositions.find(c => c.compositionId === target);
      const result = await client.call('project.openFile', { projectId: project.id, path: entry.path, compositionId: target, expectedVersion: current?.version ?? 0, changeId: 'open-' + crypto.randomUUID() });
      onOpened(result.composition.compositionId, result.viewId);
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
    const spot = places.get(resource.id + '@' + resource.version);
    const content = <><span className="file-symbol"><Icon name={resourceIcon(resource.kind)} size={19} stroke={1.6} /></span><span className="result-name"><strong>{shortPath(resource.path)}</strong><small>{resource.kind}{earlier ? ` · ${earlier} earlier version${earlier === 1 ? '' : 's'}` : ''}{run ? ' · ' + run.operationId : ''}</small></span><span className="result-state">{run ? integrityWord(run.integrity) : availability(resource)}</span>{spot && <Icon name="chevron" size={14} />}</>;
    return <li key={resource.id + resource.version}>{spot ? <button className="result-row" onClick={() => onLayout(spot.compositionId, spot.viewId)}>{content}</button> : <div className="result-row">{content}<small>No open view</small></div>}</li>;
  })}</ul>;
  const visible = folder?.entries.filter(e => !query || e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const sourceTitle = sourceLabels[category ?? 'data'];
  const title = isFiles ? 'Files' : section === 'agent' ? 'Agent' : section === 'settings' ? 'Project settings' : section === 'sources' ? sourceTitle : projectName(project);
  return <section className={'project-page overview' + (isFiles ? ' files-page' : '')} aria-labelledby="overview-title">
    <header className="page-heading">
      <div><h1 id="overview-title">{title}</h1>{section === 'overview' && <p title={where.full}>{where.text}</p>}</div>
      {isFiles && <button onClick={() => void listFolder(folder?.path)} disabled={reading}><Icon name="refresh" size={15} />Refresh</button>}
      {section === 'sources' && files && <button onClick={files.refresh} disabled={files.reading}><Icon name="refresh" size={15} />Refresh</button>}
    </header>
    {section === 'sources' && files && onFile && <SourceList category={category ?? 'data'} files={files} items={sources?.[category ?? 'data'] ?? null} artifacts={artifacts} onFile={onFile} />}
    {section === 'overview' && workAllowed && <WorkSessions state={work} openConversation={onAgent} openActivity={() => onSection('agent')} />}
    {section === 'overview' && fileError && <p role="alert">{fileError}</p>}
    {emptyProject && <div className="empty-project">
      <span className="empty-symbol"><Icon name="grid" size={26} stroke={1.5} /></span>
      <h2>No work yet</h2>
      <div className="empty-actions">{nextSteps.map(step => <button key={step.key} className={step.primary ? 'primary' : undefined} onClick={step.run}><Icon name={step.icon} size={17} stroke={1.6} /><span>{step.label}</span></button>)}</div>
    </div>}
    {section === 'overview' && !emptyProject && settled && <>
      {snapshot.taskMap?.question && <div className="project-question"><Icon name="prompt" size={18} /><h2>{snapshot.taskMap.question}</h2></div>}
      {files && !!snapshot.conversations?.length && <Suspense fallback={null}><WorkStrip client={client} snapshot={snapshot} files={files} onOpen={() => onSection('graph')} onConversations={() => onSection('agent')} /></Suspense>}
      <div className={'project-columns' + (side ? '' : ' single')}>
        <div className="project-primary">
          <section className="project-section figures-section"><div className="section-heading"><h2>Results &amp; figures{figures.length > 0 && <span className="section-count">{figures.length}</span>}</h2><button className="text-button" onClick={() => onSection('files')}>All files <Icon name="chevron" size={12} /></button></div>
            {figures.length ? <ul className={'figure-grid count-' + shownFigures + (shownFigures >= 3 ? ' featured' : '')}>{figures.slice(0, shownFigures).map(item => <li key={item.key}>
              <button className="figure-card" onClick={() => onFile?.('results', item)} title={item.path}>
                <Thumb client={client} snapshot={snapshot} item={item} modifiedAt={modified.get(item.path)} />
                <span className="figure-name"><strong>{item.name}</strong><small>{item.resource && item.path.startsWith('.rho/') ? 'Run output' : item.folder}{modified.get(item.path) ? ' · ' + when(modified.get(item.path)!).text : ''}</small></span>
              </button></li>)}</ul>
              : artifacts.length ? resultList : <p className="quiet-empty">No results or figures yet.</p>}
            {figures.length > shownFigures && <button className="text-button figures-more" onClick={() => onSection('files')}>{figures.length - shownFigures} more in Files <Icon name="chevron" size={12} /></button>}
          </section>
          {snapshot.taskMap?.items.length ? <section className="project-section"><div className="section-heading"><h2>From your Agent</h2></div><ul className="agent-notes">{snapshot.taskMap.items.map(item => <li key={item.id} data-fact="agent"><strong>{item.title}</strong>{item.summary && <p>{item.summary}</p>}<small>{snapshot.taskMap!.vocabulary.states[item.state]?.label ?? item.state}</small></li>)}</ul></section> : null}
        </div>
        {side && <aside className="project-side">
          {(snapshot.compositions.length > 0 || workAllowed) && <section className="project-section"><div className="section-heading"><h2>Continue working</h2></div>
            <div className="workspace-grid">{snapshot.compositions.map(c => <button key={c.compositionId} className="workspace-card" onClick={() => onLayout(c.compositionId)}>
              <span className="workspace-card-head"><strong>{compositionName(c.compositionId)}</strong><small>{c.views.length} {c.views.length === 1 ? 'view' : 'views'}</small><Icon name="chevron" size={14} /></span>
              <MiniLayout composition={c} />
            </button>)}
            {workAllowed && <SharedNotes work={work.work} openFile={p => void open({ path: p })} />}</div>
          </section>}
          <TouchedFiles work={work.work} openFile={p => void open({ path: p })} openActivity={() => onSection('agent')} />
          {recent && <section className="project-section project-recent"><div className="section-heading"><h2>Recent activity</h2><button className="text-button" onClick={() => onSection('agent')}>View all</button></div>
            {error(runsProblem, readAgain)}{orderedRuns.length ? <div className="activity-list">{orderedRuns.slice(0, 5).map(runRow)}</div> : <p className="quiet-empty">No runs yet.</p>}
          </section>}
        </aside>}
      </div>
    </>}
    {isFiles && <>
      {snapshot.documents.length > 0 && <section className="project-section"><div className="section-heading"><h2>Open documents</h2></div><div className="document-list">{snapshot.documents.map(d => { const spot = documents.get(d.id); return <button key={d.id} className="document-link" disabled={!!opening} onClick={() => spot ? onLayout(spot.compositionId, spot.viewId) : void open(d)}><Icon name="document" size={18} /><span>{shortPath(d.path)}</span>{d.dirty && <span className="unsaved-dot" title="Unsaved changes" aria-label="Unsaved changes" />}</button>; })}</div></section>}
      <section className="project-section" aria-label="Project files">
        <div className="file-toolbar"><div className="folder-location">{folder?.path && <button className="icon-button" aria-label="Up one folder" onClick={() => void listFolder(folder.path.split('/').slice(0, -1).join('/'))}><Icon name="chevron" size={16} /></button>}<strong>{shownPath(folder?.path ?? '', project)}</strong></div><div className="search-field"><Icon name="search" size={17} stroke={1.7} /><input aria-label="Filter files" placeholder="Filter files…" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
        {error(fileError, () => void listFolder(folder?.path))}
        {reading && <p className="loading-inline" role="status">Reading folder…</p>}
        {folder && (visible.length ? <div className="file-table-wrap" aria-busy={reading}><table className="file-table"><thead><tr><th>Name</th><th>Type</th><th>Size</th></tr></thead><tbody>{visible.map(entry => <tr key={entry.path}><td><button className="file-open" disabled={!!opening || reading} onClick={() => void (entry.kind === 'folder' ? listFolder(entry.path) : open(entry))}><Icon name={entry.kind === 'folder' ? 'folder' : 'file'} size={19} stroke={1.6} />{entry.name}{opening === entry.path && <span role="status">Opening…</span>}</button></td><td>{entry.kind === 'folder' ? 'Folder' : entry.name.split('.').at(-1)?.toUpperCase() || 'File'}</td><td>{entry.kind === 'folder' ? '—' : size(entry.bytes)}</td></tr>)}</tbody></table>
          {folder.truncated && <p className="muted">Showing {folder.entries.length} of {folder.total} entries.</p>}
        </div> : <div className="empty-state compact"><p>{query ? 'No files match your search.' : 'This folder is empty.'}</p>{query && <button onClick={() => setQuery('')}>Clear search</button>}</div>)}
      </section>
      {snapshot.resources.length > 0 && <section className="project-section"><div className="section-heading"><h2>Registered results</h2></div>{resultList}</section>}
    </>}
    {section === 'agent' && (() => {
      const extra = <>
      {(orderedRuns.length > 0 || runsProblem) && <section className="project-section agent-runs"><div className="section-heading"><h2>Runs</h2></div>{error(runsProblem, readAgain)}<div className="activity-list">{orderedRuns.map(runRow)}</div></section>}
      {/* A tab from a narrower link sees the sessions with access; this machine's tab has them under Outside Rho. */}
      {linked && <details className="agent-outside" open={outsideOpen} onToggle={event => setOutsideOpen(event.currentTarget.open)}>
        <summary>Agent sessions with access</summary>
        {outsideOpen && <><AgentAccess snapshot={snapshot} /><AgentActivity client={client} projectId={project.id} root={project.root} onOpened={onOpened} /></>}
      </details>}
      </>;
      return linked ? extra : <AgentPage client={client} snapshot={snapshot} exists={path => !!files?.files.some(file => file.path === path)} onContinue={id => onAgent(id)} onPath={path => onPath?.(path)} onNew={() => onNewConversation?.()} onOpened={onOpened} extra={extra} />;
    })()}
    {section === 'settings' && <div className="settings-sections"><section className="project-section"><h2>Source folders</h2><SourceFolders folders={project.sources ?? [{ id: project.id, root: project.root, name: projectName(project) }]} busy={adding} onAdd={() => void add()} />{error(sourceError, () => void add())}</section>
      <section className="project-section"><div className="section-heading"><h2>Project health</h2><button disabled={diagnosing} onClick={() => void diagnose()}>{diagnosing ? 'Checking…' : 'Check project'}</button></div>{doctor ? <ul className="health-list">{doctor.map(c => <li key={c.id}><span className={'state ' + c.state}>{c.state === 'ok' ? 'Ready' : c.state === 'fail' ? 'Blocked' : 'Check'}</span><div><p>{c.detail}</p>{c.remedy && <small>{c.remedy}</small>}</div></li>)}</ul> : <p className="muted">Check the tools and capabilities available to this project.</p>}{error(doctorError, () => void diagnose())}</section></div>}
    {inspecting && <dialog ref={runDialog} className="run-dialog" aria-label={inspecting} onClose={() => setInspecting(null)} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}><button className="icon-button run-dialog-close" aria-label="Close" onClick={() => runDialog.current?.close()}><Icon name="close" size={18} /></button><RunView key={inspecting} snapshot={snapshot} client={client} operationId={inspecting} runs={runs} readRuns={readAgain} onOpenRun={setInspecting} opener={ref => { const spot = places.get(ref.id + '@' + ref.version); return spot ? () => onLayout(spot.compositionId, spot.viewId) : null; }} /></dialog>}
  </section>;
}

const sourceEmpty: Record<SourceRow, string> = { data: 'No data files in this project yet.', code: 'No scripts in this project yet.', results: 'No results or figures yet.', notes: 'No notes in this project yet.' };
// One kind of project file, wherever it sits, in the order the sidebar lists them. Choosing
// one shows it in place; a registered result is shown as its exact version.
function SourceList({ category, files, items, artifacts, onFile }: {
  category: SourceRow; files: ProjectFiles; items: SourceItem[] | null; artifacts: ReturnType<typeof results>; onFile: (row: SourceRow, item: SourceItem) => void;
}) {
  const [query, setQuery] = useState('');
  const made = new Map(artifacts.map(row => [row.resource.id + '@' + row.resource.version, row]));
  const all = items ?? [], total = all.length;
  const shown = all.filter(item => !query || item.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="project-section source-list" aria-label={category}>
    <div className="file-toolbar"><p className="source-summary">{files.readAt === 0 && files.reading ? 'Reading the project folders…' : `${total}${files.truncated ? '+' : ''} ${total === 1 ? 'file' : 'files'}`}{files.truncated && <span title={`Rho reads at most ${walkLimits.maxFolders} folders, ${walkLimits.maxDepth} levels deep.`}> · deeper folders were not read</span>}</p>
      <div className="search-field"><Icon name="search" size={17} stroke={1.7} /><input aria-label="Filter these files" placeholder="Filter…" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
    {files.problem && <div className="inline-error" role="alert"><p>{files.problem}</p><button onClick={files.refresh}>Try again</button></div>}
    {total === 0 && files.readAt > 0 ? <div className="empty-state compact"><p>{sourceEmpty[category]}</p></div>
      : shown.length > 0 ? <ul className="source-rows">
        {shown.map(item => {
          const result = item.resource ? made.get(item.resource.id + '@' + item.resource.version) : undefined;
          return <li key={item.key}><button className="source-row" onClick={() => onFile(category, item)}>
            <span className="file-symbol"><Icon name={fileIcon(item)} size={18} stroke={1.6} /></span>
            <span className="source-name"><strong>{item.name}</strong><small>{item.folder}{result?.run ? ' · from ' + result.run.operationId : ''}</small></span>
            <span className="source-meta">{item.resource ? (result?.run ? integrityWord(result.run.integrity) : 'Result') : item.bytes !== null ? size(item.bytes) : ''}</span>
          </button></li>;
        })}
      </ul> : total > 0 ? <div className="empty-state compact"><p>No files match your filter.</p><button onClick={() => setQuery('')}>Clear filter</button></div> : null}
  </section>;
}
