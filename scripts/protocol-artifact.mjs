import { createHash } from 'node:crypto';

// Each operation is independently readable and verifiable. The root artifact is
// a directory of references, not an expanded copy of every request and response.
export function protocolArtifacts(protocol) {
  const files = new Map();
  const put = (path, value) => {
    const body = JSON.stringify(value, null, 2) + '\n'; files.set(path, body);
    return { path, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
  };
  const { operations, responses, descriptions, ...shared } = protocol;
  const index = { format: 'rho.protocol-index/1', apiVersion: protocol.apiVersion, schemaVersion: protocol.schemaVersion,
    shared: put('v2/shared.json', shared), operations: {} };
  for (const method of Object.keys(operations).sort()) index.operations[method] = {
    summary: descriptions[method] ?? method,
    ...put('v2/' + method + '.json', { method, inputSchema: operations[method], outputSchema: responses[method], description: descriptions[method] ?? null })
  };
  files.set('v2.json', JSON.stringify(index, null, 2) + '\n');
  return files;
}
