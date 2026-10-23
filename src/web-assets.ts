import * as fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { confined, Fault, requireThat } from '@rho-workspace/plugin-contracts';

export const webRoot = fileURLToPath(new URL('./web/', import.meta.url));
// Installed entries are build facts. Visibility still requires browser evidence.
export async function installedWebEntries(root = webRoot) {
  try {
    await fs.access(await confined(root, 'index.html'));
    const file = await confined(root, 'composition.json');
    requireThat((await fs.stat(file)).size <= 1024 * 1024, 'limit', 'Browser manifest exceeds its 1 MiB budget.');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    requireThat(manifest.format === 'rho.web-build/1' && Array.isArray(manifest.ownerEntries) && manifest.ownerEntries.length <= 128, 'condition', 'Invalid browser build manifest.');
    return manifest.ownerEntries as { plugin: string; component: string; version: string; packageVersion: string }[];
  } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
}
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
export async function serveWeb(pathname: string, response: ServerResponse, root = webRoot, head = false) {
  requireThat(pathname === '/' || pathname === '/index.html' || /^\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(js|css|woff2|svg)$/.test(pathname), 'not_found', 'Static asset is not in the browser build.');
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  let file: string;
  try { file = await confined(root, relative); }
  catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    if (relative !== 'index.html') throw new Fault('not_found', 'Static asset is not in the browser build.');
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(head ? undefined : 'The browser build is unavailable. Run npm run build:web or install an assembled Rho package.'); return;
  }
  const stat = await fs.stat(file);
  requireThat(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'limit', 'Static asset exceeds the 16 MiB file budget.');
  const bytes = head ? undefined : await fs.readFile(file);
  requireThat(!bytes || bytes.length <= 16 * 1024 * 1024, 'limit', 'Static asset exceeds the 16 MiB file budget.');
  const extension = relative.slice(relative.lastIndexOf('.'));
  response.writeHead(200, { 'content-type': types[extension]!, 'content-length': bytes?.length ?? stat.size });
  response.end(bytes);
}
