import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PluginDescriptor } from '@rho-workspace/plugin-contracts';

// What the installed package itself records, beside the owner's declaration: its
// exact version and the command-line entries npm links for it. Read, not declared,
// so a package that ships no commands lists none.
export async function packageFacts(packageName: string): Promise<{ version?: string; cli: string[] }> {
  try {
    let directory = path.dirname(fileURLToPath(import.meta.resolve(packageName)));
    for (let depth = 0; depth < 4; depth++, directory = path.dirname(directory)) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
        if (pkg.name !== packageName) continue;
        const bin = typeof pkg.bin === 'string' ? { [packageName.split('/').at(-1)!]: pkg.bin } : pkg.bin ?? {};
        return { version: typeof pkg.version === 'string' ? pkg.version : undefined, cli: Object.keys(bin).filter(name => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)).slice(0, 16) };
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
  } catch {}
  return { cli: [] };
}

// One descriptive projection for the live catalog and the retained build copy.
// It contains no Skill text, executable module or grant. Reduced installations
// can still explain the entries of an owner that is not loaded.
export function pluginListing(plugin: PluginDescriptor, facts: { cli?: string[] } = {}) {
  const native = (plugin as PluginDescriptor & { claudeCode?: {
    skills?: { skill: string; name: string; description: string }[];
    hooks?: { id?: string; event: string; matcher: string; entry: string; timeoutSeconds?: number }[];
  } }).claudeCode;
  return {
    operations: plugin.operations.map(({ method, version, effect, requires, presentation }) => ({ method, version, effect, requires, presentation })),
    actions: (plugin.actions ?? []).map(({ id, version, requires, presentation }) => ({ id, version, requires, presentation })),
    views: (plugin.components ?? []).map(({ id, version, ui, bindings, presentation }) => ({ id, version, ui, bindings, presentation })),
    skills: plugin.skills.map(({ content, ...skill }) => skill),
    ...(facts.cli?.length ? { cli: facts.cli } : {}),
    ...(native ? { claudeCode: native } : {}),
    ...(plugin.agent?.mcp ? { mcp: plugin.agent.mcp } : {}),
  };
}
