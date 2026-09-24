import { PluginDownloads } from '../../src/plugin-download';
const source = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text x="8" y="40">Original α 中文</text></svg>');
const digest = 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', source)), byte => byte.toString(16).padStart(2, '0')).join('');
const reference = { owner: { instance: 'fixture', plugin: 'example.plot', revision: 'sha256:' + 'a'.repeat(64), artifact: 'sha256:' + 'b'.repeat(64) }, resource: 'original', media_type: 'image/svg+xml', bytes: source.length, digest };
const status = document.createElement('output'); status.setAttribute('role', 'status');
for (const corrupted of [false, true]) {
  const button = document.createElement('button'); button.textContent = corrupted ? 'Try corrupted original' : 'Export original';
  button.onclick = async () => {
    const downloads = new PluginDownloads(async (ref, offset, limit) => {
      const bytes = source.slice(offset, offset + limit); if (corrupted) bytes[0] ^= 1;
      return { status: 'ready', data: { reference: ref, offset, base64: btoa(String.fromCharCode(...bytes)), next: offset + bytes.length < source.length ? offset + bytes.length : null } };
    });
    try { await downloads.start(reference, '原图 α.svg'); status.textContent = 'Download requested'; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { downloads.dispose(); }
  };
  document.body.append(button);
}
document.body.append(status);
