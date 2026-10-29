import { useEffect, useRef, useState } from 'react';
import type { BrowserClient } from '../src/browser.js';
import type { Entry } from './project.js';

// What a project holds, by the kind of file a person looks for. Kinds come from the file
// name only; nothing is opened or parsed to decide them.
export type SourceKind = 'data' | 'code' | 'figures' | 'notes' | 'results';
const kinds: Record<Exclude<SourceKind, 'results'>, string[]> = {
  data: ['csv', 'tsv', 'tab', 'xlsx', 'xls', 'json', 'parquet', 'feather', 'arrow', 'rds', 'rda', 'rdata', 'h5', 'h5ad', 'hdf5', 'loom', 'mtx', 'sav', 'dta', 'sas7bdat', 'fasta', 'fa', 'fastq', 'fq', 'bam', 'sam', 'vcf', 'bed', 'gtf', 'gff', 'gff3', 'nwk', 'tre', 'newick'],
  code: ['r', 'rmd', 'qmd', 'py', 'ipynb', 'sh', 'bash', 'zsh', 'jl', 'sql', 'js', 'mjs', 'ts', 'stan', 'smk', 'nf', 'wdl', 'cpp', 'c', 'h', 'rs', 'go', 'java', 'pl', 'awk', 'sas', 'do', 'm'],
  figures: ['png', 'jpg', 'jpeg', 'svg', 'pdf', 'gif', 'tif', 'tiff', 'webp', 'eps'],
  notes: ['md', 'markdown', 'txt', 'rst', 'org', 'tex', 'bib', 'docx', 'html'],
};
const byExtension = new Map(Object.entries(kinds).flatMap(([kind, list]) => list.map(ext => [ext, kind as SourceKind])));
// Tables and figures kept in an output folder are results of the work, not its inputs.
const outputs = new Set(['results', 'result', 'output', 'outputs', 'out', 'figures', 'figs', 'plots', 'reports']);
export function kindOf(path: string): SourceKind | null {
  const segments = path.split('/'), parts = segments.at(-1)!.toLowerCase().split('.');
  if (parts.length > 2 && ['gz', 'bz2', 'xz', 'zst'].includes(parts.at(-1)!)) parts.pop();
  const kind = parts.length > 1 ? byExtension.get(parts.at(-1)!) ?? null : null;
  return kind === 'data' && segments.slice(0, -1).some(part => outputs.has(part.toLowerCase())) ? 'results' : kind;
}
// Files the canvas can show in their own owner view; anything else that is text opens as a document.
export const capturable = (path: string) => /\.(csv|png|jpe?g|svg)$/i.test(path);

export interface ProjectFile extends Entry { category: SourceKind | null }
export interface ProjectFiles { files: ProjectFile[]; truncated: boolean; reading: boolean; problem: string; readAt: number; refresh(): void }

// Folders that hold installed tools or caches rather than the work itself.
const skipped = new Set(['node_modules', 'renv', 'packrat', '__pycache__', 'venv', '.venv', 'site-library', '.ipynb_checkpoints', '.Rproj.user', '.snakemake', '.nextflow']);
// The protected resource is the local service: a walk reads at most this many folders,
// this deep, and keeps this many files. Past a limit the counts say they are partial.
export const walkLimits = { maxFolders: 48, maxDepth: 5, maxFiles: 4000 };

async function walk(client: BrowserClient, projectId: string, signal: AbortSignal) {
  const files: ProjectFile[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
  let folders = 0, truncated = false;
  while (queue.length) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (folders >= walkLimits.maxFolders) { truncated = true; break; }
    const next = queue.shift()!;
    folders++;
    const listing = await client.call('project.entries', { projectId, ...(next.path ? { path: next.path } : {}) }, signal);
    if (listing.truncated) truncated = true;
    for (const entry of listing.entries) {
      if (entry.hidden) continue;
      if (entry.kind === 'folder') {
        if (skipped.has(entry.name)) continue;
        if (next.depth + 1 > walkLimits.maxDepth) { truncated = true; continue; }
        queue.push({ path: entry.path, depth: next.depth + 1 });
      } else {
        if (files.length >= walkLimits.maxFiles) { truncated = true; break; }
        files.push({ ...entry, category: kindOf(entry.path) });
      }
    }
  }
  return { files, truncated };
}

// One bounded walk when the project opens, and again after its records change, no more
// often than every few seconds. A failed walk keeps the last result and says so.
export function useProjectFiles(client: BrowserClient, projectId: string | undefined, cursor: number | undefined): ProjectFiles {
  const [state, setState] = useState<Omit<ProjectFiles, 'refresh'>>({ files: [], truncated: false, reading: false, problem: '', readAt: 0 });
  const [request, setRequest] = useState(0);
  const last = useRef(0), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [due, setDue] = useState(0);
  useEffect(() => { setState({ files: [], truncated: false, reading: false, problem: '', readAt: 0 }); last.current = 0; }, [projectId]);
  // Changes arrive several times a second while an Agent works; the walk follows at most every 5 s.
  useEffect(() => {
    if (!projectId) return;
    const wait = Math.max(0, last.current + 5000 - Date.now());
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDue(d => d + 1), wait);
    return () => clearTimeout(timer.current);
  }, [projectId, cursor, request]);
  useEffect(() => {
    if (!projectId || !due) return;
    const abort = new AbortController();
    last.current = Date.now();
    setState(s => ({ ...s, reading: true }));
    walk(client, projectId, abort.signal).then(result => setState({ ...result, reading: false, problem: '', readAt: Date.now() }),
      error => { if (!abort.signal.aborted) setState(s => ({ ...s, reading: false, problem: error instanceof Error ? error.message : 'The project folder could not be read.' })); });
    return () => abort.abort();
  }, [client, projectId, due]);
  return { ...state, refresh: () => { last.current = 0; setRequest(r => r + 1); } };
}

// The kinds the sidebar lists, and the files of one kind in the order every place shows
// them: the project's own top level, then by folder, then by name. A registered result is listed as its newest retained
// version; a file snapshot taken only to show a file is not a result.
export type SourceRow = 'data' | 'code' | 'results' | 'notes';
export interface ResourceRef { id: string; version: string; kind: string; path: string }
export interface SourceItem { key: string; path: string; name: string; folder: string; bytes: number | null; category: SourceKind | null; resource?: ResourceRef }
interface ResourceLike { id: string; version: string; kind: string; path: string; bytes?: number; provenance?: unknown }
interface ProjectLike { root: string; name?: string; sources?: Array<{ id: string; name: string }> }
const lastSegment = (value: string) => value.split('/').filter(Boolean).at(-1) ?? value;
// A folder as the person named it: a source folder by its own name, the project root by the project's.
export function folderName(path: string, project: ProjectLike) {
  const parts = path.split('/'); parts.pop();
  if (!parts.length) return project.name ?? lastSegment(project.root);
  const source = parts[0].startsWith('@') ? project.sources?.find(entry => '@' + entry.id === parts[0]) : undefined;
  return [source ? source.name : parts[0], ...parts.slice(1)].join('/');
}
export const isResult = (resource: ResourceLike) => !['current-filesystem-observation','captured-observation'].includes((resource.provenance as { source?: string } | undefined)?.source ?? '');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// Of several versions of one result, the one its latest run made, as the Results list orders them.
export function sourceItems(row: SourceRow, files: ProjectFile[], resources: ResourceLike[], project: ProjectLike, runs: Array<{ operationId: string; acceptedAt: string }> = []): SourceItem[] {
  const items = new Map<string, SourceItem>();
  const accepted = new Map(runs.map(run => [run.operationId, run.acceptedAt]));
  const at = (resource: ResourceLike) => accepted.get(String((resource.provenance as { operationId?: unknown } | undefined)?.operationId ?? '')) ?? '';
  const newest = new Map<string, ResourceLike>();
  if (row === 'results') for (const resource of resources) {
    const kept = newest.get(resource.path);
    if (isResult(resource) && (!kept || at(resource).localeCompare(at(kept)) > 0 || (at(resource) === at(kept) && resource.version.localeCompare(kept.version) > 0))) newest.set(resource.path, resource);
  }
  for (const resource of newest.values()) items.set(resource.path, {
    key: 'result:' + resource.path, path: resource.path, name: lastSegment(resource.path), folder: folderName(resource.path, project), bytes: resource.bytes ?? null,
    category: resource.kind === 'media' ? 'figures' : 'results', resource: { id: resource.id, version: resource.version, kind: resource.kind, path: resource.path } });
  for (const file of files) {
    const match = row === 'results' ? file.category === 'figures' || file.category === 'results' : file.category === row;
    if (match && !items.has(file.path)) items.set(file.path, { key: 'file:' + file.path, path: file.path, name: file.name, folder: folderName(file.path, project), bytes: file.bytes, category: file.category });
  }
  // Files at the top of the project come first, then each folder by name.
  const nested = (item: SourceItem) => Number(item.path.includes('/'));
  return [...items.values()].sort((a, b) => nested(a) - nested(b) || collator.compare(a.folder, b.folder) || collator.compare(a.name, b.name));
}
