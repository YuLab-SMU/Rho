import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, requireThat } from '@rho-workspace/plugin-contracts';
export type Envelope<T> = { apiVersion: '1.0' | '2.0'; ok: true; value: T } | { apiVersion: '1.0' | '2.0'; ok: false; error: { kind: string; message: string; details: Record<string, unknown>; continuation: string } };
export interface Connection { url: string; token: string; projectId?: string; methods?: string[]; apiVersion?: '1.0' | '2.0' }
export class ApiError extends Error {
  constructor(public error: { kind: string; message: string; details: Record<string, unknown>; continuation: string }) { super(error.message); }
}
export class RhoClient {
  constructor(public connection: Connection) {}
  static async fromFile(file: string) { return new RhoClient(JSON.parse(await fs.readFile(file, 'utf8'))); }
  async envelope<T = any>(method: string, input: Record<string, unknown> = {}): Promise<Envelope<T>> {
    const response = await fetch(new URL('/api/v' + (this.connection.apiVersion ?? '2.0').split('.')[0] + '/' + method, this.connection.url), { method: 'POST', headers: { authorization: 'Bearer ' + this.connection.token, 'content-type': 'application/json' }, body: JSON.stringify({ ...(this.connection.projectId ? { projectId: this.connection.projectId } : {}), ...input }), signal: AbortSignal.timeout(30000) });
    return await response.json() as Envelope<T>;
  }
  async call<T = any>(method: string, input: Record<string, unknown> = {}): Promise<T> {
    const result = await this.envelope<T>(method, input);
    if (!result.ok) throw new ApiError(result.error);
    return result.value;
  }
  async events(projectId: string, after: number, signal?: AbortSignal) {
    const url = new URL('/api/v' + (this.connection.apiVersion ?? '2.0').split('.')[0] + '/events', this.connection.url);
    url.searchParams.set('projectId', projectId); url.searchParams.set('after', String(after));
    const response = await fetch(url, { headers: { authorization: 'Bearer ' + this.connection.token }, signal });
    if (!response.ok) { const body = await response.json() as any; throw new ApiError(body.error); }
    return response.body!; // Consumer cancels the reader to release observation.
  }
  // Caller retains identity AND exact input before any network send. Lost replies
  // leave this file available for lookup/retry after a caller or service crash.
  async retainOperation(file: string, input: Record<string, unknown>) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    const h = await fs.open(temporary, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify({ ...input, operationId: randomUUID() }) + '\n'); await h.sync(); } finally { await h.close(); }
    try {
      try { await fs.link(temporary, file); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
      const retained = JSON.parse(await fs.readFile(file, 'utf8'));
      const { operationId, ...content } = retained;
      requireThat(canonical(content) === canonical(input), 'conflict', 'Retained caller intent already contains different input; reconcile the original operation.');
      const d = await fs.open(path.dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); }
      return retained;
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
