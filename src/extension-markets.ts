import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { atomicJson, Fault, requireThat } from '@rho-workspace/plugin-contracts';

export const marketLimits = { maxMarkets: 16, maxMarketBytes: 262144, maxMarketEntries: 128, marketTimeoutMs: 10000 };
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const marketEntrySchema = object({
  id: { ...text(96), pattern: '^[a-z0-9][a-z0-9._-]{0,95}$' }, title: text(120),
  version: { ...text(64), pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$' },
  description: text(2048), source: text(1024), repository: text(2048), needs: text(2048),
  keywords: { type: 'array', items: text(64), maxItems: 16, uniqueItems: true },
}, ['id', 'title', 'version', 'description', 'source', 'repository', 'needs']);
export const marketIndexSchema = object({ apiVersion: { const: 1 }, title: text(120), plugins: { type: 'array', items: marketEntrySchema } });
export interface MarketEntry { id: string; title: string; version: string; description: string; source: string; repository: string; needs: string; keywords?: string[] }
export interface ExtensionMarket { id: string; url: string; title: string; revision: number; digest: string; fetchedAt: string; checkedAt: string; error: string | null; plugins: MarketEntry[] }
export interface MarketSelection { id: string; expectedDigest: string; pluginId: string }
export type MarketChange = { action: 'add'; url: string } | { action: 'refresh' | 'remove'; id: string; expectedRevision: number };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const validateIndex = new Ajv({ strict: false }).compile<{ apiVersion: 1; title: string; plugins: MarketEntry[] }>(marketIndexSchema);

function https(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Fault('invalid', 'Use an absolute HTTPS URL.'); }
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'invalid', 'Use HTTPS without credentials, a query or a fragment.');
  return url;
}
function indexUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Fault('invalid', 'Use an HTTPS market index URL.'); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireThat((url.protocol === 'https:' || local) && !url.username && !url.password && !url.search && !url.hash, 'invalid', 'Market indexes need HTTPS without credentials, a query or a fragment. HTTP is allowed only on localhost.');
  return url.href;
}
function validateSource(entry: MarketEntry) {
  if (entry.source.startsWith('git+https://')) {
    const match = /^git\+(https:\/\/[^#]+)#([a-f0-9]{40})(?::([^:]+))?$/.exec(entry.source);
    requireThat(match, 'invalid', 'Market Git packages must select a full 40-character commit and optional package path.');
    https(match[1]!);
    requireThat(!match[3] || (!match[3].includes('\\') && match[3].split('/').every(p => p !== '' && p !== '.' && p !== '..')), 'invalid', 'Market package paths must stay inside the Git repository.');
  } else {
    const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/.exec(entry.source);
    requireThat(match && match[2] === entry.version, 'invalid', 'Market sources need a pinned Git commit or an npm package with the exact declared version.');
  }
  https(entry.repository);
}

// A configured index is a retained observation. Listing does not fetch it, and
// its package sources are only used after a separate, local install action.
export class ExtensionMarkets {
  private values: ExtensionMarket[] = [];
  constructor(readonly directory: string, readonly limits: typeof marketLimits) {}
  async init() {
    try { this.values = JSON.parse(await fs.readFile(path.join(this.directory, 'markets.json'), 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  list() { return structuredClone(this.values); }
  private async save(values: ExtensionMarket[]) {
    await atomicJson(path.join(this.directory, 'markets.json'), values); this.values = values;
  }
  private async fetch(url: string) {
    const response = await fetch(url, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.limits.marketTimeoutMs) });
    if (!response.ok || !response.body) {
      await response.body?.cancel(); throw new Fault('unavailable', `Market index returned HTTP ${response.status}.`);
    }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      requireThat(Number(response.headers.get('content-length') ?? 0) <= this.limits.maxMarketBytes, 'limit', `Market index exceeds maxMarketBytes (${this.limits.maxMarketBytes}).`);
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        requireThat(bytes <= this.limits.maxMarketBytes, 'limit', `Market index exceeds maxMarketBytes (${this.limits.maxMarketBytes}).`);
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const raw = Buffer.concat(chunks); let index: any;
    try { index = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { throw new Fault('invalid', 'Market index is not valid UTF-8 JSON.'); }
    requireThat(validateIndex(index), 'invalid', 'Expected a Rho market index with apiVersion 1, title and plugin entries.');
    requireThat(index.plugins.length <= this.limits.maxMarketEntries, 'limit', `Market index exceeds maxMarketEntries (${this.limits.maxMarketEntries}).`);
    const seen = new Set();
    for (const entry of index.plugins as MarketEntry[]) {
      requireThat(!seen.has(entry.id), 'invalid', 'A market index must contain one selected version per plugin id.'); seen.add(entry.id);
      validateSource(entry);
    }
    return { title: index.title as string, plugins: index.plugins as MarketEntry[], digest: hash(raw) };
  }
  private async observe(url: string) {
    try { return await this.fetch(url); }
    catch (error: any) {
      if (error instanceof Fault) throw error;
      const reason = error.name === 'TimeoutError' || error.name === 'AbortError' ? `Market request exceeded marketTimeoutMs (${this.limits.marketTimeoutMs}).` : 'Could not read the market index. Check its URL and network connection; redirects are not followed.';
      throw new Fault('unavailable', reason);
    }
  }
  async change(input: MarketChange) {
    if (input.action === 'add') {
      const url = indexUrl(input.url), id = hash(url).slice(0, 24);
      if (this.values.some(m => m.id === id)) return this.list();
      requireThat(this.values.length < this.limits.maxMarkets, 'limit', `The maxMarkets limit (${this.limits.maxMarkets}) is reached. Existing indexes are retained.`);
      const index = await this.observe(url), at = new Date().toISOString();
      await this.save([...this.values, { id, url, ...index, revision: 1, fetchedAt: at, checkedAt: at, error: null }]);
    } else {
      const current = this.values.find(m => m.id === input.id);
      requireThat(current, 'not_found', 'Market source is no longer configured.');
      requireThat(current.revision === input.expectedRevision, 'stale', 'Market source changed. Refresh the list before changing it.');
      if (input.action === 'remove') await this.save(this.values.filter(m => m.id !== input.id));
      else {
        const at = new Date().toISOString(); let next: ExtensionMarket;
        try { next = { ...current, ...await this.observe(current.url), revision: current.revision + 1, fetchedAt: at, checkedAt: at, error: null }; }
        catch (error: any) {
          next = { ...current, revision: current.revision + 1, checkedAt: at, error: String(error.message).slice(0, 400) };
        }
        await this.save(this.values.map(m => m.id === input.id ? next : m));
      }
    }
    return this.list();
  }
  select(selection: MarketSelection, source: string) {
    const market = this.values.find(m => m.id === selection.id);
    requireThat(market && market.digest === selection.expectedDigest, 'stale', 'Market index changed or was removed. Refresh the list before installing.');
    const entry = market.plugins.find(p => p.id === selection.pluginId);
    requireThat(entry && entry.source === source, 'conflict', 'Selected package source does not match the retained market index.');
    return { entry: structuredClone(entry), origin: { id: market.id, title: market.title, url: market.url, digest: market.digest, keywords: [...(entry.keywords ?? [])] } };
  }
}
