import { canonical, digest, requireThat } from '@rho-workspace/plugin-contracts';

export function schemaClosure(schemas: any[], available: Record<string, any>) {
  const definitions: Record<string, any> = {};
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      requireThat(/^#\/definitions\/[^/]+$/.test(value.$ref), 'condition', 'Contract needs an unsupported external schema reference.');
      const name = value.$ref.split('/').at(-1);
      if (!Object.hasOwn(definitions, name)) {
        requireThat(Object.hasOwn(available, name), 'condition', 'Contract schema dependency is unavailable.');
        Object.defineProperty(definitions, name, { value: structuredClone(available[name]), enumerable: true });
        visit(definitions[name]);
      }
    }
    Object.values(value).forEach(visit);
  };
  schemas.forEach(visit); return definitions;
}

// The complete protocol remains an offline export. Runtime inspection selects
// one contract or a small page of methods within the caller's existing grant.
export function describeProtocol(protocol: any, methods: string[], input: any) {
  const maxBytes = input.maxBytes ?? 16384;
  const names = Object.keys(protocol.operations).filter(m => methods.includes(m)).sort();
  const revision = digest(canonical([protocol, names]));
  const result: any = { apiVersion: protocol.apiVersion, schemaVersion: protocol.schemaVersion, revision, entries: [], next: null, complete: true };
  if (input.method) {
    requireThat(names.includes(input.method), 'scope', 'This operation is not available to this caller.');
    const inputSchema = protocol.operations[input.method], outputSchema = protocol.responses[input.method];
    result.contract = { method: input.method, inputSchema, outputSchema, definitions: schemaClosure([inputSchema, outputSchema], protocol.definitions), description: protocol.descriptions[input.method] ?? input.method };
  } else {
    let offset = 0;
    if (input.cursor) {
      const [at, pin] = input.cursor.split(':');
      requireThat(pin === revision && /^\d+$/.test(at), 'stale', 'Protocol or authorization changed. Start a new index.');
      offset = Number(at);
    }
    requireThat(offset <= names.length, 'invalid', 'Invalid protocol cursor.');
    for (const method of names.slice(offset, offset + (input.limit ?? 20))) {
      const entry = { method, summary: Array.from(protocol.descriptions[method] ?? method).slice(0, 240).join('') };
      const trial = { ...result, entries: [...result.entries, entry], next: (offset + result.entries.length + 1) + ':' + revision, complete: false };
      if (Buffer.byteLength(JSON.stringify(trial)) + 64 > maxBytes) break;
      result.entries.push(entry);
    }
    result.complete = offset + result.entries.length === names.length;
    if (!result.complete) result.next = (offset + result.entries.length) + ':' + revision;
    requireThat(result.complete || result.entries.length > 0, 'limit', 'A protocol index entry does not fit this page.');
  }
  const requiredBytes = Buffer.byteLength(JSON.stringify(result)) + 64;
  requireThat(requiredBytes <= maxBytes, 'limit', 'The complete selected contract does not fit this response.', { limit: 'maxBytes', requiredBytes, maximum: maxBytes });
  return result;
}
