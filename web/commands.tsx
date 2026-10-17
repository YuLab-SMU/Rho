import { useEffect, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from './icons.js';

export interface Command { id: string; label: string; icon: IconName; meta?: string; danger?: boolean; run: () => void }
export interface CommandGroup { label: string; commands: Command[] }
// Commands only: typing filters the list and never sends a question anywhere.
export function CommandPalette({ groups, onRun }: { groups: CommandGroup[]; onRun: (command: Command) => void }) {
  const [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const words = query.trim().toLowerCase();
  const shown = groups.map(g => ({ ...g, commands: g.commands.filter(c => !words || c.label.toLowerCase().includes(words)) })).filter(g => g.commands.length);
  const flat = shown.flatMap(g => g.commands), current = Math.min(active, flat.length - 1), selected = flat[current];
  useEffect(() => { if (selected) document.getElementById('command-' + selected.id)?.scrollIntoView({ block: 'nearest' }); }, [selected?.id]);
  function key(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && flat.length) {
      event.preventDefault();
      setActive((current + (event.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length);
    } else if (event.key === 'Enter' && selected) { event.preventDefault(); onRun(selected); }
  }
  return <>
    <div className="command-filter">
      <Icon name="prompt" size={16} stroke={1.6} />
      <input role="combobox" aria-label="Command" aria-expanded="true" aria-controls="command-list" aria-autocomplete="list" aria-activedescendant={selected ? 'command-' + selected.id : undefined}
        placeholder="Type a command" value={query} onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={key} autoComplete="off" spellCheck={false} />
      <kbd>Esc</kbd>
    </div>
    <div id="command-list" className="command-list" role="listbox" aria-label="Commands">
      {shown.map((g, index) => <div key={g.label} className="command-group" role="group" aria-labelledby={'command-group-' + index}>
        <span className="command-heading" id={'command-group-' + index}>{g.label}</span>
        {g.commands.map(c => {
          const position = flat.indexOf(c);
          return <div key={c.id} id={'command-' + c.id} role="option" aria-selected={position === current} className={'command-item' + (c.danger ? ' command-danger' : '')}
            onMouseMove={() => setActive(position)} onClick={() => onRun(c)}>
            <Icon name={c.icon} size={16} stroke={1.7} />
            <span className="command-label">{c.label}</span>
            {c.meta && <span className="command-meta">{c.meta}</span>}
            {position === current && <span className="command-enter"><Icon name="enter" size={14} stroke={1.7} /></span>}
          </div>;
        })}
      </div>)}
      {!flat.length && <p className="command-none">No command matches “{query.trim()}”.</p>}
    </div>
    <div className="command-footer">
      <p>Commands only. To ask about your work, use Claude Code.</p>
      <span className="command-keys" aria-hidden="true"><kbd>↑↓</kbd><span>move</span><kbd>↵</kbd><span>run</span></span>
    </div>
  </>;
}
