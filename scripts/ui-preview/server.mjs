import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readUiPackage } from '../ui-selection.mjs';
const root = fileURLToPath(new URL('./', import.meta.url));
export async function preview(directory, { port = 5174 } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Choose a valid preview port.');
  const entry = readUiPackage(directory, { development: true });
  const require = createRequire(path.join(entry.directory, 'package.json'));
  const { createServer } = await import(require.resolve('vite'));
  const deps = Object.fromEntries(['react', 'react-dom', 'scheduler'].map(name => [name, path.dirname(require.resolve(name + '/package.json'))]));
  const fixture = path.join(entry.directory, 'preview.json');
  if (!fs.existsSync(fixture)) throw new Error('Add preview.json with props, bindings, documents and responses.');
  const server = await createServer({ configFile: false, root, base: '/', cacheDir: path.join(entry.directory, 'node_modules/.vite-rho-preview'),
    plugins: [{ name: 'rho-plugin-preview',
      resolveId(id) { if (id === 'virtual:rho-preview') return '\0' + id; },
      load(id) { if (id === '\0virtual:rho-preview') return `export { ${entry.extension.export} as View } from ${JSON.stringify(entry.source)};\nexport { default as fixture } from ${JSON.stringify(fixture)};\nexport const manifest = ${JSON.stringify(entry.extension)};`; },
    }],
    resolve: { alias: { ...deps, 'rho-preview-theme': fileURLToPath(new URL('../../web/theme.css', import.meta.url)) }, dedupe: ['react', 'react-dom'] },
    oxc: { jsx: { runtime: 'automatic' } },
    server: { host: '127.0.0.1', port, strictPort: true, cors: false, fs: { strict: true, allow: [root, entry.directory, ...Object.values(deps), fileURLToPath(new URL('../../web/theme.css', import.meta.url))], deny: ['.env', '.env.*', '**/.git/**', '**/.rho/**', '**/.service/**', '**/*.pem', '**/*.key'] } },
  });
  await server.listen();
  const address = server.httpServer.address();
  console.log(JSON.stringify({ preview: `http://127.0.0.1:${address.port}`, component: entry.component, data: 'fixtures-only' }));
  const close = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return server;
}
