import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { agentLabel, backends, effortSetting, modelSetting, ModelList, NotAsked, split, valueName, type AgentSettingsState, type Backend, type SettingOption, type SettingValue } from './agent-settings.js';
import { BrandMark, brandOf } from './brand-marks.js';
import { Icon } from './icons.js';
import './settings-menu.css';

// The settings of the next message, under the message box: one chip that names the model,
// effort and what is switched on, and a short menu with a row per setting. A row opens its
// list in place; a switch changes at once. The values and their names are the Agent's own.
type View = { kind: 'root' } | { kind: 'agent' } | { kind: 'option'; id: string };
const labelOf = (option: SettingOption) => option.category === 'thought_level' ? 'Effort' : option.category === 'model' ? 'Model' : option.name;
const switchOf = (option: SettingOption) => option.type === 'boolean'
  || (option.values?.length === 2 && option.values.map(v => v.value.toLowerCase()).sort().join() === 'off,on');

function step(menu: HTMLElement, from: Element | null, by: number) {
  const items = [...menu.querySelectorAll<HTMLElement>('[data-item]:not(:disabled)')];
  if (!items.length) return;
  const at = items.indexOf(from as HTMLElement);
  items[at < 0 ? (by > 0 ? 0 : items.length - 1) : (at + by + items.length) % items.length].focus();
}

export function SettingsMenu({ agent, options, values, allowDefault, disabled, disabledNote, agents, checking, checkProblem, onCheck, onChoose, describe }: {
  agent: string; options: SettingOption[] | null; values: Record<string, SettingValue>; allowDefault: boolean;
  disabled?: boolean; disabledNote?: string; agents?: { current: Backend; choose: (which: Backend) => void };
  checking?: boolean; checkProblem?: string; onCheck?: () => void;
  onChoose: (id: string, value: SettingValue | null) => void; describe: string;
}) {
  const [open, setOpen] = useState(false), [view, setView] = useState<View>({ kind: 'root' });
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), from = useRef('');
  const model = modelSetting(options), effort = effortSetting(options);
  const rest = (options ?? []).filter(option => option !== model && option !== effort);
  // A setting the person has not chosen follows the Agent's own default.
  const chosen = (option: SettingOption) => option.id in values ? values[option.id] : null;
  const shown = (option: SettingOption) => valueName(option, chosen(option) ?? option.current);
  const brand = agents ? brandOf(agent) : null;
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  // Focus goes where the person is: the first row, the row a list was opened from, or the
  // value already chosen in a list. The model list focuses its own search box.
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    if (view.kind === 'option' && view.id === model?.id && model.values?.length) return;
    const target = view.kind === 'root' && from.current ? menu.current.querySelector<HTMLElement>(`[data-row="${CSS.escape(from.current)}"]`)
      : menu.current.querySelector<HTMLElement>('[data-item][aria-checked="true"], [data-item][aria-selected="true"]');
    (target ?? menu.current.querySelector<HTMLElement>('[data-item]:not(.menu-back)') ?? menu.current.querySelector<HTMLElement>('[data-item]'))?.focus({ preventScroll: true });
  }, [open, view]);
  function show(next: boolean) { setOpen(next); setView({ kind: 'root' }); from.current = ''; if (!next) trigger.current?.focus({ preventScroll: true }); }
  function go(next: View, row: string) { from.current = row; setView(next); }
  function back() { setView({ kind: 'root' }); }
  function pick(option: SettingOption, value: SettingValue | null) { if (value !== chosen(option)) onChoose(option.id, value); show(false); }
  // Escape and the arrows stay in the menu: Escape steps back, then closes, and never closes
  // the panel or sheet around it.
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || !menu.current) return;
    const typing = (event.target as HTMLElement).tagName === 'INPUT';
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (view.kind === 'root') show(false); else back(); }
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !typing) { event.preventDefault(); step(menu.current, document.activeElement, event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'ArrowLeft' && !typing && view.kind !== 'root') { event.preventDefault(); back(); }
    else if (event.key === 'ArrowRight' && !typing && (event.target as HTMLElement).dataset.opens) { event.preventDefault(); (event.target as HTMLElement).click(); }
  }
  const modelName = model ? split(shown(model)) : { name: 'Model', group: '' };
  const effortName = effort ? shown(effort) : '';
  const option = view.kind === 'option' ? (options ?? []).find(o => o.id === view.id) ?? null : null;
  // A setting that is only on or off, as a boolean or as a list of On and Off, is a switch.
  const isOn = (option: SettingOption) => { const value = chosen(option) ?? option.current; return value === true || (typeof value === 'string' && value.toLowerCase() === 'on'); };
  function flip(option: SettingOption) {
    const next = !isOn(option);
    onChoose(option.id, option.type === 'boolean' ? next : option.values!.find(v => (v.value.toLowerCase() === 'on') === next)!.value);
  }
  const on = rest.filter(option => switchOf(option) && isOn(option)).map(option => option.name);
  const row = (option: SettingOption) => switchOf(option)
    ? <button key={option.id} data-item data-row={option.id} role="switch" aria-checked={isOn(option)} className="menu-row" title={option.description ?? undefined} onClick={() => flip(option)}>
        <span className="menu-label">{labelOf(option)}</span><span className={'menu-switch' + (isOn(option) ? ' on' : '')} aria-hidden="true" />
      </button>
    : <button key={option.id} data-item data-row={option.id} data-opens="1" className="menu-row" title={option.description ?? undefined} onClick={() => go({ kind: 'option', id: option.id }, option.id)}>
        <span className="menu-label">{labelOf(option)}</span><span className="menu-value"><span>{shown(option)}</span></span><Icon name="chevron" size={12} />
      </button>;
  return <div ref={root} className="settings-menu composer-settings">
    <button ref={trigger} className="setting-chip" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title={disabled ? disabledNote : describe}
      aria-label={[describe, modelName.name, modelName.group, effortName && effortName + ' effort', ...on].filter(Boolean).join(', ')} onClick={() => show(!open)}>
      <span className="setting-summary">
        {brand && <span className="summary-agent"><BrandMark brand={brand} size={13} /></span>}
        <span className="summary-model">{modelName.name}</span>{modelName.group && <span className="summary-group">{modelName.group}</span>}
        {effortName && <span className="summary-effort">{effortName}</span>}
        {on.map(name => <span key={name} className="summary-effort">{name}</span>)}
      </span>
      <Icon name="chevron" size={11} />
    </button>
    {open && <div ref={menu} className={'menu-pop' + (option === model && model ? ' wide' : '')} role="dialog" aria-label={describe} onKeyDown={key}>
      {view.kind === 'root' ? <>
        {agents && <><button data-item data-row="agent" data-opens="1" className="menu-row" onClick={() => go({ kind: 'agent' }, 'agent')}>
          <span className="menu-label">Agent</span><span className="menu-value">{brand && <BrandMark brand={brand} size={13} />}<span>{agent}</span></span><Icon name="chevron" size={12} />
        </button><div className="menu-divider" role="separator" /></>}
        {options?.length ? <>
          {model && row(model)}
          {effort && row(effort)}
          {rest.length > 0 && (model || effort) && <div className="menu-divider" role="separator" />}
          {rest.map(row)}
        </> : <NotAsked agent={agent} checking={checking} checkProblem={checkProblem} onCheck={onCheck} />}
      </> : <>
        <div className="menu-head"><button data-item className="menu-back" aria-label="Back" title="Back" onClick={back}><Icon name="back" size={14} /></button><span>{view.kind === 'agent' ? 'Agent' : option ? labelOf(option) : ''}</span></div>
        {view.kind === 'agent' && agents ? <div className="menu-choices" role="radiogroup" aria-label="Agent">{backends.map(which => <button key={which} data-item role="radio" aria-checked={which === agents.current} className="menu-choice"
          onClick={() => { if (which !== agents.current) agents.choose(which); back(); }}>
          <BrandMark brand={which === 'codex-acp' ? 'codex' : 'claude-code'} size={14} /><span className="menu-choice-text">{agentLabel[which]}</span>{which === agents.current && <Icon name="check" size={14} />}
        </button>)}</div>
          : option && option === model && model.values?.length ? <ModelList option={model} value={chosen(model) as string | null ?? (allowDefault ? null : model.current as string)} agent={agent} allowDefault={allowDefault}
            onChoose={value => pick(model, value)} onEscape={back} />
          : option ? <div className="menu-choices" role="radiogroup" aria-label={labelOf(option)}>
            {allowDefault && <button data-item role="radio" aria-checked={chosen(option) === null} className="menu-choice" onClick={() => pick(option, null)}>
              <span className="menu-choice-text">Not chosen<small>{agent} uses {valueName(option, option.current)}</small></span>{chosen(option) === null && <Icon name="check" size={14} />}
            </button>}
            {(option.values ?? []).map(v => {
              const selected = (chosen(option) ?? (allowDefault ? null : option.current)) === v.value;
              return <button key={v.value} data-item role="radio" aria-checked={selected} className="menu-choice" onClick={() => pick(option, v.value)}>
                <span className="menu-choice-text">{split(v.name).name}{v.description && <small>{v.description}</small>}</span>{selected && <Icon name="check" size={14} />}
              </button>;
            })}
          </div> : null}
      </>}
    </div>}
  </div>;
}

// For a new conversation: the saved Agent and its choices, kept for every project.
export function ComposerSettings({ state }: { state: AgentSettingsState }) {
  const { backend } = state, agent = agentLabel[backend];
  if (!state.settings) return null;
  return <SettingsMenu agent={agent} options={state.offered(backend)?.options ?? null} values={state.choices(backend)} allowDefault
    agents={{ current: backend, choose: which => void state.chooseAgent(which) }} checking={state.checking.has(backend)} checkProblem={state.checkProblem[backend]}
    onCheck={() => void state.check(backend)} onChoose={(id, value) => void state.choose(backend, id, value)} describe="Settings for a new conversation" />;
}

// For an open conversation: its own settings, changed between messages.
export function OpenSettings({ options, values, agent, disabled, onChoose, checking, checkProblem, onCheck }: {
  options: SettingOption[] | null; values: Record<string, SettingValue>; agent: string; disabled: boolean;
  onChoose: (id: string, value: SettingValue) => void; checking?: boolean; checkProblem?: string; onCheck?: () => void;
}) {
  return <SettingsMenu agent={agent} options={options} values={values} allowDefault={false} disabled={disabled} disabledNote="Change after this message"
    checking={checking} checkProblem={checkProblem} onCheck={onCheck} onChoose={(id, value) => value !== null && onChoose(id, value)} describe="Settings for the next message" />;
}
