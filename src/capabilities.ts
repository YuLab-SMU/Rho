import { readFileSync } from 'node:fs';
import { parseSkillFile } from '@rho-workspace/plugin-contracts';
import * as path from 'node:path';
import { SkillDeclaration, atomicJson, canonical, digest, now, readJson, requireThat, stateDirectory, type PluginDescriptor } from '@rho-workspace/plugin-contracts';
import { operations } from './protocol.js';
import { screenCheckSkill } from './screen-check-skill.js';
import type { PluginId, Plugins } from './plugins.js';
import type { Principal, Project } from './state.js';
const readSkillFile = (url: URL) => parseSkillFile(url.href, readFileSync(url, 'utf8'));

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

// The umbrella Skill: what this application is, the order to work in, and the rules
// that used to be discovered by failing. It names where the detail lives instead of
// repeating every owner's contract.
const applicationContent = readSkillFile(new URL('../skills/rho/operations/rho-workspace/SKILL.md', import.meta.url)).body;
const applicationSkill = {
  id: 'rho.workspace', version: '1.7', content: applicationContent,
  intent: 'Work in this project through versioned operations, in a safe order.',
  requires: ['capability.list', 'observation.snapshot', 'action.submit', 'composition.apply', 'context.read'],
  example: { method: 'observation.snapshot', input: { projectId: 'the-open-project' } },
  failureRecipes: [
    { kind: 'unauthorized', message: 'Session does not authorize this operation.', next: 'Ask project.doctor with an intent to see the methods that task needs, then use a session that has them.' },
    { kind: 'invalid', message: 'Request does not match the versioned schema.', next: 'Call protocol.validate on the same body and apply the named fix.' },
    { kind: 'stale', message: 'Version or revision changed.', next: 'Re-read the owner record and retry with its current numbers, keeping your original changeId for the same request only.' },
    { kind: 'event_gap', message: 'Observation missed events.', next: 'Read a fresh snapshot; do not replay acknowledged writes.' },
    { kind: 'conflict', message: 'Another service holds this state directory.', next: 'Stop the other service, or start this one with a different --state-dir.' }
  ],
  verify: { command: 'npm run test:workspace', description: 'Opens a project, reads a snapshot, applies one conditional composition change and observes it back.' }
};
const skillDigest = digest(applicationSkill.content);

// What the person in the tab can do with their own folder, and where the boundary
// is. Written after a person opened a project, saw "Documents 0 / Files 0" beside a
// folder of files, and could not tell a decision from a defect.
const personFilesContent = readSkillFile(new URL('../skills/rho/operations/rho-person-files/SKILL.md', import.meta.url)).body;
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
    { kind: 'scope', message: 'Register a project file outside internal state.', next: 'Use the registered resource reference returned by artifact.check for an executed artifact; do not register its internal path again.' }
  ],
  verify: { command: 'npm run acceptance:person', description: 'In Chrome at three widths: list a real folder, open a file from it, confirm the editor shows the bytes, and confirm the tab still cannot register or execute.' }
};
export const rhoWorkspaceSkill = { ...applicationSkill, digest: skillDigest };
export const personFilesSkill = personFiles;

// Written after five real analyses (bulk RNA-seq, snRNA-seq, GeoMx DSP, bulk plus a
// metabolome, and a multi-omics cohort) ran through this application. None of them
// finished unattended at the time: turns ended on a call limit or on a wait nothing
// wakes, calls went into looking for what may be done rather than doing it, and results
// were not always written before the turn ended. Several of those stops have since been
// fixed in this application, so what follows is written as the practice that survived
// them rather than as a workaround for one build's limits.
const analysisRunContent = readSkillFile(new URL('../skills/rho/operations/rho-analysis-run/SKILL.md', import.meta.url)).body;
const analysisRunSkill = {
  id: 'rho.analysis-run', version: '1.2', content: analysisRunContent,
  digest: digest(analysisRunContent),
  intent: 'Run a whole analysis through the live sessions so a stop never loses the work.',
  requires: ['kernel.run', 'kernel.read', 'kernel.interrupt', 'resource.list'],
  example: {
    method: 'kernel.run',
    input: {
      language: 'r',
      code: 'counts <- read.csv("data/counts.csv", row.names = 1); dim(counts)',
      purpose: 'Load the count matrix once and keep it for later cells',
      changeId: 'load-counts',
      waitMs: 120000
    }
  },
  failureRecipes: [
    { kind: 'not_found', message: 'Skill is not available in this project and session.', next: 'Read skill.list for the Skills this project and session expose; a Skill owned by a disabled plugin is not listed.' },
    { kind: 'stale', message: 'Skill content digest changed.', next: 'Read the Skill again and apply the current text; do not act on a cached copy.' },
    { kind: 'limit', message: 'Too many cells are waiting.', next: 'Wait for the running cell or interrupt it, then continue in a new cell with a new changeId.' }
  ],
  verify: { command: 'npm run test:notebook', description: 'Runs R and Python cells, keeps their output, plots and variables, interrupts and stops sessions, and keeps identity across a restart.' }
};
export const analysisRunSkillDeclaration = analysisRunSkill;
const taskMapContent = readSkillFile(new URL('../skills/rho/operations/rho-task-map/SKILL.md', import.meta.url)).body;
const taskMap = {
  id: 'rho.task-map', version: '1.1', content: taskMapContent, digest: digest(taskMapContent),
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
      const dependenciesSatisfied = provider.dependenciesSatisfied && [...(operation?.requires ?? []), ...(['workspace.observe', 'workspace.enhance'].includes(method) ? ['agent', 'tables', 'files'] : []), ...(['evidence.preview','evidence.export'].includes(method) ? ['agent','files','annotations'] : [])].every(id => {
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
    const result: Array<SkillDeclaration & { owner: string }> = [rhoWorkspaceSkill, personFilesSkill, taskMapSkill, analysisRunSkill, screenCheckSkill].map(skill => ({ ...skill, owner: 'rho' }));
    for (const descriptor of this.plugins.descriptors()) {
      const status = this.pluginStatus(descriptor.id as PluginId, state);
      for (const skill of descriptor.skills ?? []) {
        if (status.packagePresent && status.projectEnabled && status.dependenciesSatisfied && descriptor.operations.some(operation => this.authorized(principal, operation.method))) result.push({ ...skill, owner: descriptor.id });
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
