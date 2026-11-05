const fs = require('node:fs/promises');

async function workspace(connectionFile) {
  if (!connectionFile) throw new Error('Set the Rho agent connection file in this plugin’s configuration.');
  const file = await fs.open(connectionFile, 'r');
  let connection;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid connection file.');
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new Error('Connection file exceeds 64 KiB.');
    connection = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use a local Rho service address without credentials.');
  }
  if (typeof connection.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(connection.projectId)) {
    throw new Error('Use an agent connection scoped to a Rho project.');
  }
  url.hash = new URLSearchParams({ project: connection.projectId }).toString();
  return { url: url.href };
}

exports.name = 'dsh-rho';
exports.inject = ['connection'];
exports.workspace = workspace;
exports.apply = (ctx, config = {}) => {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-rho/workspace', methods: ['GET'], requestBody: 'buffered',
    async fetch() {
      try { return Response.json(await workspace(config.connectionFile), { headers: { 'cache-control': 'no-store' } }); }
      catch { return Response.json({ error: 'Check the Rho agent connection file in this plugin’s configuration, then try again.' }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
};
