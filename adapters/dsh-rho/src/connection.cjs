const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const limits = { connectionBytes: 65536, responseBytes: 4194304, probeMs: 5000, connections: 16 };
class ConnectionError extends Error {
  constructor(message, details = {}) { super(message); this.details = details; }
}

async function readConnection(connectionFile) {
  if (typeof connectionFile !== 'string' || !path.isAbsolute(connectionFile)) {
    throw new ConnectionError('Set an absolute Rho agent connection file in the Rho plugin configuration.');
  }
  const file = await fs.open(connectionFile, 'r');
  let connection;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limits.connectionBytes) throw new ConnectionError('Invalid Rho connection file (maximum 64 KiB).');
    const bytes = Buffer.alloc(limits.connectionBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limits.connectionBytes) throw new ConnectionError('Rho connection file exceeds 64 KiB.');
    connection = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ConnectionError('Use a local Rho service address without credentials in the URL.');
  }
  if (typeof connection.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(connection.projectId)
    || typeof connection.token !== 'string' || !connection.token) {
    throw new ConnectionError('Use an agent connection scoped to a Rho project.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(connection)).digest('hex');
  return { connectionFile, connection, fingerprint };
}

async function projectConnection(connectionFile) {
  const record = await readConnection(connectionFile);
  const { connection } = record;
  const response = await fetch(new URL('/api/v2/observation.snapshot', connection.url), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(limits.probeMs),
    headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: connection.projectId }),
  });
  const reader = response.body.getReader();
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limits.responseBytes) throw new ConnectionError('Rho project information exceeds 4 MiB.');
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!response.ok || !body.ok) throw new ConnectionError('Rho could not verify this project grant. Check the connection and try again.');
  const project = body.value?.project;
  if (!project || project.id !== connection.projectId || typeof project.root !== 'string' || !path.isAbsolute(project.root)) {
    throw new ConnectionError('The configured Rho project is unavailable.');
  }
  const root = await fs.realpath(project.root);
  const url = new URL(connection.url);
  url.hash = new URLSearchParams({ project: project.id }).toString();
  return { ...record, root, project: { id: project.id, name: project.name || path.basename(root), root, url: url.href } };
}

function connectionFiles(config) {
  const files = [...new Set([...(config.connectionFile ? [config.connectionFile] : []), ...(config.connectionFiles || [])])];
  if (!files.length) throw new ConnectionError('Add this project’s Rho agent connection file to the Rho plugin configuration.');
  if (files.length > limits.connections) throw new ConnectionError('Configure at most 16 Rho project connections.');
  return files;
}

async function resolveWorkspace(config, cwd) {
  if (!cwd) throw new ConnectionError('Open a Harness conversation in the project you want to use.');
  const root = await fs.realpath(cwd);
  const results = await Promise.allSettled(connectionFiles(config).map(projectConnection));
  const connections = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const matches = connections.filter(value => value.root === root);
  if (matches.length !== 1) {
    const message = matches.length > 1
      ? 'More than one Rho connection matches this project. Keep one connection for this folder in the Rho plugin configuration.'
      : 'This conversation’s project is not connected to Rho. Add its agent connection file to the Rho plugin configuration, then reconnect.';
    throw new ConnectionError(message, { conversationRoot: root, projects: connections.map(value => value.project), unavailable: results.length - connections.length });
  }
  return matches[0];
}

function publicError(error) {
  return error instanceof ConnectionError ? { error: error.message, ...error.details }
    : { error: 'Could not verify the Rho connection. Check the agent connection file and that its Rho service is running, then try again.' };
}

module.exports = { limits, ConnectionError, readConnection, projectConnection, connectionFiles, resolveWorkspace, publicError };
