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
    let offset = 0, data = '';
    for (;;) {
      const page = await client.call('resource.read', { projectId, resource: ref, offset }) as { data: string; more: boolean; nextOffset: number };
      data += atob(page.data);
      if (!page.more || data.length > previewLimits.figureBytes) break;
      offset = page.nextOffset;
    }
    const bytes = Uint8Array.from(data, c => c.charCodeAt(0));
    const type = /\.svg$/i.test(node.path) ? 'image/svg+xml' : /\.png$/i.test(node.path) ? 'image/png' : 'image/jpeg';
    return { kind: 'image', url: URL.createObjectURL(new Blob([bytes], { type })) };
  }).catch((): Preview => ({ kind: 'none', note: 'Preview could not be read' }));
  previews.set(key, made);
  return made;
}
