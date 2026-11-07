import type { PluginDescriptor } from '@rho-workspace/plugin-contracts';

// One descriptive projection for the live catalog and the retained build copy.
// It contains no Skill text, executable module or grant. Reduced installations
// can still explain the entries of an owner that is not loaded.
export function pluginListing(plugin: PluginDescriptor) {
  const native = (plugin as PluginDescriptor & { claudeCode?: {
    skills?: { skill: string; name: string; description: string }[];
    hooks?: { id?: string; event: string; matcher: string; entry: string; timeoutSeconds?: number }[];
  } }).claudeCode;
  return {
    operations: plugin.operations.map(({ method, version, effect, requires, presentation }) => ({ method, version, effect, requires, presentation })),
    actions: (plugin.actions ?? []).map(({ id, version, requires, presentation }) => ({ id, version, requires, presentation })),
    views: (plugin.components ?? []).map(({ id, version, ui, bindings, presentation }) => ({ id, version, ui, bindings, presentation })),
    skills: plugin.skills.map(({ content, ...skill }) => skill),
    ...(native ? { claudeCode: native } : {}),
    ...(plugin.agent?.mcp ? { mcp: plugin.agent.mcp } : {}),
  };
}
