import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { Fault, requireThat } from '@rho-workspace/plugin-contracts';
export async function executable(name: string, selected?: string) {
  const candidates = selected ? [path.resolve(selected)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(p => path.join(p, name));
  for (const file of candidates) {
    try { await fs.access(file, constants.X_OK); return await fs.realpath(file); } catch {}
  }
  requireThat(false, 'unavailable', 'Required executable is unavailable. Select its absolute path.', { executable: name });
}
export async function runtime(core?: string, rscript?: string) {
  let bundled: string | undefined;
  if (!core && !process.env.RHO_CORE_BINARY) {
    const p = fileURLToPath(new URL('../vendor/rho-core', import.meta.url));
    try {
      const manifest = JSON.parse(await fs.readFile(new URL('../vendor/composition.json', import.meta.url), 'utf8'));
      requireThat(manifest.platform === process.platform + '-' + process.arch, 'condition', 'Installed Core artifact does not match this platform.');
      const { digest } = await import('@rho-workspace/plugin-contracts');
      requireThat(digest(await fs.readFile(p)) === manifest.core.artifactSha256, 'condition', 'Installed Core artifact digest failed verification.');
      bundled = p;
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  const selection = rscript ?? process.env.RHO_RSCRIPT;
  let selectedRscript: string;
  try { selectedRscript = await executable('Rscript', selection); }
  catch (e) {
    if (!(e instanceof Fault && e.kind === 'unavailable')) throw e;
    // The service and document APIs remain usable without scientific R. The
    // selected action probe reports unknown; it must not start a Host.
    selectedRscript = selection ? path.resolve(selection) : 'Rscript';
  }
  return { coreBinary: await executable('rho-core', core ?? process.env.RHO_CORE_BINARY ?? bundled), rscript: selectedRscript };
}
