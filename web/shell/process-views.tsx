import type { ReactNode } from 'react';
import type { BrowserClient, ViewDescription, WorkspaceSnapshot } from '../../src/browser.js';
import { studioViewId, type Process } from '../process-context.js';
import { Snapshot } from '../snapshot.js';
import { Icon } from '../icons.js';
import { HoldsText } from '../holds.js';
import { clock } from '../timeline-kinds.js';

// A file's view in a conversation's Studio says which of its versions it shows and when that
// version was kept. Stepping to another version moves the whole replay to when it was kept, so
// the conversation, the other views and the commands show that moment too. During a replay a
// text file shows the bytes kept then, read only; its editor comes back at now.
export function ProcessFrame({ view, process, client, snapshot, children }: { view: ViewDescription; process: Process; client: BrowserClient; snapshot: WorkspaceSnapshot; children: ReactNode }) {
  const whole = process.every.find(f => studioViewId(f.path) === view.id);
  if (!whole) return <>{children}</>;
  const path = whole.path, now = process.files.find(f => f.path === path);
  const all = whole.versions, shown = now?.versions.length ?? 0, version = now?.versions.at(-1);
  const live = Object.values(view.bindings ?? {}).some(b => (b as { kind?: string }).kind === 'live-document');
  const step = (index: number) => process.setAt(index >= all.length ? null : all[index].at);
  const holds = process.holds(path);
  // One line above the file: what it holds, then which kept version shows when the work kept more
  // than one. A file with one kept version says nothing about it; when it was kept is in the title.
  const kept = version ? `Version ${shown} of ${all.length}, kept ${clock(version.at)}` : '';
  const note = !all.length ? (process.at === null ? 'Shown as it is now; no version was kept' : 'No version was kept') : !version ? 'Not kept yet' : all.length > 1 ? `Version ${shown} of ${all.length}` : '';
  return <div className="process-frame">
    {(holds || note) && <div className="process-line" data-fact="observed" title={kept || undefined}>
      {/* What the file holds, marked by where that comes from: the notes, a model or the facts read. */}
      {holds ? <HoldsText className="process-holds" holds={holds} /> : <span className="process-holds" />}
      {note && <span className="process-version">{note}</span>}
      {all.length > 1 && <span className="process-version-steps">
        <button className="icon-button" aria-label={'Earlier version of ' + whole.title} disabled={shown <= 1} onClick={() => step(shown - 2)}><span className="flip"><Icon name="chevron" size={13} /></span></button>
        <button className="icon-button" aria-label={'Later version of ' + whole.title} disabled={process.at === null && shown >= all.length} onClick={() => step(shown)}><Icon name="chevron" size={13} /></button>
      </span>}
    </div>}
    {process.at !== null && live
      ? version ? <div className="process-replay-file"><Snapshot client={client} projectId={snapshot.project.id} resource={version.resource} path={path} /></div>
        : all.length ? <p className="process-note">The work had reached this file by {clock(process.at, true)}; its first version was kept at {clock(all[0].at, true)}.
          <button className="text-button" onClick={() => step(0)}>Go to {clock(all[0].at, true)}</button></p>
        // A file the work touched without keeping a version: nothing shows it as it was then.
        : <p className="process-note">The work had reached this file by {clock(process.at, true)}, but no version of it was kept, so it cannot be shown as it was then.
          <button className="text-button" onClick={() => process.setAt(null)}>Show it now</button></p>
      : children}
  </div>;
}
