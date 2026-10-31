import { useEffect, useState } from 'react';
import { explorableTable, languageNames, scriptLanguage, type Language } from './explore.js';
import { ExploreIn } from './explore-in.js';
import type { BrowserClient, ViewDescription, WorkspaceSnapshot } from '../src/browser.js';
import type { SourceItem } from './sources.js';
import { openInWorkspace, viewFor } from './canvas.js';
import { OwnerView } from './shell/owner.js';
import { Icon } from './icons.js';
import { fileIcon, size } from './project.js';

// One project file shown where the person is browsing, in the view its kind has: a CSV or
// image as a Files snapshot of its current bytes, text as the project's one buffer of that
// document, a registered result as its exact version. Nothing is placed in a layout until
// the person asks for Studio.
type Shown = { key: string } & ({ view: ViewDescription } | { problem: string }) | null;
// Each showing reads the file as it is now: a snapshot is content-addressed, so unchanged
// bytes give the same view, and text is opened again so the buffer adopts what is on disk.
async function resolve(client: BrowserClient, snapshot: WorkspaceSnapshot, item: SourceItem): Promise<ViewDescription | null> {
  const made = await viewFor(client, snapshot, item.resource ?? item.path);
  return made && ({ id: made.node.id, component: String(made.node.component), version: String(made.node.version), props: made.node.props ?? {}, bindings: made.node.bindings } as unknown as ViewDescription);
}
// Keys that move between files, unless the person is typing or working inside a view.
function ownsKeys(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  return !!element?.closest('input, textarea, select, [contenteditable=""], [contenteditable=true], [data-owner-body], [role=tablist], [role=menu], dialog[open]');
}

export function FilePreview({ client, snapshot, item, items, kind, principalId, workspace, onExplore, onMove, onStudio, onList, onAbout }: {
  client: BrowserClient; snapshot: WorkspaceSnapshot; item: SourceItem; items: SourceItem[]; kind: string; principalId?: string;
  workspace: () => string; onExplore?: (path: string, language: Language) => void; onMove: (item: SourceItem) => void; onStudio: (compositionId: string, viewId: string) => void; onList: () => void; onAbout: (pluginId: string) => void;
}) {
  const [shown, setShown] = useState<Shown>(null), [header, setHeader] = useState<HTMLDivElement | null>(null);
  const [placing, setPlacing] = useState(false), [placeProblem, setPlaceProblem] = useState('');
  const index = items.findIndex(entry => entry.key === item.key);
  const previous = index > 0 ? items[index - 1] : undefined, next = index >= 0 ? items[index + 1] : undefined;
  // Waits for the snapshot that carries the file's own catalog; a new snapshot alone does not reopen it.
  const ready = snapshot.catalog.components.length > 0;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    setShown(current => current && 'view' in current ? current : null);
    const key = item.key;
    resolve(client, snapshot, item).then(view => { if (live) setShown(view ? { key, view } : { key, problem: 'Rho has no viewer for this kind of file yet. It stays in the project folder.' }); },
      error => { if (live) setShown({ key, problem: error instanceof Error ? error.message : 'This file could not be opened.' }); });
    return () => { live = false; };
  }, [client, snapshot.project.id, ready, item.key, item.bytes, item.resource?.version]);
  useEffect(() => { setPlaceProblem(''); }, [item.key]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || ownsKeys(event.target)) return;
      const to = event.key === 'ArrowLeft' ? previous : event.key === 'ArrowRight' ? next : undefined;
      if (!to) return;
      event.preventDefault(); onMove(to);
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [previous?.key, next?.key, onMove]);
  async function studio() {
    setPlacing(true); setPlaceProblem('');
    try {
      const placed = await openInWorkspace(client, snapshot, workspace(), item.resource ?? item.path);
      if (placed) onStudio(placed.compositionId, placed.viewId); else setPlaceProblem('Rho has no viewer for this kind of file yet.');
    } catch (error) { setPlaceProblem(error instanceof Error ? error.message : 'It could not be opened in Studio.'); }
    finally { setPlacing(false); }
  }
  // The view on screen belongs to this file only once it resolved for it; until then the
  // previous file stays, dimmed, so switching does not flash an empty page.
  const view = shown && 'view' in shown ? shown.view : null;
  const current = shown?.key === item.key;
  return <section className="file-preview" aria-labelledby="preview-title">
    <header className="preview-bar">
      <span className="file-symbol"><Icon name={fileIcon(item)} size={18} stroke={1.6} /></span>
      <div className="preview-name"><h1 id="preview-title" title={item.path}>{item.name}</h1><small>{item.folder}{item.bytes !== null ? ' · ' + size(item.bytes) : ''}</small></div>
      <div ref={setHeader} className="preview-owner-header" />
      <div className="preview-nav" role="group" aria-label={'Browse ' + kind}>
        <button className="icon-button" aria-label={previous ? 'Previous: ' + previous.name : 'Previous file'} title="Previous (←)" aria-keyshortcuts="ArrowLeft" disabled={!previous} onClick={() => previous && onMove(previous)}><Icon name="back" size={16} /></button>
        <button className="preview-position" title={'All ' + kind.toLowerCase()} onClick={onList}>{index >= 0 ? `${index + 1} of ${items.length}` : items.length + ' files'}</button>
        <button className="icon-button" aria-label={next ? 'Next: ' + next.name : 'Next file'} title="Next (→)" aria-keyshortcuts="ArrowRight" disabled={!next} onClick={() => next && onMove(next)}><Icon name="chevron" size={16} /></button>
      </div>
      {onExplore && (explorableTable(item.path) || scriptLanguage(item.path)) && <ExploreIn languages={explorableTable(item.path) ? ['r', 'python'] : [scriptLanguage(item.path)!]}
        title={l => explorableTable(item.path) ? `Open ${item.name} in Studio with the Notebook beside it, loaded into the ${languageNames[l]} session as a new value` : `Open ${item.name} in Studio with the Notebook beside it, and a line that runs it waiting there for you`} onExplore={l => onExplore(item.path, l)} />}
      <button className="preview-studio" aria-label={placing ? 'Opening in Studio' : 'Open in Studio'} title="Open in Studio" disabled={placing} onClick={() => void studio()}><Icon name="layout" size={15} /><span>{placing ? 'Opening…' : 'Open in Studio'}</span></button>
    </header>
    {placeProblem && <p className="canvas-note" role="alert">{placeProblem}</p>}
    <div className={'preview-body' + (view && !current ? ' switching' : '')} aria-busy={!current}>
      {view ? <OwnerView key={view.id} active params={{ view, snapshot, client, principalId, compositionId: 'preview', compositionVersion: 0, contextTarget: null, headerTarget: current ? header : null, renderAllowed: true, onAbout }} />
        : shown && 'problem' in shown && current ? <div className="studio-empty"><span className="empty-symbol"><Icon name="file" size={26} stroke={1.5} /></span><h2>{item.name}</h2><p>{shown.problem}</p></div>
        : <div className="loading-state" role="status"><span className="loading-dot" /><span>Opening {item.name}…</span></div>}
    </div>
  </section>;
}
