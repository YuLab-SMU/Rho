import type { MouseEvent } from 'react';
import { studioViewable } from './canvas.js';
import { Icon } from './icons.js';
import { fileIcon, sourceLabels } from './project.js';
import type { SourceItem, SourceRow } from './sources.js';

// What a person puts on a Studio page of their own: the Notebook, and the project's files by
// kind, each opening in the view it has elsewhere in Studio. A kind lists its first few files;
// the rest are on its own page.
export const pageAddLimits = { filesPerKind: 6 };
const rows: SourceRow[] = ['results', 'data', 'code', 'notes'];
export function PageAdd({ sources, notebook, onNotebook, onFile, onAll }: {
  sources: Record<SourceRow, SourceItem[]> | null; notebook: 'absent' | 'present' | 'unavailable';
  onNotebook: () => void; onFile: (path: string) => void; onAll: (row: SourceRow) => void;
}) {
  // A choice made from a menu closes it.
  const chose = (run: () => void) => (event: MouseEvent<HTMLButtonElement>) => { event.currentTarget.closest('details')?.removeAttribute('open'); run(); };
  return <div className="page-add">
    {notebook !== 'unavailable' && <button className="page-add-notebook" onClick={chose(onNotebook)}>
      <Icon name="code" size={17} /><span><strong>Notebook</strong><small>{notebook === 'present' ? 'On this page' : 'Live R and Python sessions you share with the Agent'}</small></span>
    </button>}
    {!sources ? <p className="page-add-note" role="status">Reading the project folders…</p>
      : rows.map(row => {
        const items = sources[row].filter(item => studioViewable(item.path));
        if (!items.length) return null;
        return <section key={row} className="page-add-kind" aria-label={sourceLabels[row]}>
          <h3>{sourceLabels[row]}</h3>
          {items.slice(0, pageAddLimits.filesPerKind).map(item => <button key={item.key} title={item.path} onClick={chose(() => onFile(item.path))}><Icon name={fileIcon(item)} size={15} stroke={1.7} /><span>{item.name}</span><small>{item.folder}</small></button>)}
          {items.length > pageAddLimits.filesPerKind && <button className="page-add-all" onClick={chose(() => onAll(row))}>All {items.length} {sourceLabels[row].toLowerCase()}</button>}
        </section>;
      })}
  </div>;
}
