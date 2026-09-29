/** The scientific starter is an ordinary Manager recipe. Core only sees exact
 * package selections, view declarations and the normal scenario transaction. */
import type { InstanceRef, JsonValue, PluginInspection, PluginViewRecord, SaveScenario, ScenarioInstance, ScenarioProvider, ScenarioView } from '../public/plugin-protocol/index.js';

export const scientificPlugins = ['r', 'files', 'editor', 'console', 'objects', 'plots', 'viewer', 'packages', 'help'] as const;
export type ScientificPlugin = typeof scientificPlugins[number];
export interface WorkspacePackage extends ScenarioInstance { target: string; }
export interface ScientificWorkspace {
  scenario: string;
  name: string;
  layoutVersion: number;
  packages: Record<string, WorkspacePackage>;
  instances: Record<string, InstanceRef>;
  providers: ScenarioProvider[];
  checkpoint: string | null;
}
export interface WorkspaceChoice { inspection: PluginInspection; artifact: string; }
const json = (value: unknown) => value as JsonValue;

/** Inspect all inputs before creating the first instance. Missing packages are
 * actionable omissions, never permission to install a replacement. */
export function scientificWorkspace(choices: Record<ScientificPlugin, WorkspaceChoice>, backendTarget: string,
  runtime: { ark: string; r_home: string }, layoutVersion: number, scenario: string, name = 'R workspace'): ScientificWorkspace {
  if (!runtime.ark.startsWith('/') || !runtime.r_home.startsWith('/')) throw Error('Select absolute paths to an existing Ark and R home.');
  if (!name.trim() || name.length > 128) throw Error('Name the workspace using at most 128 characters.');
  const setup: ScientificWorkspace = { scenario, name: name.trim(), layoutVersion, packages: {}, instances: {}, providers: [], checkpoint: null };
  for (const key of scientificPlugins) {
    const choice = choices[key], manifest = choice?.inspection.manifest;
    if (!manifest || manifest.id !== `org.rho.${key}` || choice.inspection.summary.plugin !== manifest.id) throw Error(`Select the installed ${key} plugin.`);
    const artifact = choice.inspection.artifacts.find(item => item.id === choice.artifact);
    const target = manifest.backend ? backendTarget : 'ui-web';
    if (!artifact || artifact.target !== target) throw Error(`The selected ${key} artifact is unavailable for ${target}.`);
    if (Object.keys(manifest.dependencies).length) throw Error(`Use an explicit scenario to bind the dependencies of ${key}.`);
    if (key !== 'r' && !manifest.views.some(view => view.id === key)) throw Error(`The selected ${key} revision has no ${key} view.`);
    if (key === 'files' && !(manifest.views.find(view => view.id === 'files')!.configuration_schema as any)?.properties?.runtime)
      throw Error('Select a Files revision that passes its R provider to the Editor.');
    if (key === 'help' && !(manifest.views.find(view => view.id === 'help')!.configuration_schema as any)?.properties?.copy?.type?.includes('null'))
      throw Error('Select a Help revision that can open before choosing an installed package.');
    // Saved Viewer context reads original operations and resources through R's
    // public ports. Capture those grants in the same activation/scenario as the
    // selected contribution; Help-only revisions do not need these reads.
    const optional = key === 'editor' ? [{ id: 'r.session', version: 1 }, { id: 'r.execute', version: 2 }, { id: 'r.format', version: 1 }, { id: 'resources.read', version: 1 }]
      : key === 'r' && manifest.contexts.some(context => context.id === 'viewer')
        ? [{ id: 'operation.get', version: 1 }, { id: 'operation.list_recent', version: 1 }, { id: 'resources.read', version: 1 }] : [];
    if (optional.some(cap => !manifest.optional_requires?.some(grant => grant.capability.id === cap.id && grant.capability.version === cap.version)))
      throw Error(key === 'r' ? 'Select an R revision with the public saved Viewer context read contracts.' : 'Select an Editor revision with the public R execution and resource contracts.');
    setup.packages[key] = { plugin: manifest.id, revision: choice.inspection.summary.revision, artifact: artifact.id, target,
      configuration: key === 'r' ? json({ ...runtime, execution_timeout_seconds: 600 }) : structuredClone(manifest.default_configuration),
      dependencies: {}, ...(optional.length ? { optional_capabilities: optional } : {}) };
    for (const capability of manifest.capabilities) setup.providers.push({ capability: structuredClone(capability.capability), instance: key, target: null });
  }
  return setup;
}

/** Every cross-view reference is captured after activation has supplied its
 * exact identity. Later execution and retries never follow a window switch. */
export function scientificScenario(setup: ScientificWorkspace, manager: PluginViewRecord): SaveScenario {
  const instances: Record<string, ScenarioInstance> = {};
  for (const key of scientificPlugins) {
    const wanted = setup.packages[key], selected = setup.instances[key];
    if (!selected || selected.plugin !== wanted.plugin || selected.revision !== wanted.revision || selected.artifact !== wanted.artifact)
      throw Error(`Prepare the exact ${key} instance before saving the workspace.`);
    const { target: _, ...selection } = wanted; instances[key] = structuredClone(selection);
  }
  instances.manager = { plugin: manager.instance.plugin, revision: manager.instance.revision, artifact: manager.instance.artifact, configuration: {}, dependencies: {} };
  const source = setup.instances.r, configurations: Record<string, unknown> = {
    files: { editor: setup.instances.editor, editor_group: 'documents', runtime: source },
    editor: { source: setup.instances.files, file: null, runtime: source },
    console: { source }, objects: { source, object_group: 'documents' },
    plots: { source, selection: null, pinned: false, plot_group: 'inspection' },
    viewer: { source }, packages: { source, help: setup.instances.help, help_group: 'inspection' },
    help: { source, copy: null, topic: null }, manager: manager.configuration,
  };
  const view = (key: string): ScenarioView => ({ id: key, instance: key, contribution: key === 'manager' ? manager.contribution : key,
    configuration: json(structuredClone(configurations[key])), state: {}, state_revision: instances[key].revision, resource: null });
  const tabs = (id: string, selected: string, keys: string[]) => ({ kind: 'tabs' as const, id, selected, views: keys.map(view) });
  return { scenario: setup.scenario, expected_head: null, name: setup.name, instances, providers: structuredClone(setup.providers),
    layout: { kind: 'split', id: 'workspace', direction: 'horizontal', weights: [2, 1], children: [
      { kind: 'split', id: 'work', direction: 'vertical', weights: [3, 2], children: [tabs('documents', 'editor', ['editor']), tabs('execution', 'console', ['console'])] },
      { kind: 'split', id: 'explore', direction: 'vertical', weights: [1, 1], children: [tabs('inspection', 'objects', ['objects', 'plots', 'viewer']), tabs('project', 'files', ['files', 'packages', 'help', 'manager'])] },
    ] } };
}
