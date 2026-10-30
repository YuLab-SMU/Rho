import type { Cost, Holds, Spend } from '../src/file-describer.js';
import { modelName } from '../src/file-describer.js';
import { money } from './agent-manage.js';
import './holds.css';

const time = (at?: number) => at === undefined ? '' : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Where a line about a file comes from, in words: the notes, a model's sentence or the facts read.
export function holdsSource(holds: Holds) {
  return holds.source === 'notes' ? 'Written in the project notes'
    : holds.source === 'model' ? `Described by ${modelName(holds.model)} at ${time(holds.at)} ${seen(holds)}${holds.earlier ? ', from an earlier version' : ''}; generated, not checked${holds.cost ? '. ' + costText(holds.cost) : ''}`
    : `Read from the file at ${time(holds.at)}${holds.writing ? '; a description is being written' : ''}`;
}
// What a file holds, in one line or two, marked by where it comes from: the notes' words plain,
// a model's sentence followed by the model's name, the facts read from the file muted.
export function HoldsText({ holds, className }: { holds: Holds; className: string }) {
  const fact = holds.source === 'notes' ? 'declared' : holds.source === 'model' ? 'generated' : 'observed';
  return <p className={className + ' holds holds-' + holds.source} data-fact={fact} title={holds.text + '\n' + holdsSource(holds)}>
    <span className="holds-text">{holds.text}</span>
    {holds.source === 'model' && <small className="holds-by">{modelName(holds.model)}{holds.strategy === 'context' ? ' · from code' : ''}{holds.earlier ? ' · earlier version' : ''}</small>}
    {holds.writing && <small className="holds-by">describing…</small>}
  </p>;
}

// How the model was given the file, in words.
export const seen = (holds: Pick<Holds, 'strategy' | 'from'>) => holds.strategy === 'image' ? 'from the image'
  : holds.strategy === 'context' ? 'without seeing it, from ' + (holds.from?.length ? holds.from.join(' and ') : 'what made it') : 'from its facts and first lines';
// One call's cost and where the figure comes from.
// A description costs fractions of a cent, so small amounts keep four decimals.
const cents = (usd: number) => usd >= 0.01 ? money(usd) : usd < 0.00005 ? '<$0.0001' : '$' + usd.toFixed(4);
export const costText = (cost: Cost) => cost.usd === null ? 'Cost not known: ' + cost.note + '.' : (cost.basis === 'estimated' ? 'About ' : '') + cents(cost.usd) + ', ' + cost.note + '.';
// What a conversation's descriptions spent, summed over its messages.
export function spendOf(spends: Array<Spend | undefined>): Spend | null {
  const all = spends.filter((s): s is Spend => !!s);
  return all.length ? all.reduce((a, s) => ({ calls: a.calls + s.calls, usd: a.usd + s.usd, estimated: a.estimated + s.estimated, unknown: a.unknown + s.unknown })) : null;
}
export const spendAmount = (spend: Spend) => spend.unknown === spend.calls ? 'not known' : (spend.estimated || spend.unknown ? '≈' : '') + cents(spend.usd);
// How the calls were priced: by Claude Code, from models.dev's prices, or not at all.
export function spendBasis(spend: Spend) {
  const reported = spend.calls - spend.estimated - spend.unknown;
  const parts = [[reported, 'priced by Claude Code'], [spend.estimated, 'priced from models.dev'], [spend.unknown, 'not priced']] as const;
  const used = parts.filter(([n]) => n > 0);
  const calls = spend.calls + (spend.calls === 1 ? ' call' : ' calls');
  return used.length === 1 ? `${calls}, ${used[0]![1]}.` : `${calls}: ${used.map(([n, what]) => n + ' ' + what).join(', ')}.`;
}
