import type { Holds } from '../src/file-describer.js';
import { modelName } from '../src/file-describer.js';
import './holds.css';

const time = (at?: number) => at === undefined ? '' : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Where a line about a file comes from, in words: the notes, a model's sentence or the facts read.
export function holdsSource(holds: Holds) {
  return holds.source === 'notes' ? 'Written in the project notes'
    : holds.source === 'model' ? `Described by ${modelName(holds.model)} at ${time(holds.at)}${holds.earlier ? ' from an earlier version' : ''}; generated, not checked`
    : `Read from the file at ${time(holds.at)}${holds.writing ? '; a description is being written' : ''}`;
}
// What a file holds, in one line or two, marked by where it comes from: the notes' words plain,
// a model's sentence followed by the model's name, the facts read from the file muted.
export function HoldsText({ holds, className }: { holds: Holds; className: string }) {
  const fact = holds.source === 'notes' ? 'declared' : holds.source === 'model' ? 'generated' : 'observed';
  return <p className={className + ' holds holds-' + holds.source} data-fact={fact} title={holds.text + '\n' + holdsSource(holds)}>
    <span className="holds-text">{holds.text}</span>
    {holds.source === 'model' && <small className="holds-by">{modelName(holds.model)}{holds.earlier ? ' · earlier version' : ''}</small>}
    {holds.writing && <small className="holds-by">describing…</small>}
  </p>;
}
