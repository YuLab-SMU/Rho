// Transport-only reconciliation: no Node filesystem, connection file or DOM.
export interface ObservationTransport<T extends { cursor: number }> {
  snapshot(signal?: AbortSignal): Promise<T>;
  events(after: number, signal?: AbortSignal): AsyncIterable<{ cursor?: number; type: string }>;
}
export const observationLimits = { maxReconnects: 8, reconnectDelayMs: 250, maxBufferedEventBytes: 65536 };
export class ObservationClient<T extends { cursor: number }> {
  limits: typeof observationLimits;
  constructor(public transport: ObservationTransport<T>, limits: Partial<typeof observationLimits> = {}) { this.limits = { ...observationLimits, ...limits }; }
  async *observe(signal?: AbortSignal): AsyncGenerator<T> {
    let reconnects = 0;
    while (!signal?.aborted) {
      try {
        let snapshot = await this.transport.snapshot(signal);
        // The budget counts failures in a row: a tab open for days reconnects after each drop.
        reconnects = 0;
        yield snapshot;
        for await (const event of this.transport.events(snapshot.cursor, signal)) {
          if (signal?.aborted) return;
          if (event.type === 'gap') break;
          if (event.cursor !== undefined && event.cursor <= snapshot.cursor) continue;
          snapshot = await this.transport.snapshot(signal); yield snapshot;
        }
      } catch (error: any) {
        if (signal?.aborted) return;
        if (error?.fatal || reconnects >= this.limits.maxReconnects) throw error;
      }
      if (reconnects++ >= this.limits.maxReconnects) throw new Error('Observation reconnect budget reached; owner state is retained. Reconnect explicitly.');
      if (this.limits.reconnectDelayMs) await new Promise(resolve => setTimeout(resolve, this.limits.reconnectDelayMs));
    }
  }
}
export function httpObservation(url: string, token: string, projectId: string, maxBufferedEventBytes = observationLimits.maxBufferedEventBytes, fetcher: typeof fetch = fetch): ObservationTransport<any> {
  const headers = { authorization: 'Bearer ' + token };
  return {
    async snapshot(signal) {
      const response = await fetcher(new URL('/api/v2/observation.snapshot', url), { method: 'POST', credentials: 'omit', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ projectId }), signal });
      const envelope: any = await response.json();
      if (!envelope.ok) throw Object.assign(new Error(envelope.error.message), { kind: envelope.error.kind, fatal: ['unauthorized', 'scope', 'origin'].includes(envelope.error.kind) });
      return envelope.value;
    },
    async *events(after, signal) {
      const response = await fetcher(new URL('/api/v2/events?' + new URLSearchParams({ projectId, after: String(after) }), url), { headers, credentials: 'omit', signal });
      if (!response.ok || !response.body) {
        const result: any = await response.json();
        throw Object.assign(new Error(result.error?.message ?? 'Observation stream unavailable.'), { kind: result.error?.kind, fatal: ['unauthorized', 'scope', 'origin'].includes(result.error?.kind) });
      }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (new TextEncoder().encode(buffer).length > maxBufferedEventBytes) throw new Error('Event buffer limit exceeded; resnapshot required.');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
            if (data) yield { ...JSON.parse(data), type: frame.split('\n').find(line => line.startsWith('event: '))?.slice(7) ?? 'invalidated' };
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  };
}
