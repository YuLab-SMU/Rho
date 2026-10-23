import * as path from 'node:path';
import { atomicJson, canonical, digest, now, readJson, requireThat, stateDirectory, type PluginDescriptor } from '@rho-workspace/plugin-contracts';
import { operations } from './protocol.js';
import type { PluginId, Plugins } from './plugins.js';
import type { Principal, Project } from './state.js';

export const capabilityLimits = { maxReceipts: 256 };

export interface CapabilityReceipt {
  requestDigest: string;
  changeId: string;
  author: string;
  version: number;
  enabled: PluginId[];
  at: string;
}

export interface CapabilityState {
  schemaVersion: 1;
  version: number;
  enabled: PluginId[];
  receipts: CapabilityReceipt[];
}

const applicationSkill = {
  id: 'rho.workspace',
  version: '1.2',
  content: 'In layered mode use rho_index → rho_resolve → rho_call. Resolve selected relevant Skills and the complete exact contract before execution. Only advertise knownRefs whose full bodies remain available; after context loss omit missing refs and refetch them. The adapter also retains bounded complete objects; immutable bodies never replace live resource/version/authorization checks. In compatibility mode, discover project-enabled, dependency-satisfied and authorized operations with capability.list; fetch shipped owner guidance with skill.list/read and verify its digest. Use composition.apply with stable group/view IDs, exact component versions, props/bindings, expectedVersion and changeId; composition.undo affects only layout. Keep protected views and their ancestors in place; protection never prevents authorized document edits. Keep personal/view selections in interaction.selection scopes; use an explicit shared channel to collaborate. Draft feedback and responses in Documents, submit annotation.create/reply against exact source/draft versions, and explicitly link replyTo. Prepare selected feedback with context.create and fetch context.read; prepared, fetched and explicitly replied are distinct facts. Reading is not understanding or task completion. CSV reading, scatter plotting, shared editing and feedback need no native execution. Keep original changeIds after lost acknowledgements, query the current owner and receipt retention boundaries, and never replay under a new identity. Describe the whole task with task.map.declare: stable item IDs, your own kind and state words (terms with label, tone and an optional role Rho understands: working, waiting, done, planned, unknown, stopped), titles you write, progress counted from real receipts, an optional layout view per item, and next only for steps you will take. Change forms, parameters (subsets) and focus with task.map.present; a pinned target or a change within agentFormIntervalMs becomes one merged suggestion, and every applied change is attributed and revertible by the person. task.map.read only observes. Reconnect via a fresh snapshot after event gaps; archive collaboration with workspace.export format 3. Skills grant no authority, install no software and do not start runtimes.',
};
const skillDigest = digest(applicationSkill.content);

// What the person in the tab can do with their own folder, and where the boundary
// is. Written after a person opened a project, saw "Documents 0 / Files 0" beside a
// folder of files, and could not tell a decision from a defect.
const personFilesContent = [
  'A person opens a folder themselves; an Agent is not required to read it.',
  '',
  '1. project.entries lists one level of a folder inside the project, bounded and',
  '   confined to the project root, skipping owner state and symbolic links. Pass path',
  '   to descend; ".." and absolute paths are refused.',
  '2. project.openFile opens one text file as a document and places a single editor',
  '   view for it in the tab layout. Opening the same file again folds into one view.',
  '3. A file the person opened is a document in the shared buffer: they and the Agent',
  '   edit the same text, and the Agent may save it.',
  '',
  'The boundary is deliberate and worth stating to a person who asks: a tab may read',
  'its folder and edit a buffer, but it may not register resources, save to disk, run',
  'anything or reach a sibling project. Those stay Agent or operator work. When a',
  'person expects otherwise, say which rule refuses them rather than reporting a bug.',
  '',
  'Files the project shows as registered are not the same as files in the folder: the',
  'sidebar counts registered resources, while the Overview lists the folder itself.'
].join('\n');
const personFiles = {
  id: 'rho.person-files', version: '1.0', content: personFilesContent, digest: digest(personFilesContent),
  intent: 'Let a person read and open files from the folder they selected, without an Agent.',
  requires: ['project.entries', 'project.openFile', 'project.doctor'],
  example: {
    method: 'project.entries',
    input: { path: 'R' }
  },
  failureRecipes: [
    { kind: 'scope', message: 'Use a project-relative path without parent traversal.', next: 'List only inside the project root; descend one folder at a time.' },
    { kind: 'scope', message: 'Only folders inside this project can be listed.', next: 'A source folder added to the project is listed through the project, not by absolute path.' },
    { kind: 'invalid', message: 'That entry is a file, not a folder.', next: 'Call project.openFile for a file; project.entries is for folders.' },
    { kind: 'scope', message: 'Register a project file outside internal state.', next: 'An executed artifact under .rho is not a project resource; it is checked with artifact.check instead.' }
  ],
  verify: { command: 'npm run acceptance:person', description: 'In Chrome at three widths: list a real folder, open a file from it, confirm the editor shows the bytes, and confirm the tab still cannot register or execute.' }
};
export const rhoWorkspaceSkill = { ...applicationSkill, digest: skillDigest };
export const personFilesSkill = personFiles;
const taskMapContent = [
  'Describe the whole task yourself: Rho fixes no closed list of kinds or states.',
  '',
  '1. task.map.declare carries stable item IDs, your own kind and state words (each a',
  '   label, an optional tone and an optional role Rho understands: working, waiting,',
  '   done, planned, unknown, stopped), titles you write, progress counted from real',
  '   receipts, an optional layout view per item, and next only for steps you will take.',
  '2. task.map.present changes a card form, its parameters (a subset), or the focus.',
  '   People use the same call. A pinned target, or a change within agentFormIntervalMs',
  '   of your last applied form change, is merged into one pending suggestion instead of',
  '   being applied: the screen stays steady and the person applies it.',
  '3. task.map.respond is the person only: pin, unpin, revert your form change (layout',
  '   only, never the work), accept or dismiss a suggestion.',
  '4. task.map.read observes. Reading never starts, resumes or reruns work.',
  '',
  'A form declared zoom: false is reached only by naming it, so stepping up from a card',
  'lands on the summary, not on compare.'
].join('\n');
const taskMap = {
  id: 'rho.task-map', version: '1.0', content: taskMapContent, digest: digest(taskMapContent),
  intent: 'Tell a person what the whole task is doing, with your own words.',
  requires: ['task.map.declare', 'task.map.present', 'task.map.read'],
  example: {
    method: 'task.map.declare',
    input: {
      expectedVersion: 0, changeId: 'declare-1', question: null, compositionId: null,
      vocabulary: { kinds: { 估计: { label: 'Estimation' } }, states: { 在算: { label: 'Running', role: 'working' } } },
      items: [{ id: 'shrink', kind: '估计', state: '在算', title: 'Shrink the estimates', group: 'Estimate', progress: { done: 3, total: 1620, unit: 'genes' } }],
      remove: [], next: []
    }
  },
  failureRecipes: [
    { kind: 'stale', message: 'Task map version changed.', next: 'Read task.map.read and declare again with its current version; item identity stays yours.' },
    { kind: 'unauthorized', message: 'Only the Agent declares task items and their words.', next: 'A browser tab may present and respond, never declare.' },
    { kind: 'limit', message: 'Task map exceeded a declared budget.', next: 'Declare fewer items or shorter lines; retained facts stay readable.' }
  ],
  verify: { command: 'npm run test:task-map', description: 'Declares items with an Agent vocabulary, presents a form, and checks that an Agent change inside the interval becomes one revertible suggestion.' }
};
export const taskMapSkill = taskMap;

export class Capabilities {
  limits: typeof capabilityLimits;
  constructor(public plugins: Plugins, public project: Project) { this.limits = { ...capabilityLimits, ...plugins.config.capabilityLimits }; }

  private async file() {
    return path.join(await stateDirectory(this.project.root, '.rho/rho'), 'capabilities.json');
  }

  async state(): Promise<CapabilityState> {
    const file = await this.file();
    const fallback: CapabilityState = {
      schemaVersion: 1,
      version: 0,
      enabled: this.plugins.availableIds(),
      receipts: [],
    };
    const state = await readJson<CapabilityState>(file, fallback);
    requireThat(state.schemaVersion === 1 && Number.isSafeInteger(state.version) && state.version >= 0 && Array.isArray(state.enabled) && Array.isArray(state.receipts), 'condition', 'Project capability state is not a supported version.');
    requireThat(new Set(state.enabled).size === state.enabled.length && state.enabled.every(id => this.plugins.isKnown(id)), 'condition', 'Project capability state contains an unknown plugin.');
    requireThat(state.receipts.length <= this.limits.maxReceipts, 'limit', 'Project capability receipt history exceeds its retention boundary.', { limit: 'maxReceipts', retained: this.limits.maxReceipts });
    return state;
  }

  async configure(input: { expectedVersion: number; changeId: string; enabled: string[] }, author: string) {
    requireThat(Number.isSafeInteger(input.expectedVersion) && input.expectedVersion >= 0, 'invalid', 'expectedVersion must be a non-negative integer.');
    requireThat(/^[A-Za-z0-9._:@-]{1,128}$/.test(input.changeId), 'invalid', 'changeId has an invalid format.');
    requireThat(Array.isArray(input.enabled) && new Set(input.enabled).size === input.enabled.length && input.enabled.every(id => this.plugins.isKnown(id)), 'invalid', 'Capability selection contains an unknown or duplicate plugin.', { known: this.plugins.ids() });
    const file = await this.file();
    const current = await this.state();
    const previous = current.receipts.find(receipt => receipt.changeId === input.changeId);
    const requestDigest = digest(canonical({ input, author }));
    if (previous) {
      requireThat(previous.requestDigest === requestDigest, 'conflict', 'changeId was already used for a different capability selection or author.', { changeId: input.changeId, version: previous.version });
      return { version: previous.version, enabled: previous.enabled, receipt: previous };
    }
    requireThat(current.version === input.expectedVersion, 'stale', 'Project capability configuration version changed.', { actualVersion: current.version });
    requireThat(input.enabled.every(id => this.plugins.availabilityFor(id as PluginId)?.selected), 'scope', 'Project configuration cannot expand the service plugin allowlist.');
    const receipt: CapabilityReceipt = { requestDigest, changeId: input.changeId, author, version: current.version + 1, enabled: [...input.enabled] as PluginId[], at: now() };
    const next: CapabilityState = { ...current, version: receipt.version, enabled: receipt.enabled, receipts: [...current.receipts, receipt].slice(-this.limits.maxReceipts) };
    await atomicJson(file, next);
    return { version: next.version, enabled: next.enabled, receipt };
  }

  private pluginStatus(id: PluginId, state: CapabilityState, seen: string[] = []): { projectEnabled: boolean; dependenciesSatisfied: boolean; packagePresent: boolean } {
    const plugin = this.plugins.availabilityFor(id);
    const projectEnabled = state.enabled.includes(id);
    const packagePresent = plugin?.packagePresent === true;
    const dependenciesSatisfied = !seen.includes(id) && packagePresent && plugin?.state === 'available' &&
      (this.plugins.descriptor(id)?.requires ?? []).every(dep => {
        if (!this.plugins.isKnown(dep)) return false;
        const status = this.pluginStatus(dep, state, [...seen, id]);
        return status.projectEnabled && status.dependenciesSatisfied && status.packagePresent;
      });
    return { projectEnabled, dependenciesSatisfied, packagePresent };
  }

  private authorized(principal: Principal, method: string) {
    const owner = this.plugins.operationOwner(method);
    return principal.methods.includes(method) && (!owner || !principal.pluginFilter || principal.pluginFilter.includes(owner));
  }

  async operationStatus(principal: Principal, state: CapabilityState) {
    const declarations = this.plugins.operationDeclarations();
    const declared = new Map(declarations.map(operation => [operation.method, operation]));
    const methods = Object.keys(operations);
    return methods.map(method => {
      const operation = declared.get(method);
      const owner = operation?.owner ?? this.plugins.operationOwner(method);
      const provider = owner && this.plugins.isKnown(owner)
        ? this.pluginStatus(owner as PluginId, state)
        : { projectEnabled: true, dependenciesSatisfied: true, packagePresent: true };
      const dependenciesSatisfied = provider.dependenciesSatisfied && [...(operation?.requires ?? []), ...(['workspace.observe', 'workspace.enhance'].includes(method) ? ['agent', 'tables', 'files'] : [])].every(id => {
        if (!this.plugins.isKnown(id)) return false;
        const dep = this.pluginStatus(id, state);
        return dep.projectEnabled && dep.dependenciesSatisfied && dep.packagePresent;
      });
      const available = provider.packagePresent && provider.projectEnabled && dependenciesSatisfied;
      return {
        method,
        ...(operation ? { version: operation.version, inputSchema: operation.inputSchema, outputSchema: operation.outputSchema, requires: operation.requires, effect: operation.effect, ...(operation.presentation ? { presentation: operation.presentation } : {}) } : {}),
        ...(owner ? { owner } : {}),
        packagePresent: provider.packagePresent,
        projectEnabled: provider.projectEnabled,
        dependenciesSatisfied,
        authorized: this.authorized(principal, method),
        state: available ? 'available' : 'unavailable',
      };
    });
  }

  async catalog(principal: Principal) {
    const state = await this.state();
    const base = this.plugins.catalog;
    const native = await this.plugins.nativeAvailability((this.plugins.config as { rscript?: string }).rscript ?? 'Rscript');
    const plugins = base.plugins.map((entry: any) => ({ ...entry, ...this.pluginStatus(entry.id, state), ...(native[entry.id] ? { nativeAvailability: native[entry.id] } : {}) }));
    const operations = await this.operationStatus(principal, state);
    const actionStatus = operations.find(operation => operation.method === 'action.submit');
    return {
      ...base,
      configuration: { version: state.version, enabled: state.enabled, retainedReceipts: state.receipts.length, retainedFromVersion: state.receipts[0]?.version ?? state.version + 1, maxReceipts: this.limits.maxReceipts },
      plugins,
      operations,
      skills: await this.skills(principal),
      ...(actionStatus?.state === 'unavailable' ? { actions: [] } : {}),
    };
  }

  async skills(principal: Principal) {
    const state = await this.state();
    const result = [rhoWorkspaceSkill, personFilesSkill, taskMapSkill];
    for (const descriptor of this.plugins.descriptors()) {
      const status = this.pluginStatus(descriptor.id as PluginId, state);
      for (const skill of descriptor.skills ?? []) {
        if (status.packagePresent && status.projectEnabled && status.dependenciesSatisfied && descriptor.operations.some(operation => this.authorized(principal, operation.method))) result.push(skill);
      }
    }
    return result;
  }

  async readSkill(principal: Principal, skillId: string, expectedDigest?: string) {
    const skill = (await this.skills(principal)).find(candidate => candidate.id === skillId);
    requireThat(skill, 'not_found', 'Skill is not available in this project and session.');
    requireThat(!expectedDigest || expectedDigest === skill.digest, 'stale', 'Skill content digest changed.', { actualDigest: skill.digest });
    return skill;
  }

  async assertAvailable(method: string, principal: Principal) {
    const owner = this.plugins.operationOwner(method);
    const state = await this.state();
    const status = (await this.operationStatus(principal, state)).find(operation => operation.method === method)!;
    requireThat(status.state === 'available', 'unavailable', 'The requested capability is not available for this project.', { ...status, owner });
    // The HTTP authenticator is authoritative, but this check also protects
    // direct dispatch calls used by the local acceptance harness.
    requireThat(this.authorized(principal, method), 'unauthorized', 'Session does not authorize this operation.', { method });
  }

  async isAvailable(method: string, state?: CapabilityState) {
    const effectiveState = state ?? await this.state();
    const owner = this.plugins.operationOwner(method);
    const status = (await this.operationStatus({ methods: [] } as unknown as Principal, effectiveState)).find(operation => operation.method === method);
    return status?.state === 'available';
  }
}
