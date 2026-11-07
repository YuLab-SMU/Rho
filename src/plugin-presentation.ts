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
  // Keep retained descriptions when an owner is absent, and overlay live state
  // only for the exact method. Display copy is optional; identity never is.
  const methods = new Map<string, { method: string; effect?: string; presentation?: EntryPresentation; state?: string; authorized?: boolean }>();
  for (const operation of [...(plugin?.listing?.operations ?? []), ...catalog.operations.filter(o => o.owner === pluginId)]) {
    methods.set(operation.method, { ...methods.get(operation.method), ...operation });
  }
  const operations = [...methods.values()];
  const actions = [...(catalog.actions ?? []), ...(catalog.unavailableActions ?? [])].filter(a => a.pluginId === pluginId);
  const groups = new Map<string, { displayName: string; identities: string[]; presentations: (EntryPresentation | undefined)[] }>();
  for (const entry of [...operations, ...actions, ...(plugin?.listing?.actions ?? [])]) {
    const identity = 'method' in entry ? entry.method : entry.id;
    const displayName = entry.presentation?.displayName || identity;
    if (!displayName) continue;
    // Several methods can expose one owner-authored human action. A group is
    // read-only only when every declared member is explicitly read-only.
    if (!groups.has(displayName)) groups.set(displayName, { displayName, identities: [], presentations: [] });
    if (identity && !groups.get(displayName)!.identities.includes(identity)) groups.get(displayName)!.identities.push(identity);
    groups.get(displayName)!.presentations.push(entry.presentation);
  }
  const components = new Map<string, CapabilityCatalog['components'][number] | NonNullable<NonNullable<CapabilityPlugin['listing']>['views']>[number]>();
  for (const component of [...(plugin?.listing?.views ?? []), ...catalog.components.filter(c => c.pluginId === pluginId)]) {
    components.set(component.id + '@' + component.version, component);
  }
  return {
    operations,
    actions: [...groups.values()].sort((a, b) => Math.min(...a.presentations.map(p => p?.order ?? Infinity)) - Math.min(...b.presentations.map(p => p?.order ?? Infinity))).map(group => ({
      displayName: group.displayName,
      identities: group.identities,
      description: [...new Set(group.presentations.flatMap(p => p?.description ? [p.description] : []))].join(' '),
      readOnly: group.presentations.every(p => p?.readOnly === true),
      runsCode: group.presentations.some(p => p?.runsCode === true),
    })),
    views: [...components.values()].map(c => ({
      id: c.id, version: c.version, ui: c.ui,
      package: ('uiPackage' in c && c.uiPackage as string | undefined) || plugin?.package,
      packageVersion: ('uiPackageVersion' in c && c.uiPackageVersion as string | undefined) || plugin?.packageVersion,
      bindings: c.bindings ?? {},
      displayName: c.presentation?.displayName || c.id,
      description: c.presentation?.description ?? '',
      readOnly: c.presentation?.readOnly,
      runsCode: c.presentation?.runsCode,
    })),
    skills: plugin?.listing?.skills ?? [],
  };
}

export function pluginMatches(catalog: CapabilityCatalog, plugin: CapabilityPlugin, query: string) {
  const entries = pluginEntries(catalog, plugin.id);
  return JSON.stringify([plugin.id, plugin.package, plugin.presentation, entries, plugin.listing?.claudeCode, plugin.listing?.mcp]).toLowerCase().includes(query.trim().toLowerCase());
}
