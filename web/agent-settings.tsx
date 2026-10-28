import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { BrowserApiError, type BrowserClient } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { Icon } from './icons.js';
import { BrandMark, brandOf, ProviderMark } from './brand-marks.js';

// The person's Agent and its settings (model, effort, mode…) for new conversations, and the
// same controls for one open conversation. The values and their names are the Agent's own,
// as it last offered them; Rho asks only when the person checks, never on its own.
export type AgentSettings = RhoOutput<'conversation.settings.read'>;
export type Backend = 'claude-acp' | 'codex-acp';
type Offered = NonNullable<AgentSettings['offered']['claude-acp']>;
export type SettingOption = Offered['options'][number];
export type SettingValue = string | boolean;
export const backends: Backend[] = ['claude-acp', 'codex-acp'];
export const agentLabel: Record<Backend, string> = { 'claude-acp': 'Claude Code', 'codex-acp': 'Codex' };
export const backendOf = (client?: string | null): Backend => client === 'codex' ? 'codex-acp' : 'claude-acp';

// One copy for every place in this tab that shows the settings.
const store = { value: null as AgentSettings | null, reading: false, problem: '', checking: new Set<Backend>(), checkProblem: {} as Partial<Record<Backend, string>>, version: 0, listeners: new Set<() => void>() };
const changed = () => { store.version++; store.listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; };
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
async function load(client: BrowserClient, projectId: string) {
  store.reading = true;
  try { store.value = await client.call('conversation.settings.read', { projectId }); store.problem = ''; }
  catch (error) { store.problem = message(error, 'The Agent settings could not be read.'); }
  finally { store.reading = false; changed(); }
}

export function useAgentSettings(client: BrowserClient, projectId: string) {
  useSyncExternalStore(subscribe, () => store.version);
  useEffect(() => { if (!store.value && !store.reading) void load(client, projectId); }, [client, projectId]);
  const settings = store.value;
  const backend: Backend = settings?.backend ?? (settings?.serviceBackend === 'codex-acp' ? 'codex-acp' : 'claude-acp');
  // A change made in another tab is read first and this one applied on top, once.
  async function update(patch: (current: AgentSettings) => { backend?: Backend; choices?: Partial<Record<Backend, Record<string, SettingValue>>> }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = store.value ?? await client.call('conversation.settings.read', { projectId });
      try {
        store.value = await client.call('conversation.settings.update', { projectId, expectedVersion: current.version, ...patch(current) });
        store.problem = ''; changed(); return true;
      } catch (error) {
        if (attempt === 0 && error instanceof BrowserApiError && error.error.kind === 'conflict') { store.value = await client.call('conversation.settings.read', { projectId }); continue; }
        store.problem = message(error, 'The Agent settings could not be saved.'); changed(); return false;
      }
    }
    return false;
  }
  return {
    settings, backend, problem: store.problem, checking: store.checking, checkProblem: store.checkProblem,
    offered: (which: Backend) => settings?.offered[which] ?? null,
    choices: (which: Backend) => (settings?.choices[which] ?? {}) as Record<string, SettingValue>,
    chooseAgent: (which: Backend) => update(() => ({ backend: which })),
    // null returns the setting to the Agent's own default.
    choose: (which: Backend, id: string, value: SettingValue | null) => update(current => {
      const next: Record<string, SettingValue> = { ...current.choices[which] };
      if (value === null) delete next[id]; else next[id] = value;
      return { choices: { [which]: next } };
    }),
    async check(which: Backend) {
      if (store.checking.has(which)) return;
      store.checking.add(which); delete store.checkProblem[which]; changed();
      try { store.value = await client.call('conversation.settings.check', { projectId, backend: which }); }
      catch (error) { store.checkProblem[which] = message(error, agentLabel[which] + ' could not be asked.'); }
      finally { store.checking.delete(which); changed(); }
    }
  };
}
export type AgentSettingsState = ReturnType<typeof useAgentSettings>;

export const modelSetting = (options?: SettingOption[] | null) => options?.find(o => o.category === 'model' && o.type === 'select') ?? null;
export const effortSetting = (options?: SettingOption[] | null) => options?.find(o => o.category === 'thought_level' && o.type === 'select') ?? null;
// Names such as "DeepSeek V4.1 Flash · routing group" carry where the model comes from.
export function split(name: string) { const at = name.lastIndexOf(' · '); return at > 0 ? { name: name.slice(0, at), group: name.slice(at + 3) } : { name, group: '' }; }
export function valueName(option: SettingOption | null | undefined, value: SettingValue | null | undefined) {
  if (value === null || value === undefined) return '';
  if (option?.type === 'boolean' || typeof value === 'boolean') return value ? 'On' : 'Off';
  // The whole name: the same model is often offered through several providers.
  return option?.values?.find(v => v.value === value)?.name ?? value;
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function when(iso: string) {
  const at = new Date(iso), today = new Date();
  return at.toDateString() === today.toDateString() ? 'today ' + clock(iso) : at.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + clock(iso);
}

// Every model the Agent offers, grouped by where it comes from, searchable by name or value.
// The first entry returns to the Agent's own default when one is allowed. The search box holds
// the focus; arrows move through the list and Enter chooses.
export function ModelList({ option, value, agent, allowDefault, onChoose, onEscape }: {
  option: SettingOption; value: string | null; agent: string; allowDefault?: boolean; onChoose: (value: string | null) => void; onEscape?: () => void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), id = useId();
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const entries = (option.values ?? []).map(v => ({ ...v, ...split(v.name), group: v.group ?? split(v.name).group }))
    .filter(v => words.every(word => (v.name + ' ' + v.value + ' ' + v.group).toLowerCase().includes(word)));
  const groups = [...new Set(entries.map(v => v.group))].sort((a, b) => Number(!!a) - Number(!!b));
  const ordered = groups.flatMap(group => entries.filter(v => v.group === group));
  const showDefault = allowDefault && !words.length;
  const items: Array<string | null> = [...(showDefault ? [null] : []), ...ordered.map(v => v.value)];
  const [active, setActive] = useState(() => Math.max(0, items.indexOf(value)));
  const current = Math.min(active, items.length - 1), defaultName = valueName(option, option.current as string);
  useEffect(() => { search.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const item = document.getElementById(id + '-' + current), box = list.current;
    if (!item || !box) return;
    if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop - 4;
    else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight + 4;
  }, [current]);
  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onEscape?.(); }
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) { event.preventDefault(); setActive((current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length); }
    else if (event.key === 'Enter' && items.length) { event.preventDefault(); onChoose(items[current]); }
  }
  return <>
    <div className="model-search"><Icon name="search" size={14} />
      <input ref={search} role="combobox" aria-expanded="true" aria-controls={id + '-list'} aria-autocomplete="list" aria-activedescendant={items.length ? id + '-' + current : undefined}
        aria-label="Search models" placeholder={'Search ' + option.values!.length + ' models'} value={query} spellCheck={false} autoComplete="off"
        onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={key} /></div>
    <div ref={list} id={id + '-list'} className="model-list" role="listbox" aria-label="Models">
      {showDefault && <div id={id + '-0'} role="option" aria-selected={value === null} className={'model-option' + (current === 0 ? ' active' : '')} onMouseMove={() => setActive(0)} onClick={() => onChoose(null)}>
        <span className="model-name">{agent}'s default</span>{defaultName && <span className="model-meta">{defaultName}</span>}{value === null && <Icon name="check" size={14} />}</div>}
      {groups.map(group => <div key={group || '-'} role="group" aria-label={group || agent}>
        {(group || groups.length > 1) && <span className="model-group" aria-hidden="true"><ProviderMark name={group || agent} size={13} />{group || agent}</span>}
        {ordered.filter(v => v.group === group).map(v => {
          const index = items.indexOf(v.value);
          return <div key={v.value} id={id + '-' + index} role="option" aria-selected={value === v.value} className={'model-option' + (current === index ? ' active' : '')}
            title={v.value + (v.description ? '\n' + v.description : '')} onMouseMove={() => setActive(index)} onClick={() => onChoose(v.value)}>
            <span className="model-name">{v.name}</span>{v.value === option.current && allowDefault && <span className="model-meta">default</span>}{value === v.value && <Icon name="check" size={14} />}</div>;
        })}
      </div>)}
      {!items.length && <p className="model-none">No model matches “{query.trim()}”.</p>}
    </div>
  </>;
}

// What a menu says while the Agent has not told Rho what it offers.
export function NotAsked({ agent, checking, checkProblem, onCheck }: { agent: string; checking?: boolean; checkProblem?: string; onCheck?: () => void }) {
  return <div className="model-unknown">
    <p>{checking ? 'Asking ' + agent + ' which models it offers…' : 'Rho has not asked ' + agent + ' which models it offers yet.'}</p>
    {checkProblem && <p className="inline-error" role="alert">{checkProblem}</p>}
    {onCheck && <button className="small-button" disabled={checking} onClick={onCheck}>{checking ? 'Asking…' : 'Ask ' + agent}</button>}
    <small>Starts {agent} in this project for a few seconds. No message is sent.</small>
  </div>;
}

// The model chip with its list in a popover, as the Agents tab shows it for each Agent.
// A summary replaces the chip's text.
export function ModelPicker({ option, value, agent, allowDefault, disabled, disabledNote, checking, checkProblem, onChoose, onCheck, className, summary, summaryText }: {
  option: SettingOption | null; value: string | null; agent: string; allowDefault?: boolean; disabled?: boolean; disabledNote?: string;
  checking?: boolean; checkProblem?: string; onChoose: (value: string | null) => void; onCheck?: () => void; className?: string;
  summary?: ReactNode; summaryText?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ left: number; width: number; up: boolean; height: number } | null>(null);
  const defaultName = valueName(option, option?.current as string);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  // The list fits inside the panel or page that holds it, and only the list scrolls: moving
  // through it never scrolls the conversation or page around it.
  useLayoutEffect(() => {
    if (!open || !root.current) { setPlace(null); return; }
    const anchor = root.current.getBoundingClientRect();
    let left = 0, right = innerWidth, top = 0, bottom = innerHeight;
    for (let node = root.current.parentElement; node; node = node.parentElement) {
      if (!/(auto|scroll|hidden)/.test(getComputedStyle(node).overflowX)) continue;
      const box = node.getBoundingClientRect();
      left = Math.max(left, box.left); right = Math.min(right, box.right); top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); break;
    }
    // Opens on the side it was placed on unless the other has clearly more room.
    const width = Math.min(360, right - left - 16), above = anchor.top - top - 8, below = bottom - anchor.bottom - 8;
    const up = below < 360 && above > below;
    setPlace({ left: Math.min(Math.max(anchor.left, left + 8), right - 8 - width) - anchor.left, width, up, height: Math.max(160, Math.min(480, up ? above : below)) });
  }, [open]);
  function show(next: boolean) { setOpen(next); if (!next) button.current?.focus({ preventScroll: true }); }
  function choose(next: string | null) { show(false); if (next !== value) onChoose(next); }
  const shown = value === null ? (allowDefault ? 'Default' + (defaultName ? ' · ' + defaultName : '') : 'Model') : valueName(option, value);
  const known = !!option?.values?.length;
  return <div ref={root} className={'model-picker' + (className ? ' ' + className : '')}>
    <button ref={button} className="setting-chip" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} aria-label={summaryText} title={disabled ? disabledNote : summaryText ?? 'Model: ' + shown}
      onClick={() => show(!open)}>{summary ?? <><span className="setting-chip-label">Model</span><span className="setting-chip-value">{shown}</span></>}<Icon name="updown" size={12} /></button>
    {open && <div className={'model-popover ' + (place?.up ? 'up' : 'down')} style={place ? { left: place.left, width: place.width, maxHeight: place.height } : { visibility: 'hidden' }} role="dialog" aria-label={'Choose the model ' + agent + ' uses'} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); show(false); } }}>
      {known ? <ModelList option={option!} value={value} agent={agent} allowDefault={allowDefault} onChoose={choose} onEscape={() => show(false)} />
        : <NotAsked agent={agent} checking={checking} checkProblem={checkProblem} onCheck={onCheck} />}
    </div>}
  </div>;
}

// Any other setting, as a compact select in the Agent's own words.
export function SettingSelect({ option, value, allowDefault, disabled, disabledNote, onChoose }: {
  option: SettingOption; value: SettingValue | null; allowDefault?: boolean; disabled?: boolean; disabledNote?: string; onChoose: (value: SettingValue | null) => void;
}) {
  const label = option.category === 'thought_level' ? 'Effort' : option.name;
  if (option.type === 'boolean') return <label className="setting-chip setting-check" title={option.description}><input type="checkbox" checked={(value ?? option.current) === true} disabled={disabled} onChange={event => onChoose(event.target.checked)} /><span>{label}</span></label>;
  const shown = value === null ? (allowDefault ? 'Default · ' + valueName(option, option.current) : '') : valueName(option, value);
  return <label className="setting-chip setting-select" title={disabled ? disabledNote : option.description ?? label}>
    <span className="setting-chip-label">{label}</span><span className="setting-chip-value">{shown}</span><Icon name="updown" size={12} />
    <select aria-label={label} value={value === null ? '' : String(value)} disabled={disabled} onChange={event => onChoose(event.target.value === '' ? null : event.target.value)}>
      {allowDefault && <option value="">Default ({valueName(option, option.current)})</option>}
      {(option.values ?? []).map(v => <option key={v.value} value={v.value} title={v.description}>{split(v.name).name}</option>)}
    </select>
  </label>;
}

// The settings that matter most first; the rest stay one click away.
export function ordered(options: SettingOption[]) {
  const model = modelSetting(options), effort = effortSetting(options);
  const mode = options.find(o => o.category === 'mode') ?? null;
  return { model, effort, mode, rest: options.filter(o => o !== model && o !== effort && o !== mode) };
}

// Read again each time the Agent page opens: a conversation or another tab may have changed them.
export function refreshAgentSettings(client: BrowserClient, projectId: string) { if (store.value && !store.reading) void load(client, projectId); }

