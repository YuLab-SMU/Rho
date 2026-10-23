import * as fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, canonical, digest, now, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
import type { ActionPlan } from '@rho-workspace/plugin-contracts';
import { Ajv } from 'ajv';
import type { ProjectPlugins } from './plugins.js';
import { CoreBridge, type CliResult } from './bridge.js';
import type { Principal, Project } from './state.js';
const ajv = new Ajv({ allErrors: true, strict: false });
export interface Operation {
  operationId: string; principal: string; projectId: string; requestDigest: string; request: any; action: string; actionVersion: string; acceptedAt: string;
  core: { caller: string; requestId: string }; delivery: string; execution: string; native: any; integrity: any; domain: any; interpretation: any; plan: ActionPlan; lastCli?: CliResult; checks?: any; cancellation?: any;
}
export const publicOperation = (run: Operation) => ({ ...run, request: run.request, plan: { ...run.plan, code: undefined, codeDigest: digest(run.plan.code) } });
export const requestLimits = { maxConcurrentActions: 2, maxOperations: 256, maxLogPageBytes: 65536, maxCodeBytes: 1024 * 1024, maxReconciled: 8 };
export class Requests {
  limits: typeof requestLimits;
  constructor(public project: Project, public bridge: CoreBridge, public emit: (type: string, subject: string) => Promise<void>, limits: Partial<typeof requestLimits>, public owners: ProjectPlugins) { this.limits = { ...requestLimits, ...Object.fromEntries(Object.entries(limits).filter(([k, v]) => k in requestLimits && v !== undefined)) }; }
  private async directory() { return stateDirectory(this.project.root, '.rho/rho/operations'); }
  private key(principal: Principal, operationId: string) { return digest(canonical([principal.id, this.project.id, operationId])); }
  private async file(principal: Principal, operationId: string) { return path.join(await this.directory(), this.key(principal, operationId) + '.json'); }
  private async persist(run: Operation) { await atomicJson(await this.file({ id: run.principal } as Principal, run.operationId), run); }
  async list(principal: Principal) {
    const d = await this.directory();
    const runs = await Promise.all((await fs.readdir(d)).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => readJson<Operation>(path.join(d, f))));
    const mine = runs.filter(r => r.principal === principal.id).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
    // Only the runs that can still change are re-read, newest first and bounded, so a
    // long history never turns one observation into many Host round trips.
    let budget = this.limits.maxReconciled;
    return Promise.all(mine.map(run => {
      const pending = ['active', 'unobserved'].includes(run.execution) && run.delivery === 'answered';
      if (!pending || budget <= 0) return run;
      budget--;
      return this.reconcile(run);
    }));
  }
  // A read reports what the owner already knows, so a run that finished while nobody
  // asked must not be shown as still running. Observation never starts a Host: when
  // none answers, the stored facts stay exactly as they were.
  private async reconcile(run: Operation) {
    if (!['active', 'unobserved'].includes(run.execution) || run.delivery !== 'answered') return run;
    let result: CliResult;
    try { result = await this.bridge.call(this.project.root, 'lookup', run.core.caller, run.core.requestId, ['--record']); }
    catch { return run; }
    // Not delivered, no reply or an owner error: the outcome stays genuinely unknown
    // rather than being guessed from an absent answer.
    if (result.exitCode !== 0 || !result.reply?.ok) return run;
    const before = run.execution;
    this.apply(run, result, false);
    if (run.execution !== before) { await this.persist(run); await this.emit('operation.observed', run.operationId); }
    return run;
  }
  // A single lookup reports the same reconciled facts as a listing: a caller that asks
  // about one run must not be told a different story than the one who lists them all.
  async lookup(principal: Principal, operationId: string) { return this.reconcile(await readJson<Operation>(await this.file(principal, operationId))); }
  async submit(principal: Principal, body: any, preparationAction = false) {
    const file = await this.file(principal, body.operationId);
    const request = { kind: preparationAction ? 'requirements.prepare' : 'action.submit', ...body };
    const requestDigest = digest(canonical(request));
    const existing = await readJson<Operation | null>(file, null);
    if (existing) {
      requireThat(existing.requestDigest === requestDigest, 'conflict', 'This operationId already names different immutable content.', { operationId: body.operationId, requestDigest: existing.requestDigest });
      return existing; // Explicit action.retry can deliver an accepted not-sent intent.
    }
    const actions = this.owners.assembly.catalog.actions;
    const action = preparationAction ? { id: 'r.execute', version: '0.2.0', inputSchema: {} } : actions.find(a => a.id === body.action);
    requireThat(action, 'unavailable', 'Selected action is not registered.');
    if (!preparationAction) {
      const validate = ajv.compile(action.inputSchema);
      requireThat(validate(body.input), 'invalid', 'Action input does not match its component schema.', { fields: validate.errors ?? [] });
    }
    const all = (await fs.readdir(await this.directory())).filter(n => n.endsWith('.json'));
    requireThat(all.length < this.limits.maxOperations, 'limit', 'Application operation retention is full; existing identities are retained.', { limit: 'maxOperations', maximum: this.limits.maxOperations });
    const directory = await this.directory();
    const runs = await Promise.all(all.map(f => readJson<Operation>(path.join(directory, f))));
    let active = 0;
    for (const run of runs.filter(r => ['active', 'unobserved', 'unknown'].includes(r.execution))) {
      const observed = await this.bridge.call(this.project.root, 'lookup', run.core.caller, run.core.requestId);
      if (observed.exitCode !== 0 || !(observed.reply.value?.terminal)) active++;
    }
    requireThat(active < this.limits.maxConcurrentActions, 'limit', 'Concurrent action budget reached; no new operation was accepted.', { limit: 'maxConcurrentActions', maximum: this.limits.maxConcurrentActions });
    const provider = this.owners.assembly.need('requirements');
    const requirements = preparationAction ? body.requirements : body.input.requirements;
    const checks = await provider.checkRequirements(this.project.root, requirements, this.bridge.rscript);
    requireThat(preparationAction || checks.status === 'present', 'condition', 'Selected action dependencies are missing or unknown.', { check: checks, continuation: 'Check and explicitly prepare this action in this project.' });
    const core = { caller: 'rho:' + digest(principal.id + ':' + this.project.id).slice(0, 48), requestId: this.key(principal, body.operationId) };
    const plan = preparationAction ? await provider.preparation(this.project.root, requirements, this.bridge.rscript) : await this.owners.assembly.need('r').planExecution(this.project.root, body.input, core.requestId, checks.environment, this.owners.need('files'), this.owners.documents, this.owners.assembly.config.r);
    requireThat(Buffer.byteLength(plan.code) <= this.limits.maxCodeBytes, 'limit', 'Script snapshot exceeds the selected code byte limit.', { limit: 'maxCodeBytes', maximum: this.limits.maxCodeBytes });
    const run: Operation = { operationId: body.operationId, principal: principal.id, projectId: this.project.id, requestDigest, request, action: preparationAction ? 'requirements.prepare:' + action.id : action.id, actionVersion: action.version, acceptedAt: now(), core, delivery: 'not-sent', execution: 'unobserved', native: null, integrity: { state: 'unchecked' }, domain: { state: 'unchecked' }, interpretation: { state: 'absent' }, plan, checks };
    await atomicJson(file, run); // Durable service acknowledgement precedes ANY Core submit.
    await this.emit('operation.accepted', run.operationId);
    return this.deliver(run, true);
  }
  private async deliver(run: Operation, mayStartHost: boolean) {
    if (mayStartHost) await this.bridge.ensureOwnedHost(this.project.root);
    else {
      const cap = await this.bridge.capability(this.project.root);
      requireThat(cap.exitCode === 0, 'condition', 'Original operation remains retained. Retry requires an available Host; observation cannot recover it.', { cli: cap });
    }
    // Persist uncertainty BEFORE sending. A crash at either side of the CLI
    // boundary can only lead to lookup/retry of these exact bytes and identity.
    run.delivery = 'sending'; await this.persist(run);
    const result = await this.bridge.call(this.project.root, 'submit', run.core.caller, run.core.requestId, ['--executor', 'r', '--workdir', '.', '--code-file', '-', '--', ...run.plan.args], run.plan.code);
    this.apply(run, result, true); await this.persist(run);
    await this.emit('operation.delivery', run.operationId); return run;
  }
  private apply(run: Operation, result: CliResult, submission: boolean) {
    run.lastCli = result;
    if (submission) run.delivery = result.exitCode === 0 || result.exitCode === 1 ? 'answered' : result.exitCode === 3 || result.exitCode === 2 ? 'not-delivered' : 'unknown';
    if (result.exitCode === 0 && result.reply.ok) {
      const view = result.reply.value.run ?? result.reply.value;
      run.native = view;
      const status = view.status;
      if (status?.Finished) run.execution = status.Finished.exit?.Code === 0 ? 'completed' : 'failed';
      else if (status?.Detached || status?.Gone) run.execution = 'unknown';
      else run.execution = view.terminal ? 'unknown' : 'active';
    } else if ([3, 4].includes(result.exitCode)) run.execution = 'unknown';
    // Native errors do not manufacture a terminal outcome or discard old facts.
  }
  async retry(principal: Principal, operationId: string) {
    const run = await this.lookup(principal, operationId);
    if (run.delivery === 'answered') return run;
    return this.deliver(run, run.delivery === 'not-sent');
  }
  async observe(principal: Principal, operationId: string) {
    const run = await this.lookup(principal, operationId);
    const result = await this.bridge.call(this.project.root, 'lookup', run.core.caller, run.core.requestId, ['--record']);
    this.apply(run, result, false);
    if (run.action.startsWith('requirements.prepare:') && run.execution === 'completed' && run.plan.source.requirements && this.owners.assembly.optional('requirements')) run.checks = await this.owners.assembly.need('requirements').checkRequirements(this.project.root, run.plan.source.requirements, this.bridge.rscript);
    await this.persist(run); return run;
  }
  async cancel(principal: Principal, operationId: string) {
    const run = await this.lookup(principal, operationId);
    const result = await this.bridge.call(this.project.root, 'cancel', run.core.caller, run.core.requestId);
    run.cancellation = { requestedAt: now(), cli: result, confirmation: 'Observe the original native status; request acknowledgement is not confirmed stop.' };
    this.apply(run, result, false); await this.persist(run); await this.emit('operation.cancel-requested', operationId); return run;
  }
  async output(principal: Principal, operationId: string, stream: string, offset: number, maxBytes = 65536) {
    requireThat(maxBytes <= this.limits.maxLogPageBytes, 'limit', 'Log page exceeds the retained read budget.', { limit: 'maxLogPageBytes', maximum: this.limits.maxLogPageBytes });
    const run = await this.lookup(principal, operationId);
    return this.bridge.call(this.project.root, 'read', run.core.caller, run.core.requestId, ['--stream', stream, '--offset', String(offset), '--max-bytes', String(maxBytes)]);
  }
  async artifacts(principal: Principal, operationId: string) {
    const run = await this.lookup(principal, operationId);
    const facts = await this.owners.assembly.need('files').collectArtifacts(this.project.root, this.project.id, run, this.owners.need('files'));
    if (run.integrity.state !== 'verified') run.integrity = facts.integrity; if (run.domain.state === 'unchecked') run.domain = facts.domain;
    await this.persist(run); return facts;
  }
  async check(principal: Principal, operationId: string) {
    const run = await this.lookup(principal, operationId);
    const facts = await this.owners.assembly.need('files').verifyArtifacts(this.project.root, run, this.owners.need('files'));
    run.integrity = facts.integrity; run.domain = facts.domain; await this.persist(run); return facts;
  }
}
