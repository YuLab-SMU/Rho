import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, requireThat } from '@rho-workspace/plugin-contracts';
import type { RhoInput, RhoMethod, RhoOutput } from './contract.generated.js';
import type { RhoOperationError } from './contract.generated.js';

// The envelope is the wire form of the contract: an accepted value of the method's
// declared output type, or the published error object. There is no caller-chosen
// type parameter: `call('document.read', ...)` returns exactly what the contract
// says that operation returns.
export type Envelope<M extends RhoMethod> = { apiVersion: '2.0'; ok: true; value: RhoOutput<M> } | { apiVersion: '2.0'; ok: false; error: RhoOperationError };
export interface Connection { url: string; token: string; projectId?: string; methods?: string[]; apiVersion?: '2.0' }
export class ApiError extends Error {
  constructor(public error: RhoOperationError) { super(error.message); }
}
// A method whose input has no required field may be called without a body.
type CallArguments<M extends RhoMethod> = RhoInput<M> extends Record<string, never> ? [input?: RhoInput<M>] : [input: RhoInput<M>];
export class RhoClient {
  constructor(public connection: Connection) {}
  static async fromFile(file: string) { return new RhoClient(JSON.parse(await fs.readFile(file, 'utf8'))); }
  async envelope<M extends RhoMethod>(method: M, ...args: CallArguments<M>): Promise<Envelope<M>> {
    const input = (args[0] ?? {}) as Record<string, unknown>;
    const response = await fetch(new URL('/api/v2/' + method, this.connection.url), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + this.connection.token, 'content-type': 'application/json' },
      body: JSON.stringify({ ...(this.connection.projectId ? { projectId: this.connection.projectId } : {}), ...input }),
      signal: AbortSignal.timeout(30000)
    });
    return await response.json() as Envelope<M>;
  }
  async call<M extends RhoMethod>(method: M, ...args: CallArguments<M>): Promise<RhoOutput<M>> {
    const result = await this.envelope(method, ...args);
    if (!result.ok) throw new ApiError(result.error);
    return result.value;
  }
  async events(projectId: string, after: number, signal?: AbortSignal) {
    const url = new URL('/api/v2/events', this.connection.url);
    url.searchParams.set('projectId', projectId); url.searchParams.set('after', String(after));
    const response = await fetch(url, { headers: { authorization: 'Bearer ' + this.connection.token }, signal });
    if (!response.ok) { const body = await response.json() as { error: RhoOperationError }; throw new ApiError(body.error); }
    return response.body!; // Consumer cancels the reader to release observation.
  }
  // Caller retains identity AND exact input before any network send. Lost replies
  // leave this file available for lookup/retry after a caller or service crash.
  async retainOperation(file: string, input: Record<string, unknown>) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    const h = await fs.open(temporary, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify({ ...input, operationId: randomUUID() }) + '\n'); await h.sync(); } finally { await h.close(); }
    try {
      try { await fs.link(temporary, file); } catch (e: unknown) { if ((e as { code?: string }).code !== 'EEXIST') throw e; }
      const retained = JSON.parse(await fs.readFile(file, 'utf8'));
      const { operationId, ...content } = retained;
      requireThat(canonical(content) === canonical(input), 'conflict', 'Retained caller intent already contains different input; reconcile the original operation.');
      const d = await fs.open(path.dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); }
      return retained as Record<string, unknown> & { operationId: string };
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
