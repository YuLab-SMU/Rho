import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import { canCapture } from './canvas.js';
import { size } from './project.js';

// A file as it is now: its path in the project, and the size and time that tell a new version;
// or a registered result, read as exactly its version.
export interface PreviewFile { path: string; bytes?: number | null; modifiedAt?: string | null; resource?: { id: string; version: string; kind: string } }
// Graph cards and the Overview preview a table's first rows and a figure's pixels. The protected resource is the
// service and the browser: at most this many previews per page, read one or two at a time,
// each figure within this many bytes; past a limit the card simply has no preview.
export const previewLimits = { files: 16, concurrent: 2, figureBytes: 2 * 1024 * 1024, rows: 3, columns: 4 };

// A table's first rows or a figure's pixels for a card, read once per file version.
export type Preview = { kind: 'table'; columns: string[]; rows: Array<Record<string, unknown>>; total: number; width: number } | { kind: 'image'; url: string } | { kind: 'none'; note: string };
const previews = new Map<string, Promise<Preview>>();
let started = 0, active = 0;
const waiting: Array<() => void> = [];
async function slot<T>(run: () => Promise<T>) {
  if (active >= previewLimits.concurrent) await new Promise<void>(resolve => waiting.push(resolve));
  active++;
  try { return await run(); } finally { active--; waiting.shift()?.(); }
}
export function readPreview(client: BrowserClient, snapshot: WorkspaceSnapshot, node: PreviewFile): Promise<Preview> {
  const key = snapshot.project.id + ':' + node.path + ':' + (node.resource ? node.resource.id + '@' + node.resource.version : node.bytes + ':' + node.modifiedAt);
  const known = previews.get(key);
  if (known) return known;
  if (!node.resource && !canCapture(snapshot)) return Promise.resolve({ kind: 'none', note: 'No preview in this build' });
  if (started >= previewLimits.files) return Promise.resolve({ kind: 'none', note: 'Select it to see it' });
  started++;
  const made = slot(async (): Promise<Preview> => {
    const projectId = snapshot.project.id;
    const resource = node.resource ?? await client.call('agent.activity.capture', { projectId, path: node.path });
    const ref = { id: resource.id, version: resource.version };
    if (resource.kind === 'table') {
      const page = await client.call('data.page', { projectId, resource: ref, offset: 0, limit: previewLimits.rows } as never) as { columns: Array<{ name: string }>; rows: Array<Record<string, unknown>>; total: number };
      return { kind: 'table', columns: page.columns.slice(0, previewLimits.columns).map(c => c.name), rows: page.rows, total: page.total, width: page.columns.length };
    }
    if ((node.bytes ?? 0) > previewLimits.figureBytes) return { kind: 'none', note: size(node.bytes ?? 0) + ' · select it to see it' };
    const bytes = await readBytes(client, projectId, ref, previewLimits.figureBytes);
    const type = /\.svg$/i.test(node.path) ? 'image/svg+xml' : /\.png$/i.test(node.path) ? 'image/png' : 'image/jpeg';
    return { kind: 'image', url: URL.createObjectURL(new Blob([bytes], { type })) };
  }).catch((): Preview => ({ kind: 'none', note: 'Preview could not be read' }));
  previews.set(key, made);
  return made;
}
// The answer board reads more of a table than a card does, and a script's text for its outline.
// Same protected resources as previews: at most this many rows, columns and bytes per item,
// each read once per exact version.
export const boardReadLimits = { rows: 12, columns: 8, textBytes: 256 * 1024 };
export type TablePage = { columns: string[]; rows: Array<Record<string, unknown>>; total: number; width: number };
const reads = new Map<string, Promise<unknown>>();
async function exactRef(client: BrowserClient, snapshot: WorkspaceSnapshot, file: PreviewFile) {
  return file.resource ?? await client.call('agent.activity.capture', { projectId: snapshot.project.id, path: file.path });
}
const readKey = (snapshot: WorkspaceSnapshot, file: PreviewFile, what: string) => what + ':' + snapshot.project.id + ':' + file.path + ':' + (file.resource ? file.resource.id + '@' + file.resource.version : file.bytes + ':' + file.modifiedAt);
export function readTable(client: BrowserClient, snapshot: WorkspaceSnapshot, file: PreviewFile, rows = boardReadLimits.rows): Promise<TablePage | null> {
  const key = readKey(snapshot, file, 'table' + rows);
  if (!reads.has(key)) reads.set(key, slot(async () => {
    const resource = await exactRef(client, snapshot, file);
    if (resource.kind !== 'table') return null;
    const page = await client.call('data.page', { projectId: snapshot.project.id, resource: { id: resource.id, version: resource.version }, offset: 0, limit: Math.min(rows, boardReadLimits.rows) } as never) as { columns: Array<{ name: string }>; rows: Array<Record<string, unknown>>; total: number };
    return { columns: page.columns.slice(0, boardReadLimits.columns).map(c => c.name), rows: page.rows, total: page.total, width: page.columns.length };
  }).catch(() => null));
  return reads.get(key) as Promise<TablePage | null>;
}
export function readText(client: BrowserClient, snapshot: WorkspaceSnapshot, file: PreviewFile): Promise<{ text: string; cut: boolean } | null> {
  const key = readKey(snapshot, file, 'text');
  if (!reads.has(key)) reads.set(key, slot(async () => {
    const resource = await exactRef(client, snapshot, file);
    const bytes = await readBytes(client, snapshot.project.id, { id: resource.id, version: resource.version }, boardReadLimits.textBytes);
    const cut = bytes.length > boardReadLimits.textBytes;
    return { text: new TextDecoder().decode(cut ? bytes.slice(0, boardReadLimits.textBytes) : bytes), cut };
  }).catch(() => null));
  return reads.get(key) as Promise<{ text: string; cut: boolean } | null>;
}
// A resource's bytes, read page by page and stopped once past maxBytes.
export async function readBytes(client: BrowserClient, projectId: string, resource: { id: string; version: string }, maxBytes: number) {
  let offset = 0, data = '';
  for (;;) {
    const page = await client.call('resource.read', { projectId, resource, offset }) as { data: string; more: boolean; nextOffset: number };
    data += atob(page.data);
    if (!page.more || data.length > maxBytes) break;
    offset = page.nextOffset;
  }
  return Uint8Array.from(data, c => c.charCodeAt(0));
}

// A project file a page names (a stylesheet, a script, a font), as its current bytes, read once
// per file version as a file snapshot. The protected resource is the service: at most this many
// files are kept per tab, each within the page's own limit; past either the page shows without it.
export const fileLimits = { files: 256 };
const fileReads = new Map<string, Promise<Uint8Array | null>>();
export function readFile(client: BrowserClient, snapshot: WorkspaceSnapshot, file: PreviewFile, maxBytes: number): Promise<Uint8Array | null> {
  const allowed = (method: string) => snapshot.catalog.operations.some(o => o.method === method && o.authorized && o.state === 'available');
  if (!allowed('resource.capture') || !allowed('resource.read') || (file.bytes ?? 0) > maxBytes) return Promise.resolve(null);
  const projectId = snapshot.project.id, key = projectId + ':' + file.path + ':' + file.bytes + ':' + file.modifiedAt;
  const known = fileReads.get(key);
  if (known) return known;
  if (fileReads.size >= fileLimits.files) return Promise.resolve(null);
  const made = slot(async () => {
    const resource = await client.call('resource.capture', { projectId, path: file.path, declaration: { path: file.path, kind: 'file', format: { mimeType: 'application/octet-stream' } } } as never) as { id: string; version: string };
    const bytes = await readBytes(client, projectId, { id: resource.id, version: resource.version }, maxBytes);
    return bytes.length > maxBytes ? null : bytes;
  });
  fileReads.set(key, made);
  made.catch(() => fileReads.delete(key));
  return made;
}

// Images a rendered document shows, each as its current bytes, read once per file version.
// The protected resources are the service and the tab: at most this many images per page,
// each within this many bytes; past either the document shows the image's description.
export const imageLimits = { images: 64, bytes: 8 * 1024 * 1024 };
const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };
const images = new Map<string, Promise<string | null>>();
export function readImage(client: BrowserClient, snapshot: WorkspaceSnapshot, file: PreviewFile): Promise<string | null> {
  const type = imageTypes[file.path.split('.').at(-1)!.toLowerCase()];
  if (!type || !canCapture(snapshot) || (file.bytes ?? 0) > imageLimits.bytes) return Promise.resolve(null);
  const projectId = snapshot.project.id, key = projectId + ':' + file.path + ':' + file.bytes + ':' + file.modifiedAt;
  const known = images.get(key);
  if (known) return known;
  if (images.size >= imageLimits.images) return Promise.resolve(null);
  const made = slot(async () => {
    const resource = await client.call('agent.activity.capture', { projectId, path: file.path });
    const bytes = await readBytes(client, projectId, { id: resource.id, version: resource.version }, imageLimits.bytes);
    return bytes.length > imageLimits.bytes ? null : URL.createObjectURL(new Blob([bytes], { type }));
  });
  images.set(key, made);
  made.catch(() => images.delete(key));
  return made;
}
