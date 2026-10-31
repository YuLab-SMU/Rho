import type { MouseEvent } from 'react';
import { studioViewable } from './canvas.js';
import { Icon } from './icons.js';
import { fileIcon, sourceLabels } from './project.js';
import type { SourceItem, SourceRow } from './sources.js';

// What a person puts on a Studio page of their own: the Notebook, the sessions' variables,
// plots and data flow, and the project's files by
// kind, each opening in the view it has elsewhere in Studio. A kind lists its first few files;
// the rest are on its own page.
export const pageAddLimits = { filesPerKind: 6 };
const rows: SourceRow[] = ['results', 'data', 'code', 'reports', 'workflows', 'notes', 'references', 'environment'];
export function PageAdd({ sources, notebook, variables = 'unavailable', plots = 'unavailable', flow = 'unavailable', servers = 'unavailable', onNotebook, onSessionView, onFile, onAll }: {
  sources: Record<SourceRow, SourceItem[]> | null; notebook: 'absent' | 'present' | 'unavailable';
  variables?: 'absent' | 'present' | 'unavailable'; plots?: 'absent' | 'present' | 'unavailable'; flow?: 'absent' | 'present' | 'unavailable'; servers?: 'absent' | 'present' | 'unavailable';
  onNotebook: () => void; onSessionView?: (kind: 'variables' | 'plots' | 'flow' | 'servers') => void; onFile: (path: string) => void; onAll: (row: SourceRow) => void;
}) {
  // A choice made from a menu closes it.
  const chose = (run: () => void) => (event: MouseEvent<HTMLButtonElement>) => { event.currentTarget.closest('details')?.removeAttribute('open'); run(); };
  return <div className="page-add">
    {notebook !== 'unavailable' && <button className="page-add-notebook" onClick={chose(onNotebook)}>
      <Icon name="code" size={17} /><span><strong>Notebook</strong><small>{notebook === 'present' ? 'On this page' : 'Live R and Python sessions you share with the Agent'}</small></span>
    </button>}
    {variables !== 'unavailable' && onSessionView && <button className="page-add-notebook" onClick={chose(() => onSessionView('variables'))}>
      <Icon name="list" size={17} /><span><strong>Variables</strong><small>{variables === 'present' ? 'On this page' : 'What the live sessions hold, each value a click away'}</small></span>
    </button>}
    {plots !== 'unavailable' && onSessionView && <button className="page-add-notebook" onClick={chose(() => onSessionView('plots'))}>
      <Icon name="chart" size={17} /><span><strong>Plots</strong><small>{plots === 'present' ? 'On this page' : 'What the live sessions draw, the newest first'}</small></span>
    </button>}
    {flow !== 'unavailable' && onSessionView && <button className="page-add-notebook" onClick={chose(() => onSessionView('flow'))}>
      <Icon name="workflow" size={17} /><span><strong>Data flow</strong><small>{flow === 'present' ? 'On this page' : 'How each value was made: what each cell read and made'}</small></span>
    </button>}
    {servers !== 'unavailable' && onSessionView && <button className="page-add-notebook" onClick={chose(() => onSessionView('servers'))}>
      <Icon name="server" size={17} /><span><strong>Servers</strong><small>{servers === 'present' ? 'On this page' : 'Run R and Python on a server you reach with ssh, and look at its files'}</small></span>
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
