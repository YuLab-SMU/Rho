import type { ReactNode } from 'react';
import type { BrowserClient, ViewDescription, WorkspaceSnapshot } from '../../src/browser.js';
import { studioViewId, type Process } from '../process-context.js';
import { Snapshot } from '../snapshot.js';
import { Icon } from '../icons.js';
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
  return <div className="process-frame">
    <div className="process-version" data-fact="observed">
      {all.length ? <>
        <span>{version ? `Version ${shown} of ${all.length} · kept ${clock(version.at)}` : 'Not kept yet'}</span>
        {all.length > 1 && <span className="process-version-steps">
          <button className="icon-button" aria-label={'Earlier version of ' + whole.title} disabled={shown <= 1} onClick={() => step(shown - 2)}><span className="flip"><Icon name="chevron" size={13} /></span></button>
          <button className="icon-button" aria-label={'Later version of ' + whole.title} disabled={process.at === null && shown >= all.length} onClick={() => step(shown)}><Icon name="chevron" size={13} /></button>
        </span>}
      </> : <span>No version of this file was kept; it shows as it is now.</span>}
    </div>
    {process.at !== null && live
      ? version ? <div className="process-replay-file"><Snapshot client={client} projectId={snapshot.project.id} resource={version.resource} path={path} /></div>
        : <p className="process-note">The work had reached this file by {clock(process.at, true)}; its first version was kept at {clock(all[0].at, true)}.
          <button className="text-button" onClick={() => step(0)}>Go to {clock(all[0].at, true)}</button></p>
      : children}
  </div>;
}
