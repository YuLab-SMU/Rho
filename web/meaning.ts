import { useEffect, useMemo, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { GraphFile, GraphTurn, WorkGraph } from '../src/work-graph.js';
import { describedFiles, holdsOf, type Holds } from '../src/file-describer.js';
import { notesMeaning, traceStatement, fileDescriptions, type NotesVersion, type Statement, type Trace, type SessionMeaning, type Described } from '../src/notes-meaning.js';
import { notesLimits, projectNotesPath } from '../src/project-notes.js';
import { readBytes } from './previews.js';

// The protected resource is the service: every kept version of the notes is read to trace
// statements, this many at a time and each within the notes' byte limit, once for the life of
// the tab. A statement first found after a version that could not be read is not traced: the
// unread version may have held it already, and it is not placed at a later step than its own.
export const meaningLimits = { versionsAtOnce: 6 };
const versionTexts = new Map<string, Promise<string | null>>();

export interface Meaning { meanings: SessionMeaning[]; traces: Map<Statement, Trace>; descriptions: Map<string, Described>; versions: { read: number; kept: number };
  // What a file holds: the notes' words, else a model's sentence, else facts read from it.
  holds(path: string): Holds | undefined }
// What the project notes say about the work, each statement traced to the kept version of the
// notes it first appeared in and the files it names to their versions then. Follows the notes
// as they change while the Agent works, with what the messages' files were read to hold.
export function useMeaning(client: BrowserClient, snapshot: WorkspaceSnapshot, process: WorkGraph, files: GraphFile[], notesText: string, turns: GraphTurn[] = []): Meaning {
  const projectId = snapshot.project.id;
  // Every version of the notes the Agent's record kept, with the message that kept it.
  const kept = useMemo(() => process.nodes.filter(n => n.kind === 'file' && n.path === projectNotesPath).flatMap(n => (n.versions ?? (n.resource ? [{ resource: n.resource, capturedAt: n.capturedAt ?? n.at }] : []))
    .map(v => ({ ...v, turn: n.events.find(e => e.action === 'capture' && e.key.endsWith(':' + v.resource.id))?.turn ?? n.events[0]?.turn ?? '' })))
    .sort((a, b) => a.capturedAt - b.capturedAt), [process]);
  const key = kept.map(v => v.resource.version).join(',');
  const [versions, setVersions] = useState<{ read: NotesVersion[]; unread: number[] }>({ read: [], unread: [] });
  useEffect(() => {
    let live = true;
    const text = (v: typeof kept[number]) => {
      const id = projectId + ':' + v.resource.id + '@' + v.resource.version;
      if (!versionTexts.has(id)) versionTexts.set(id, readBytes(client, projectId, v.resource, notesLimits.maxTitleBytes).then(bytes => new TextDecoder().decode(bytes)).catch(() => { versionTexts.delete(id); return null; }));
      return versionTexts.get(id)!.then(text => ({ text, at: v.capturedAt, turn: v.turn, conversationId: v.turn.split('/')[0] ?? '', resource: v.resource }));
    };
    (async () => {
      const all: Array<Omit<NotesVersion, 'text'> & { text: string | null }> = [];
      for (let i = 0; i < kept.length && live; i += meaningLimits.versionsAtOnce) all.push(...await Promise.all(kept.slice(i, i + meaningLimits.versionsAtOnce).map(text)));
      if (live) setVersions({ read: all.filter((v): v is NotesVersion => v.text !== null), unread: all.filter(v => v.text === null).map(v => v.at) });
    })();
    return () => { live = false; };
  }, [client, projectId, key]);
  return useMemo(() => {
    const meanings = notesMeaning(notesText.length > notesLimits.maxTitleBytes ? '' : notesText);
    const keptOf = (path: string) => process.nodes.filter(n => n.kind === 'file' && n.path === path)
      .flatMap(n => n.versions ?? (n.resource ? [{ resource: n.resource, capturedAt: n.capturedAt ?? n.at }] : [])).map(v => ({ at: v.capturedAt, resource: v.resource }));
    const changedAt = (path: string) => { const f = files.find(x => x.path === path); return f?.modifiedAt ? Date.parse(f.modifiedAt) : null; };
    const traces = new Map<Statement, Trace>();
    for (const session of meanings) for (const statement of session.statements) {
      const trace = traceStatement(statement, versions.read, keptOf, changedAt);
      traces.set(statement, trace.written && versions.unread.some(at => at < trace.written!.at) ? { ...trace, written: null } : trace);
    }
    const described = describedFiles(turns), descriptions = fileDescriptions(meanings);
    return { meanings, traces, descriptions, versions: { read: versions.read.length, kept: kept.length }, holds: path => holdsOf(path, descriptions, described) };
  }, [notesText, versions, process, files, turns]);
}
