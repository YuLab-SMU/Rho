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
  version: '1.0',
  content: 'Discover project-enabled, dependency-satisfied and authorized operations with capability.list; fetch shipped owner guidance with skill.list/read and verify its digest. Use composition.apply with stable group/view IDs, exact component versions, props/bindings, expectedVersion and changeId; composition.undo affects only layout. Keep protected views and their ancestors in place; protection never prevents authorized document edits. Keep personal/view selections in interaction.selection scopes; use an explicit shared channel to collaborate. Draft feedback and responses in Documents, submit annotation.create/reply against exact source/draft versions, and explicitly link replyTo. Prepare selected feedback with context.create and fetch context.read; prepared, fetched and explicitly replied are distinct facts. Reading is not understanding or task completion. CSV reading, scatter plotting, shared editing and feedback need no native execution. Keep original changeIds after lost acknowledgements, query the current owner and receipt retention boundaries, and never replay under a new identity. Reconnect via a fresh snapshot after event gaps; archive collaboration with workspace.export format 3. Skills grant no authority, install no software and do not start runtimes.',
};
const skillDigest = digest(applicationSkill.content);
export const rhoWorkspaceSkill = { ...applicationSkill, digest: skillDigest };

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
    return principal.methods.includes(method);
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
      const dependenciesSatisfied = provider.dependenciesSatisfied && (operation?.requires ?? []).every(id => {
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
    const result = [rhoWorkspaceSkill];
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
    if (!owner) return;
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
    if (!owner) return true;
    const status = (await this.operationStatus({ methods: [] } as unknown as Principal, effectiveState)).find(operation => operation.method === method);
    return status?.state === 'available';
  }
}
