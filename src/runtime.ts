import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { Fault, requireThat } from '@rho-workspace/plugin-contracts';
export async function executable(name: string, selected?: string) {
  // A Windows program is a file with its extension (Rscript.exe, rho-core.exe), and what the
  // person names may leave it out.
  const named = (file: string) => process.platform === 'win32' && !path.extname(file) ? [file + '.exe'] : [file];
  const candidates = selected ? named(path.resolve(selected)) : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(p => named(path.join(p, name)));
  for (const file of candidates) {
    try { await fs.access(file, constants.X_OK); return await fs.realpath(file); } catch {}
  }
  requireThat(false, 'unavailable', 'Required executable is unavailable. Select its absolute path.', { executable: name });
}
export async function runtime(core?: string, rscript?: string) {
  let bundled: string | undefined;
  if (!core && !process.env.RHO_CORE_BINARY) {
    try {
      const manifest = JSON.parse(await fs.readFile(new URL('../vendor/composition.json', import.meta.url), 'utf8'));
      // A package carries one Core per platform, each under vendor/core/PLATFORM/.
      const platform = process.platform + '-' + process.arch, packed = manifest.core?.artifacts ?? {};
      const artifact = Object.hasOwn(packed, platform) ? packed[platform] : undefined;
      requireThat(artifact, 'condition', `This installation has no Core for ${platform}; it carries ${Object.keys(packed).join(', ') || 'none'}. Select a Core with --core ABSOLUTE_PATH or RHO_CORE_BINARY.`, { platform, packed: Object.keys(packed) });
      requireThat(typeof artifact.path === 'string' && artifact.path === 'vendor/core/' + platform + '/' + path.posix.basename(artifact.path), 'condition', 'Installed Core artifact path is invalid.');
      const p = fileURLToPath(new URL('../' + artifact.path, import.meta.url));
      const { digest } = await import('@rho-workspace/plugin-contracts');
      requireThat(digest(await fs.readFile(p)) === artifact.sha256, 'condition', 'Installed Core artifact digest failed verification.');
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
  // Core is optional for native Agent work. An explicitly selected or bundled
  // artifact must still be valid; absence from PATH does not block the workspace.
  const chosen = core ?? process.env.RHO_CORE_BINARY ?? bundled;
  let coreBinary: string | undefined;
  try { coreBinary = await executable('rho-core', chosen); }
  catch (e) {
    if (!(e instanceof Fault && e.kind === 'unavailable')) throw e;
    if (!chosen) return { coreBinary: undefined, rscript: selectedRscript };
    requireThat(false, 'unavailable', 'The Core binary is unavailable. Select it with --core ABSOLUTE_PATH or RHO_CORE_BINARY; a packed install supplies vendor/core/PLATFORM/rho-core, and a source checkout does not.', { executable: 'rho-core', remedy: '--core, RHO_CORE_BINARY or the packaged vendor/core/PLATFORM/rho-core' });
  }
  return { coreBinary, rscript: selectedRscript };
}
