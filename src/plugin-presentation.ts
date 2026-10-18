import type { CapabilityCatalog, CapabilityPlugin, EntryPresentation } from './browser.js';

export function pluginPresentation(plugin: CapabilityPlugin) {
  const p = plugin.presentation;
  return {
    ...p,
    displayName: p?.displayName || plugin.id,
    tagline: p?.tagline ?? '',
    category: p?.category ?? '',
    examplePrompts: p?.examplePrompts ?? [],
    viewNote: p?.viewNote ?? '',
    readOnly: p?.readOnly,
    runsCode: p?.runsCode,
  };
}

export function pluginGroups(plugins: CapabilityPlugin[]) {
  const groups = new Map<string, CapabilityPlugin[]>();
  for (const plugin of [...plugins].sort((a, b) => (a.presentation?.categoryOrder ?? Infinity) - (b.presentation?.categoryOrder ?? Infinity) || (a.presentation?.order ?? Infinity) - (b.presentation?.order ?? Infinity))) {
    const category = pluginPresentation(plugin).category;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(plugin);
  }
  return [...groups].map(([category, plugins]) => ({ category, plugins }));
}

export function pluginEntries(catalog: CapabilityCatalog, pluginId: string) {
  const plugin = catalog.plugins.find(p => p.id === pluginId);
  const operations = catalog.operations.filter(o => o.owner === pluginId);
  const actions = [...(catalog.actions ?? []), ...(catalog.unavailableActions ?? [])].filter(a => a.pluginId === pluginId);
  const groups = new Map<string, { displayName: string; presentations: (EntryPresentation | undefined)[] }>();
  for (const entry of [...operations, ...actions, ...(plugin?.listing?.actions ?? [])]) {
    const displayName = entry.presentation?.displayName;
    if (!displayName) continue;
    // Several methods can expose one owner-authored human action. A group is
    // read-only only when every declared member is explicitly read-only.
    if (!groups.has(displayName)) groups.set(displayName, { displayName, presentations: [] });
    groups.get(displayName)!.presentations.push(entry.presentation);
  }
  return {
    actions: [...groups.values()].sort((a, b) => Math.min(...a.presentations.map(p => p?.order ?? Infinity)) - Math.min(...b.presentations.map(p => p?.order ?? Infinity))).map(group => ({
      displayName: group.displayName,
      description: [...new Set(group.presentations.flatMap(p => p?.description ? [p.description] : []))].join(' '),
      readOnly: group.presentations.every(p => p?.readOnly === true),
      runsCode: group.presentations.some(p => p?.runsCode === true),
    })),
    views: [...catalog.components.filter(c => c.pluginId === pluginId), ...(plugin?.listing?.views ?? [])].map(c => ({
      id: c.id, version: c.version, ui: c.ui,
      displayName: c.presentation?.displayName ?? '',
      description: c.presentation?.description ?? '',
      readOnly: c.presentation?.readOnly,
      runsCode: c.presentation?.runsCode,
    })),
    skills: plugin?.listing?.skills ?? [],
  };
}
