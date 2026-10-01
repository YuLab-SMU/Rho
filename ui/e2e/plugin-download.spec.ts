/** Actual browser download behavior only; view-scoped admission has separate
 * Host/container checks. This fixture cannot establish that an SDK grant exists. */
import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { build } from 'vite';
let directory: string, origin: string, server: Server;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'rho-download-browser-'));
  await build({ configFile: false, root: resolve('.'), build: { target: 'es2022', outDir: directory, emptyOutDir: true,
    lib: { entry: resolve('e2e/fixtures/plugin-download.ts'), formats: ['es'], fileName: 'fixture' }, minify: false }, logLevel: 'error' });
  const files = readdirSync(directory), script = files.find(name => name.endsWith('.js'))!;
  server = createServer((request, response) => {
    const name = new URL(request.url!, 'http://localhost').pathname.slice(1);
    if (!name) { response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Original download fixture</title><body><script type="module" src="/${script}"></script></body></html>`); return; }
    if (!files.includes(name)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(join(directory, name)));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(done => server.close(() => done())); if (directory) rmSync(directory, { recursive: true, force: true }); });
test('browser requests the exact original with a Unicode filename and refuses corrupted bytes', async ({ page }, info) => {
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.goto(origin);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export original', exact: true }).click();
  const download = await pending; expect(download.suggestedFilename()).toBe('原图 α.svg');
  await download.saveAs(info.outputPath('downloaded-original.svg')); expect(await download.failure()).toBeNull();
  const original = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text x="8" y="40">Original α 中文</text></svg>');
  const actual = readFileSync(info.outputPath('downloaded-original.svg')); expect(actual).toEqual(original);
  expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
  await expect(page.getByRole('status')).toHaveText('Download requested');
  await page.getByRole('button', { name: 'Try corrupted original', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('The original download failed its checksum.');
  expect(downloads).toEqual(['原图 α.svg']); expect(page.url()).toBe(origin + '/');
});
