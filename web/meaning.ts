import { useEffect, useMemo, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { GraphFile, WorkGraph } from '../src/work-graph.js';
import { notesMeaning, traceStatement, fileDescriptions, type NotesVersion, type Statement, type Trace, type SessionMeaning, type Described } from '../src/notes-meaning.js';
import { meaningLayer, type MeaningLayer } from '../src/meaning-graph.js';
import { notesLimits, projectNotesPath } from '../src/project-notes.js';
import { kindOf } from './sources.js';
import { readBytes } from './previews.js';

// The protected resources are the service and the tab: at most this many kept versions of the
// notes are read to trace statements, each within the notes' byte limit. Past either, the
// statements in the versions not read are traced to the oldest version read.
export const meaningLimits = { versions: 24 };
const versionTexts = new Map<string, Promise<string>>();

export interface Meaning { meanings: SessionMeaning[]; traces: Map<Statement, Trace>; layer: MeaningLayer; descriptions: Map<string, Described>; versions: { read: number; kept: number } }
// What the project notes say about the work, each statement traced to the kept version of the
// notes it first appeared in and the files it names to their versions then. Follows the notes
// as they change while the Agent works.
export function useMeaning(client: BrowserClient, snapshot: WorkspaceSnapshot, process: WorkGraph, files: GraphFile[], notesText: string): Meaning {
  const projectId = snapshot.project.id;
  // Every version of the notes the Agent's record kept, with the message that kept it.
  const kept = useMemo(() => process.nodes.filter(n => n.kind === 'file' && n.path === projectNotesPath).flatMap(n => (n.versions ?? (n.resource ? [{ resource: n.resource, capturedAt: n.capturedAt ?? n.at }] : []))
    .map(v => ({ ...v, turn: n.events.find(e => e.action === 'capture' && e.key.endsWith(':' + v.resource.id))?.turn ?? n.events[0]?.turn ?? '' })))
    .sort((a, b) => a.capturedAt - b.capturedAt).slice(-meaningLimits.versions), [process]);
  const key = kept.map(v => v.resource.version).join(',');
  const [versions, setVersions] = useState<NotesVersion[]>([]);
  useEffect(() => {
    let live = true;
    Promise.all(kept.map(v => {
      const id = projectId + ':' + v.resource.id + '@' + v.resource.version;
      if (!versionTexts.has(id)) versionTexts.set(id, readBytes(client, projectId, v.resource, notesLimits.maxTitleBytes).then(bytes => new TextDecoder().decode(bytes)).catch(() => { versionTexts.delete(id); return ''; }));
      return versionTexts.get(id)!.then(text => ({ text, at: v.capturedAt, turn: v.turn, conversationId: v.turn.split('/')[0] ?? '', resource: v.resource }));
    })).then(read => { if (live) setVersions(read.filter(v => v.text)); });
    return () => { live = false; };
  }, [client, projectId, key]);
  return useMemo(() => {
    const meanings = notesMeaning(notesText.length > notesLimits.maxTitleBytes ? '' : notesText);
    const keptOf = (path: string) => process.nodes.filter(n => n.kind === 'file' && n.path === path)
      .flatMap(n => n.versions ?? (n.resource ? [{ resource: n.resource, capturedAt: n.capturedAt ?? n.at }] : [])).map(v => ({ at: v.capturedAt, resource: v.resource }));
    const changedAt = (path: string) => { const f = files.find(x => x.path === path); return f?.modifiedAt ? Date.parse(f.modifiedAt) : null; };
    const traces = new Map<Statement, Trace>();
    for (const session of meanings) for (const statement of session.statements) traces.set(statement, traceStatement(statement, versions, keptOf, changedAt));
    const layer = meaningLayer({ process, meanings, traces, files, kindOf: path => kindOf(path) });
    return { meanings, traces, layer, descriptions: fileDescriptions(meanings), versions: { read: versions.length, kept: kept.length } };
  }, [notesText, versions, process, files]);
}
