import { Discovery } from './discovery.js';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Ajv } from 'ajv';
import { atomicJson, canonical, confined, digest, Fault, now, publicResource, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
import { Plugins, type PluginConfig } from './plugins.js';
import { protocol, operations } from './protocol.js';
import { describeProtocol } from './protocol-discovery.js';
import { CoreBridge } from './bridge.js';
import { State, type Principal, type Project } from './state.js';
import { Requests, publicOperation, requestLimits, type Operation } from './requests.js';
import { Workspace, workspaceLimits } from './workspace.js';
import { Interactions, interactionLimits } from './interactions.js';
import { TaskMap, taskMapLimits } from './task-map.js';
import { Capabilities } from './capabilities.js';
import { BrowserAccess, browserLimits } from './browser-access.js';
import { NativeFolderPicker, nativeFolderLimits } from './native-folders.js';
import { homedir } from 'node:os';
import { serveWeb, webRoot, installedWebEntries } from './web-assets.js';
import { Presentation, presentationWitnessLimits, visibilityLimits } from './presentation.js';
import { presentationSchemas } from './presentation-contracts.js';
import { isNativeTime } from './native-time.js';
import { readOperation, type OperationRequest } from './operation-request.js';
import { isRhoMethod } from './contract-runtime.js';
import type { RhoMethod, RhoOutput } from './contract.generated.js';
import { TaskRouting } from './task-routing.js';
import { exitWords, stopState } from './execution-facts.js';
import type { nativeActivityLimits, agentDeliveryLimits, RunContext } from '@rho-workspace/plugin-agent';
import { ownerContracts } from './contracts/owners.generated.js';
export interface FeedbackTransport { accept(envelope: any): Promise<any>; lookup(envelope: any): Promise<any> }
export interface NativeAdapterRegistration {
  projectId: string; taskId: string; registrationId: string; principal: string; adapterPrincipal: string;
  externalSessionId: string; transportCapabilities: Record<string, unknown>;
  proof: { kind: 'claude-code-init'; sessionId: string; clientVersion: string };
}
export const serviceLimits = { maxRequestBytes: 1024 * 1024, maxEventBytes: 65536, eventRetention: 256, maxSubscriptions: 8, maxQueue: 32, maxContexts: 128, maxBindings: 64, maxActivities: 256, maxContextBytes: 1024 * 1024, maxRetainedMetadataBytes: 32 * 1024 * 1024 };
export interface ServiceConfig extends Partial<typeof serviceLimits>, Partial<typeof requestLimits>, PluginConfig { root: string; stateDir: string; coreBinary: string; rscript: string; port?: number; nativeFolders?: Partial<typeof nativeFolderLimits>; workspace?: Partial<typeof workspaceLimits>; interactions?: Partial<typeof interactionLimits>; taskMap?: Partial<typeof taskMapLimits>; browser?: Partial<typeof browserLimits>; webRoot?: string; agentNativeActivity?: Partial<typeof nativeActivityLimits>; presentationWitness?: Partial<typeof presentationWitnessLimits>; visibility?: Partial<typeof visibilityLimits>; agentDelivery?: Partial<typeof agentDeliveryLimits>; deliveryTransportTimeoutMs?: number }
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
ajv.addFormat('date-time', { type: 'string', validate: isNativeTime });

// One run's output reports three different facts, and they are never merged:
//   declared  the paths the request's own plan asked the producer to write;
//   present   whether that path holds a regular file right now (one bounded stat);
//   verified  what artifact.check recorded after comparing bytes with the
//             completion inventory the producer wrote.
// A failed run can leave every declared file on disk and still have produced
// nothing anyone verified, so a reader has to be able to see all three.
const authorKind = (principal: string) => principal.startsWith('agent:') ? 'Agent' : principal === 'operator' ? 'Operator' : principal.startsWith('browser:') ? 'Person' : principal;
// A stop is a request until Core reports the process ended; acceptance is not a stop.
function stopFacts(run: Operation) {
  if (!run.cancellation?.requestedAt) return null;
  const status = run.native?.status ?? {};
  return { requestedAt: String(run.cancellation.requestedAt), by: authorKind(String(run.cancellation.requestedBy ?? run.principal)), state: stopState(status, run.native?.cancel, run.execution !== 'unknown'), exit: exitWords(status.Finished?.exit) };
}
async function runFacts(project: Project, run: Operation) {
  const declared = Array.isArray(run.plan?.source?.artifacts) ? run.plan.source.artifacts as Array<{ path: string }> : [];
  const output: string | undefined = (run.plan as any)?.output;
  const files: Array<{ path: string; present: boolean; bytes: number }> = [];
  for (const artifact of declared) {
    let present = false, bytes = 0;
    if (output && typeof artifact.path === 'string') {
      const file = await confined(project.root, path.join(output, artifact.path), true).catch(() => null);
      const stat = file ? await fs.lstat(file).catch(() => null) : null;
      if (stat?.isFile()) { present = true; bytes = stat.size; }
    }
    files.push({ path: artifact.path, present, bytes });
  }
  const inventory = (run.plan as any)?.completion;
  const completion = inventory ? await fs.lstat(path.join(project.root, inventory)).then(stat => stat.isFile(), () => false) : false;
  return {
    operationId: run.operationId,
    action: run.action,
    execution: run.execution,
    delivery: run.delivery,
    acceptedAt: run.acceptedAt,
    author: authorKind(run.principal),
    declared: files,
    missing: files.filter(file => !file.present).map(file => file.path),
    completion: completion ? 'present' as const : 'absent' as const,
    integrity: (run.integrity?.state ?? 'unchecked') as 'unchecked' | 'declared' | 'incomplete' | 'verified' | 'not-applicable',
    domain: (run.domain?.state ?? 'unchecked') as 'unchecked' | 'checked',
    script: typeof run.plan?.code === 'string' ? digest(run.plan.code) : null,
    // The path stays out of this summary on purpose; its digest is enough to group
    // the submissions of one file into a retry chain.
    sourceKey: typeof (run.plan?.source as { path?: unknown } | undefined)?.path === 'string' ? digest((run.plan.source as { path: string }).path).slice(0, 16) : null,
    hasStderr: Number(run.native?.stderr?.retained_bytes ?? 0) > 0,
    stop: stopFacts(run),
    repairOf: run.repairOf ?? null
  };
}
// One run as a context gives it to the Agent (docs/WORKSPACE-PLAN.md W4): the recorded
// facts and the end of the retained stderr, where R writes its error. `from` says where the
// excerpt starts, so a cut is never mistaken for the whole stream.
export const runContextLimits = { errorExcerptBytes: 8192 };
async function runContext(project: Project, requests: Requests, principal: Principal, operationId: string): Promise<RunContext> {
  const run = await requests.lookup(principal, operationId, true), facts = await runFacts(project, run);
  // The stored count can trail what Core has retained since it was recorded. When Core's reply
  // reaches further, read the end again: the excerpt is the last bytes, where R writes its error.
  // A finished run is asked once even when nothing was recorded yet.
  const ended = !!run.native?.status?.Finished;
  let retained = Number(run.native?.stderr?.retained_bytes ?? 0), error: RunContext['error'] = null;
  for (let reads = 0; reads < 2 && (retained > 0 || (ended && reads === 0)); reads++) {
    const from = Math.max(0, retained - runContextLimits.errorExcerptBytes);
    const chunk = (await requests.output(principal, operationId, 'stderr', from, runContextLimits.errorExcerptBytes)).reply?.value;
    if (!chunk) break;
    const now = Number(chunk.info?.retained_bytes ?? retained);
    // A start inside a multi-byte character decodes as replacement characters; drop them.
    if (now > 0) error = { stream: 'stderr', text: from > 0 ? String(chunk.text).replace(/^\uFFFD+/, '') : String(chunk.text), from, retainedBytes: now, observedBytes: Number(chunk.info?.observed_bytes ?? now), truncated: !!chunk.info?.truncated };
    if (now <= retained) break;
    retained = now;
  }
  const script = run.request?.input?.script, stop = stopFacts(run);
  return {
    operationId: run.operationId, action: run.action, actionVersion: run.actionVersion, execution: run.execution, acceptedAt: run.acceptedAt,
    submittedBy: authorKind(run.principal), exit: exitWords(run.native?.status?.Finished?.exit), stop: stop ? { state: stop.state, by: stop.by } : null, repairOf: run.repairOf ?? null,
    error,
    script: script && typeof script.kind === 'string' ? { kind: script.kind, ...(typeof script.path === 'string' ? { path: script.path } : {}), ...(typeof script.digest === 'string' ? { digest: script.digest } : {}), ...(typeof script.documentId === 'string' ? { documentId: script.documentId, version: script.version } : {}) } : null,
    args: Array.isArray(run.request?.input?.args) ? run.request.input.args.map(String) : [], declared: facts.declared, output: typeof run.plan?.output === 'string' ? run.plan.output : null
  };
}
const validators = Object.fromEntries(Object.entries(operations).map(([k, v]) => [k, ajv.compile<any>(v)]));
// A schema path is not advice. Turn the common shapes of refusal into the edit the
// caller should make, so fixing a request does not require reading the JSON Schema.
function fixFor(error: any): string {
  const field = String(error.instancePath ?? '').replace(/^\//, '').split('/').filter(Boolean).join('.') || 'the request';
  const at = error.params ?? {};
  switch (error.keyword) {
    case 'required': return `Add "${at.missingProperty}"; ${field === 'the request' ? 'the request' : field} requires it.`;
    case 'dependencies': return `Adding "${at.property}" also requires "${at.missingProperty}".`;
    case 'enum': return `Use one of: ${(at.allowedValues ?? []).join(', ')}.`;
    case 'const': return `This value must be ${JSON.stringify(at.allowedValue)}.`;
    case 'additionalProperties': return `Remove "${at.additionalProperty}"; it is not part of this body.`;
    case 'pattern': return `"${field}" must match ${at.pattern}.`;
    case 'type': return `"${field}" must be ${at.type}.`;
    case 'oneOf': return `"${field}" must match exactly one accepted shape; each variant may need different fields.`;
    default: return error.message ?? 'The request does not match the schema.';
  }
}
function explainSchema(errors: any[] | null | undefined) {
  return (errors ?? []).slice(0, 8).map(error => ({ path: error.instancePath || '/', keyword: error.keyword, message: error.message, fix: fixFor(error) }));
}
// Filesystem and platform refusals say what to change; anything else keeps the
// conservative "inspect its state" wording, because the effect is genuinely unknown.
function explainFailure(e: any): [string, string, Record<string, unknown>] {
  const code = e?.code as string | undefined, target = e?.path as string | undefined;
  const where = target ? ` ${target}` : '';
  switch (code) {
    case 'ENOENT': return ['not_found', `Nothing exists at${where || ' the requested path'}.`, { code, path: target }];
    case 'EACCES':
    case 'EPERM': return ['scope', `Rho may not write${where}. Check the folder's permissions, or run Rho outside a restricting sandbox.`, { code, path: target, remedy: 'Grant the process write access to that folder, or select a folder it already owns.' }];
    case 'ENOSPC': return ['limit', 'The disk has no space left for this write.', { code, limit: 'disk' }];
    case 'EROFS': return ['scope', `The volume holding${where} is read-only.`, { code, path: target }];
    case 'EMFILE':
    case 'ENFILE': return ['limit', 'Too many files are open for this process.', { code }];
    default: return ['storage', 'The operation could not be confirmed; retain the original identity and inspect its state.', { code }];
  }
}
export class RhoService {
  plugins: Plugins; state: State; bridge: CoreBridge; url = ''; adminToken = ''; server: http.Server;
  private queues = new Map<string, Promise<any>>();
  private queued = new Map<string, number>();
  private subscribers = new Set<{ projectId: string; principal: string; tokenHash: string; response: http.ServerResponse }>();
  browser: BrowserAccess;
  folderPicker: NativeFolderPicker;
  private pickingFolder = false;
  private nativeAdapters = new Map<string, NativeAdapterRegistration>();
  private closing = false;
  private feedbackTransports = new Map<string, FeedbackTransport>();
  private feedback(project: Project, owners = this.plugins.project(project.root, project.id)) {
    const agent = owners.need('agent');
    return new (this.plugins.need('agent').FeedbackDelivery)(project.root, project.id, { agent, annotations: owners.annotations, binding: async (id: string) => (await readJson<any[]>(path.join(await this.dataDir(project), 'bindings.json'), [])).find(b => b.id === id) }, this.config.agentDelivery);
  }
  async configureFeedback(projectId: string, options: { draftPath?: string; relatedDocumentId?: string | null } = {}) {
    const project = await this.state.project(projectId, this.state.principals.find(p => p.id === 'operator')!);
    return this.serial(projectId, async () => {
      requireThat(await new Capabilities(this.plugins, project).isAvailable('feedback.submit'), 'unavailable', 'Select the feedback owners before enabling this entry.');
      const routing = new TaskRouting(project), delivery = this.feedback(project), owners = this.plugins.project(project.root, project.id);
      requireThat(await routing.read(), 'condition', 'Assign the original task first.');
      const draftPath = options.draftPath ?? 'feedback.md';
      requireThat(!draftPath.split(/[\\/]/).some(part => ['.rho', '.git'].includes(part)), 'scope', 'Feedback drafts use an ordinary project document.');
      const draft = await owners.need('documents').open(draftPath, 'operator');
      const relatedDocumentId = options.relatedDocumentId ?? null;
      if (relatedDocumentId) await owners.need('documents').read(relatedDocumentId);
      if (await routing.feedbackInitialized()) await delivery.state();
      else await delivery.initialize();
      await routing.markFeedbackInitialized({ draftDocumentId: draft.id, relatedDocumentId });
      return { taskId: (await routing.read()).taskId, profile: 'rho.feedback/1' };
    });
  }
  // Trusted embedding port. It supplies transport effects only; the owner still
  // persists/checks the original intent before accept and only looks up retries.
  selectFeedbackTransport(projectId: string, registrationId: string, transport: FeedbackTransport) {
    const adapter = this.nativeAdapters.get(projectId + ':' + registrationId);
    requireThat(adapter?.transportCapabilities.inboxLookup === true, 'condition', 'Select a registered feedback-capable native adapter.');
    this.feedbackTransports.set(projectId + ':' + registrationId, transport);
  }
  private async feedbackProject(projectId: string) {
    const project = await this.state.project(projectId, this.state.principals.find(p => p.id === 'operator')!);
    requireThat(await new TaskRouting(project).feedbackInitialized(), 'unavailable', 'This task has no selected feedback entry.');
    requireThat(await new Capabilities(this.plugins, project).isAvailable('feedback.read'), 'unavailable', 'Original feedback owners are unavailable.');
    return project;
  }
  async acceptFeedback(envelope: any) {
    requireThat(ajv.validate<any>((ownerContracts.selected['agent-feedback'].feedbackSchemas as Record<string, any>).DeliveryEnvelope, envelope), 'invalid', 'Malformed original delivery envelope.');
    const project = await this.feedbackProject(envelope.projectId);
    return this.serial(project.id, async () => { const receipt = await this.feedback(project).accept(envelope); await this.emit(project, 'feedback.changed', envelope.deliveryId); return receipt; });
  }
  async lookupFeedback(envelope: any) {
    const input = Object.fromEntries(['projectId', 'taskId', 'deliveryId', 'requestDigest', 'targetBindingId', 'externalSessionId'].map(k => [k, envelope[k]]));
    requireThat(ajv.validate<any>((ownerContracts.selected['agent-feedback'].feedbackSchemas as Record<string, any>).InboxLookupInput, input), 'invalid', 'Malformed original inbox lookup.');
    const project = await this.feedbackProject(input.projectId);
    return this.serial(project.id, () => this.feedback(project).lookup(input));
  }
  async stepFeedback(projectId: string, submissionId: string) {
    const project = await this.feedbackProject(projectId);
    const retained = await this.feedback(project).state(), original = retained.records.find((r: any) => r.submission.submissionId === submissionId)?.submission.delivery;
    requireThat(original, 'condition', 'Original feedback has no complete delivery envelope.');
    const registered = this.nativeAdapters.get(projectId + ':' + original.adapterRegistrationId);
    if (!registered || registered.externalSessionId !== original.externalSessionId) return { action: 'blocked', state: 'unknown', reason: 'original-adapter-unavailable' };
    const prepared = await this.serial(projectId, async () => this.feedback(project).prepareAttempt(submissionId, await new TaskRouting(project).read()));
    const adapter = this.nativeAdapters.get(projectId + ':' + prepared.envelope.adapterRegistrationId);
    if (!adapter || adapter.externalSessionId !== prepared.envelope.externalSessionId) return { action: prepared.action, state: 'unknown', reason: 'original-adapter-unavailable' };
    const transport = this.feedbackTransports.get(projectId + ':' + adapter.registrationId) ?? { accept: (e: any) => this.acceptFeedback(e), lookup: (e: any) => this.lookupFeedback(e) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const effect = prepared.action === 'accept' ? transport.accept(prepared.envelope) : transport.lookup(prepared.envelope);
      const value = await Promise.race([effect, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Delivery transport observation timed out.')), this.config.deliveryTransportTimeoutMs ?? 5000); })]);
      const receipt = prepared.action === 'accept' ? value : value.state === 'retained' ? value.receipt : null;
      if (!receipt) return { action: prepared.action, state: 'unknown', reason: 'original-inbox-unavailable', absenceAuthorizesReplay: false };
      await this.serial(projectId, async () => { await this.feedback(project).acknowledge(prepared.envelope, receipt); await this.emit(project, 'feedback.changed', prepared.envelope.deliveryId); });
      return { action: prepared.action, state: 'accepted', receipt };
    } catch { return { action: prepared.action, state: 'unknown', reason: 'original-acceptance-response-unavailable', absenceAuthorizesReplay: false }; }
    finally { clearTimeout(timer); }
  }
  // Trusted control-plane selection, not a model-callable configuration tool.
  async configurePresentation(projectId: string, policy: any) {
    requireThat(ajv.validate(presentationSchemas.BasicPolicy, policy), 'invalid', 'Choose the complete selected basic presentation policy.');
    const project = await this.state.project(projectId, this.state.principals.find(p => p.id === 'operator')!);
    return this.serial(projectId, async () => {
      const owners = this.plugins.project(project.root, project.id), capabilities = new Capabilities(this.plugins, project);
      requireThat(await capabilities.isAvailable('data.page'), 'unavailable', 'Basic presentation needs the selected Tables owner.');
      const route = await new TaskRouting(project).read();
      const display = new Presentation(project, new Workspace(project, owners, this.config.workspace), this.config.presentationWitness, this.config.visibility);
      if (!(await display.state()).policy) {
        const history = await new (this.plugins.need('agent').NativeActivity)(project.root, project.id, this.config.agentNativeActivity).read({ after: 0, cursor: null, limit: 1, maxBytes: 65536 });
        requireThat(history.cursor === 0, 'condition', 'Initial presentation setup must precede native observations; missing prior display state requires reconciliation, never resetting first facts.');
      }
      return display.configure(policy, route);
    });
  }
  // Trusted native-client integration only; not an HTTP/MCP operation. The
  // adapter registers after observing the actual CLI init/session identity.
  registerNativeAdapter(registration: NativeAdapterRegistration) {
    requireThat(registration.proof.kind === 'claude-code-init' && registration.proof.sessionId === registration.externalSessionId && /^2\.\d+\.\d+(?: \(Claude Code\))?$/.test(registration.proof.clientVersion), 'condition', 'Native session evidence does not match the selected integration.');
    requireThat(registration.principal !== registration.adapterPrincipal && this.state.projects.some(p => p.id === registration.projectId) && this.state.principals.some(p => p.id === registration.principal && p.projectId === registration.projectId) && this.state.principals.some(p => p.id === registration.adapterPrincipal && p.projectId === registration.projectId), 'scope', 'Native adapter needs a separate, provisioned project principal.');
    const key = registration.projectId + ':' + registration.registrationId, old = this.nativeAdapters.get(key);
    requireThat(!old || canonical(old) === canonical(registration), 'conflict', 'Native adapter registration cannot change its session or authority.');
    requireThat(old || this.nativeAdapters.size < (this.config.maxBindings ?? 64), 'limit', 'Native adapter registrations exceed maxBindings.');
    const supported = ['pull-tool-result', 'post-tool-boundary', 'queued-turn'].map(inputMode => ({ inputMode, inboxLookup: inputMode !== 'pull-tool-result', inboxDeduplication: inputMode === 'pull-tool-result' ? 'none' : 'retained-original-delivery', hookEmissionDeduplication: inputMode === 'pull-tool-result' ? 'none' : 'no-reemit-after-attempt', modelConsumptionAck: false, nativeExecutionDeduplication: false }));
    requireThat(supported.some(capabilities => canonical(capabilities) === canonical(registration.transportCapabilities)), 'unavailable', 'Native capability claims do not match a selected observation/feedback integration.');
    this.nativeAdapters.set(key, structuredClone(registration));
  }
  // Internal artifact-policy consumer, not a new public publication API. The
  // caller retains returned facts; Files remains the only resource registry.
  // Re-observing the original event uses the same declaration/resource identity.
  async observeNativeOutput(projectId: string, eventId: string) {
    const project = await this.state.project(projectId, this.state.principals.find(p => p.id === 'operator')!);
    return this.serial(projectId, () => this.observeNativeOutputLocked(project, eventId));
  }
  private async observeNativeOutputLocked(project: Project, eventId: string) {
      const projectId = project.id;
      const owners = this.plugins.project(project.root, project.id);
      owners.need('agent');
      const route = await new TaskRouting(project, this.config.capabilityLimits?.maxReceipts, this.config.maxRetainedMetadataBytes).read();
      requireThat(route, 'condition', 'Choose a native task before consuming its output.');
      const capabilities = new Capabilities(this.plugins, project), selected = await capabilities.state();
      requireThat(await capabilities.isAvailable('binding.activity', selected) && await capabilities.isAvailable('resource.register', selected) && await capabilities.isAvailable('data.page', selected), 'unavailable', 'Selected output owners are unavailable; activity remains retained.');
      const native = new (this.plugins.need('agent').NativeActivity)(project.root, project.id, this.config.agentNativeActivity);
      let cursor = null, record: any;
      do {
        const page = await native.read({ after: 0, cursor, limit: 100, maxBytes: 65536 });
        record = page.entries.find((x: any) => x.eventId === eventId); cursor = page.next;
      } while (!record && cursor);
      requireThat(record?.event.kind === 'artifact.ready' && route.participants.some((x: any) => x.bindingId === record.bindingId && x.role === 'business'), 'stale', 'Original artifact-ready observation is unavailable; do not rediscover or rerun its producer.');
      const output = record.event.output, facts: any = { source: { eventId, cursor: record.cursor, bindingId: record.bindingId, nativeToolUseId: record.event.nativeToolUseId }, registration: null, validation: { state: 'not-checked' }, resource: null };
      const display = new Presentation(project, new Workspace(project, owners, this.config.workspace), this.config.presentationWitness, this.config.visibility);
      const sourceEvent = { adapterId: record.adapterId, adapterEpoch: record.adapterEpoch, sourceSeq: record.event.sourceSeq };
      const historical = output.policyRef !== route.policyRef;
      try {
        requireThat((!historical || await display.retainedSource(output.policyRef, sourceEvent)) && output.declaration.kind === 'table', 'condition', 'This output needs the selected policy or its retained original presentation transaction.');
        requireThat(!output.declaration.path.split(/[\\/]/).some((part: string) => ['.rho', '.git'].includes(part)), 'scope', 'Outputs must be outside internal state.');
        const previous = (await owners.need('files').list()).filter(x => x.path === output.declaration.path);
        requireThat(previous.every(x => x.version === output.expectedDigest), 'conflict', 'Use a new versioned path; preserve the previously registered output.');
        const operationId = 'registration:' + digest(canonical(output.declaration));
        const existing = previous.find(x => x.provenance.operationId === operationId && x.kind === output.declaration.kind && canonical(x.format) === canonical(output.declaration.format) && x.version === output.expectedDigest);
        requireThat(!historical || existing, 'stale', 'Historical observation may only read its original registered artifact.');
        const resource = existing ?? await owners.need('files').register(output.declaration.path, { operationId, registeredBy: 'operator' }, 'available', {}, output.declaration, output.expectedDigest);
        facts.registration = { id: resource.id, version: resource.version };
        const page = await owners.need('tables').page(facts.registration, 0, 1);
        facts.validation = { state: 'typed-ready', totalRows: page.total, columns: page.columns, entityKey: page.entityKey, namespace: page.namespace };
        facts.resource = facts.registration;
      } catch (e) {
        facts.validation = { state: 'rejected', error: { kind: e instanceof Fault ? e.kind : 'storage', message: e instanceof Fault ? e.message : 'Output observation could not be confirmed; retain source and previous artifacts.' } };
      }
      if (facts.resource) {
        const selectedPolicy = await display.policyFor(output.policyRef);
        if (selectedPolicy) {
          try {
            requireThat(canonical(selectedPolicy.candidateDeclaration) === canonical(output.declaration), 'condition', 'Output differs from the selected basic presentation policy.');
            const current = await new Workspace(project, owners, this.config.workspace).read(route.compositionId).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
            facts.presentation = await display.ensureBasic({ projectId, taskId: route.taskId, sourceEvent, configurationId: selectedPolicy.policyId, policyRef: output.policyRef, candidate: facts.resource, expectedVersion: current?.version ?? 0 }, route);
            await this.emit(project, 'composition.changed', route.compositionId);
          } catch (e) {
            facts.presentation = { state: 'pending', error: { kind: e instanceof Fault ? e.kind : 'storage', message: e instanceof Fault ? e.message : 'Artifact ready; presentation could not be confirmed.' } };
            try { await display.pending({ resource: facts.resource, eventId }, facts.presentation.error); } catch { /* Preserve source/owner facts if presentation storage is exhausted. */ }
          }
        }
      }
      return facts;
  }
  constructor(public config: ServiceConfig) {
    for (const [key, value] of Object.entries({ ...serviceLimits, ...requestLimits, ...config.documents, ...config.resources, ...config.workspace, ...config.interactions, ...config.annotations, ...config.capabilityLimits, ...config.r, ...config.browser, ...config.nativeFolders, ...config.agentNativeActivity, ...config.agentDelivery, ...config.presentationWitness, ...config.visibility, ...config })) {
      if (typeof value === 'number') requireThat(Number.isSafeInteger(value) && (key === 'port' ? value >= 0 && value <= 65535 : value > 0), 'invalid', 'Invalid service budget.', { field: key });
    }
    this.plugins = new Plugins(config);
    this.state = new State(config.root, config.stateDir); this.bridge = new CoreBridge(config.coreBinary, config.rscript);
    this.browser = new BrowserAccess(this.state, config.browser);
    this.folderPicker = new NativeFolderPicker({ ...nativeFolderLimits, ...config.nativeFolders });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
  }
  async start() {
    try {
    await this.plugins.load();
    this.plugins.installedUi = await installedWebEntries(this.config.webRoot);
    await this.state.init();
    for (const project of this.state.projects) if (project.sources) this.plugins.sourceFolders.set(project.id, project.sources);
    this.adminToken = randomBytes(32).toString('hex');
    this.state.principals = this.state.principals.filter(p => p.id !== 'operator');
    await this.state.addPrincipal({ id: 'operator', tokenHash: digest(this.adminToken), methods: Object.keys(operations) });
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port ?? 0, '127.0.0.1', () => resolve()); });
    this.url = 'http://127.0.0.1:' + (this.server.address() as any).port;
    await atomicJson(path.join(this.state.directory, 'connection.json'), { url: this.url, token: this.adminToken, apiVersion: '2.0' });
    return this;
    } catch (e) {
      if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
      await this.state.close(); throw e;
    }
  }
  async agentConnection(projectId: string, externalSessionId: string, file: string, methods?: string[], pluginFilter?: string[], profile: 'layered-business' | 'layered-presentation' = 'layered-business') {
    requireThat(profile === undefined || ['layered-business', 'layered-presentation'].includes(profile), 'invalid', 'Choose an explicitly supported layered profile.');
    const project = await this.state.project(projectId, this.state.principals.find(p => p.id === 'operator')!);
    this.plugins.need('agent');
    const capabilities = new Capabilities(this.plugins, project);
    const state = await capabilities.state();
    const available = Object.keys(operations).filter(m => !m.startsWith('session.') && !m.startsWith('project.') && !m.startsWith('requirements.prepare') && !m.startsWith('workspace.restore') && !['task.routing.put', 'binding.activity.append', 'feedback.submit', 'view.observe', 'view.observations.read', 'task.map.respond'].includes(m));
    const profileMethods = profile === 'layered-presentation' ? ['binding.open', 'capability.index', 'capability.resolve', 'workspace.observe', 'workspace.enhance'] : available.filter(m => !['workspace.observe', 'workspace.enhance'].includes(m));
    const selected = methods ?? (profile === 'layered-presentation' ? profileMethods : (await Promise.all(profileMethods.map(async method => [method, await capabilities.isAvailable(method, state)] as const))).filter(([, enabled]) => enabled).map(([method]) => method));
    requireThat(profile !== 'layered-presentation' || selected.every(m => profileMethods.includes(m)), 'scope', 'The selected role cannot receive broader methods.');
    requireThat(selected.every(m => !!operations[m] && !m.startsWith('session.') && !m.startsWith('project.') && m !== 'task.routing.put'), 'invalid', 'Unknown or operator-only Agent capability.');
    requireThat(await Promise.all(selected.map(method => capabilities.isAvailable(method, state))).then(values => values.every(Boolean)), 'unavailable', 'A requested Agent operation has no selected provider.');
    requireThat(!profile || new Set(['capability.index', 'capability.resolve', ...selected]).size <= 64, 'limit', 'Layered connection methods exceed the selected 64-method profile; choose an explicit narrower grant.');
    const token = randomBytes(32).toString('hex');
    const id = 'agent:' + digest(projectId + ':' + externalSessionId).slice(0, 32);
    this.state.principals = this.state.principals.filter(p => p.id !== id);
    requireThat(!pluginFilter || pluginFilter.every(id => this.plugins.isKnown(id)), 'invalid', 'Unknown MCP plugin filter.');
    await this.state.addPrincipal({ id, tokenHash: digest(token), projectId, label: externalSessionId, methods: [...new Set([...(profile ? ['capability.index', 'capability.resolve'] : ['protocol.describe', 'capability.list']), ...selected])], ...(profile ? { profile } : {}), ...(pluginFilter ? { pluginFilter } : {}) });
    const connection = { url: this.url, token, projectId, externalSessionId, methods: [...new Set([...(profile ? ['capability.index', 'capability.resolve'] : []), ...selected])], ...(profile ? { profile } : {}), ...(pluginFilter ? { pluginFilter } : {}), apiVersion: '2.0' as const };
    await atomicJson(file, connection); return connection;
  }
  private authenticate(req: http.IncomingMessage, method: string) {
    requireThat(req.headers.host === new URL(this.url).host, 'origin', 'Host header does not match the local service.');
    if (req.headers.origin) requireThat(req.headers.origin === this.url, 'origin', 'Origin is not authorized for this service.');
    const hash = digest((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const principal = this.state.principals.find(p => timingSafeEqual(Buffer.from(p.tokenHash, 'hex'), Buffer.from(hash, 'hex')));
    requireThat(principal, 'unauthorized', 'A valid local session credential is required.');
    requireThat(!principal.expiresAt || Date.parse(principal.expiresAt) > Date.now(), 'unauthorized', 'Browser session expired. Ask your Agent to open Rho again.');
    requireThat(principal.methods.includes(method === 'events' ? 'observation.snapshot' : method), 'unauthorized', 'Session does not authorize this operation.');
    return principal;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    let apiVersion = '2.0';
    try {
      requireThat(!this.closing, 'unavailable', 'The service is closing; preserve original identities and reconnect to observe.');
      const url = new URL(req.url ?? '/', this.url);
      requireThat(req.headers.host === new URL(this.url).host && (!req.headers.origin || req.headers.origin === this.url), 'origin', 'Host or Origin is not authorized for this local service.');
      if (url.pathname === '/api/browser/pair') {
        requireThat(req.headers.origin === this.url, 'origin', 'Pair from the same-origin browser entry.');
        requireThat(!url.search && req.method === 'POST' && req.headers['content-type']?.split(';')[0] === 'application/json', 'invalid', 'Pairing uses a same-origin JSON POST without URL credentials.');
        const body = await this.readBody(req, 1024);
        requireThat(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && 'code' in body, 'invalid', 'Pairing accepts only the one-time code.');
        this.json(res, 200, { apiVersion: '2.0', ok: true, value: await this.serial('browser:sessions', () => this.browser.pair(body.code)) }); return;
      }
      if (url.pathname.startsWith('/api/adapter/feedback.')) {
        const principal = this.authenticate(req, 'binding.activity.append');
        requireThat(!url.search && req.method === 'POST' && req.headers['content-type']?.split(';')[0] === 'application/json', 'invalid', 'Native adapter requests use bounded JSON POST without URL credentials.');
        const body = await this.readBody(req, 4096), mode = url.pathname.slice('/api/adapter/'.length);
        const fields = mode === 'feedback.pending' ? ['projectId', 'registrationId', 'externalSessionId'] : mode === 'feedback.step' ? ['projectId', 'registrationId', 'externalSessionId', 'submissionId'] : mode === 'feedback.next' ? ['projectId', 'registrationId', 'externalSessionId', 'nativeToolUseId'] : mode === 'feedback.emitted' ? ['projectId', 'registrationId', 'externalSessionId', 'nativeToolUseId', 'deliveryId'] : [];
        requireThat(fields.length && Object.keys(body).length === fields.length && fields.every(k => typeof body[k] === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(body[k])), 'invalid', 'Unknown or malformed native feedback entry.');
        const project = await this.state.project(body.projectId, principal), adapter = this.nativeAdapters.get(project.id + ':' + body.registrationId);
        requireThat(adapter && adapter.adapterPrincipal === principal.id && adapter.externalSessionId === body.externalSessionId && adapter.transportCapabilities.inboxLookup === true, 'scope', 'Feedback adapter does not match the original registered native session.');
        await this.feedbackProject(project.id);
        let value;
        if (mode === 'feedback.pending') value = await this.serial(project.id, () => this.feedback(project).pending(body.externalSessionId, body.registrationId));
        else if (mode === 'feedback.step') {
          const record = (await this.feedback(project).state()).records.find((r: any) => r.submission.submissionId === body.submissionId);
          requireThat(record?.submission.delivery?.adapterRegistrationId === body.registrationId && record.submission.delivery.externalSessionId === body.externalSessionId, 'scope', 'Worker step belongs to another original target.');
          value = await this.stepFeedback(project.id, body.submissionId);
        } else value = await this.serial(project.id, async () => {
          const bindings = await readJson<any[]>(path.join(await this.dataDir(project), 'bindings.json'), []);
          const binding = bindings.find(b => b.principal === adapter.principal && b.externalSessionId === adapter.externalSessionId && b.attachment?.adapterRegistrationId === adapter.registrationId);
          requireThat(binding, 'scope', 'Original feedback binding is unavailable.');
          const delivery = this.feedback(project);
          if (mode === 'feedback.emitted') return delivery.emitted(body.deliveryId, binding.id, body.externalSessionId, body.nativeToolUseId);
          const native = new (this.plugins.need('agent').NativeActivity)(project.root, project.id, this.config.agentNativeActivity);
          let cursor = null, known = false;
          do { const page = await native.read({ after: 0, cursor, limit: 100, maxBytes: 65536 }); known = page.entries.some((e: any) => e.bindingId === binding.id && e.event.kind === 'tool.requested' && e.event.nativeToolUseId === body.nativeToolUseId); cursor = page.next; } while (!known && cursor);
          requireThat(known, 'condition', 'Hook boundary has no retained original native tool request.');
          return delivery.next(binding.id, body.externalSessionId, body.nativeToolUseId, await new TaskRouting(project).read());
        });
        if (mode !== 'feedback.pending') await this.emit(project, 'feedback.changed', adapter.taskId);
        this.json(res, 200, { apiVersion: '2.0', ok: true, value }); return;
      }
      if (!url.pathname.startsWith('/api/')) {
        requireThat((req.method === 'GET' || req.method === 'HEAD') && !url.search, 'not_found', 'Use the same-origin browser entry without query credentials.');
        await serveWeb(url.pathname, res, this.config.webRoot, req.method === 'HEAD'); return;
      }
      const method = url.pathname.startsWith('/api/v2/') ? url.pathname.slice(8) : '';
      requireThat(method === 'events' || !!operations[method], 'not_found', 'Unknown API operation.');
      const principal = this.authenticate(req, method);
      if (method === 'events') { requireThat(req.method === 'GET', 'invalid', 'Events use GET.'); await this.subscribe(url, principal, res); return; }
      requireThat(req.method === 'POST' && req.headers['content-type']?.split(';')[0] === 'application/json', 'invalid', 'Use POST with application/json.');
      requireThat(method === 'events' || isRhoMethod(method), 'not_found', 'Unknown API operation.');
      const body = await this.readBody(req, this.config.maxRequestBytes ?? 1024 * 1024);
      // The one place untrusted JSON becomes a typed operation request. The value is
      // not reserialized, defaulted or coerced: what the caller sent is what the
      // handler receives, so a request digest and a duplicate delivery keep meaning.
      const read = readOperation(method, body);
      // A refusal by schema is still the caller's activity, or the record misses every
      // malformed Agent call. Only the method and the refusal are kept, nothing from a
      // body that failed its schema.
      if (!read.ok && principal.projectId) { const projectId = principal.projectId; await this.serial(projectId, () => this.recordActivity(principal, method, { projectId }, undefined, read.kind)); }
      requireThat(read.ok, read.ok ? 'invalid' : read.kind, read.ok ? '' : (read.problems[0]?.fix ? `Request does not match the versioned schema: ${read.problems[0].fix}` : 'Request does not match the versioned schema.'), read.ok ? {} : { problems: read.problems, remedy: 'Fix the named fields and resend the same request identity.' });
      const request = read.request, contractRef = typeof req.headers['x-rho-contract-ref'] === 'string' ? req.headers['x-rho-contract-ref'] : undefined;
      let value;
      if (body.projectId && method !== 'project.source.add') {
        value = await this.serial(body.projectId, async () => {
          try {
            const result = await this.dispatch(request, principal, contractRef);
            await this.recordActivity(principal, method, body, result); return result;
          } catch (e) {
            await this.recordActivity(principal, method, body, undefined, e instanceof Fault ? e.kind : 'storage'); throw e;
          }
        });
      } else value = await this.dispatch(request, principal, contractRef);
      this.json(res, 200, { apiVersion, ok: true, value });
    } catch (e: any) {
      // A filesystem refusal used to arrive as "could not be confirmed" with no
      // details, which reads as a bug in the application rather than as a folder the
      // process may not write. Name the condition and the next action instead.
      const fault = e instanceof Fault ? e : new Fault(...explainFailure(e));
      const status = fault.kind === 'unauthorized' ? 401 : ['origin', 'scope'].includes(fault.kind) ? 403 : fault.kind === 'not_found' ? 404 : fault.kind === 'invalid' ? 400 : fault.kind === 'limit' ? 413 : fault.status;
      this.json(res, status, { apiVersion, ok: false, error: { kind: fault.kind, message: fault.message, details: fault.details, continuation: ['stale', 'conflict', 'event_gap'].includes(fault.kind) ? 'Read the current owner snapshot and reconcile before another write.' : 'Inspect the stated condition; observe original operations without replaying actions.' } });
    }
  }
  private async readBody(req: http.IncomingMessage, max: number): Promise<any> {
    let size = 0; const chunks: Buffer[] = [];
    for await (const b of req.iterator({ destroyOnReturn: false })) { size += b.length; if (size > max) { req.resume(); throw new Fault('limit', 'Request exceeds the configured byte limit.', { limit: 'maxRequestBytes', maximum: max }); } chunks.push(b); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Fault('invalid', 'Request is not valid JSON.'); }
  }
  private json(res: http.ServerResponse, status: number, data: unknown) { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); } }
  private async serial<T>(key: string, execute: () => Promise<T>) {
    const count = this.queued.get(key) ?? 0;
    requireThat(count < (this.config.maxQueue ?? serviceLimits.maxQueue), 'limit', 'Project request queue is full; retain the original operation identity.', { limit: 'maxQueue', maximum: this.config.maxQueue ?? serviceLimits.maxQueue });
    this.queued.set(key, count + 1);
    const task = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(execute);
    this.queues.set(key, task);
    try { return await task; }
    finally { this.queued.set(key, (this.queued.get(key) ?? 1) - 1); if (this.queues.get(key) === task) this.queues.delete(key); }
  }
  private async recordActivity(principal: Principal, method: string, body: any, result: any, errorKind?: string) {
    if (!principal.projectId || method === 'binding.activity') return;
    const p = await this.state.project(body.projectId, principal), agent = this.plugins.project(p.root, p.id).agent;
    if (!agent) return;
    await agent.recordActivity(principal.id, method, body, result, errorKind);
    // Reads change no owner state, so this is the only event a browser gets for them.
    // The same project-scoped metadata is public in observation.snapshot. A
    // principal-only invalidation would hide reads from every browser subscriber.
    await this.emit(p, 'activity.changed', method);
  }
  // What the project's Agents did, for the person's screen (docs/INTERACTION-PLAN.md S7):
  // only principals whose grant names this project, only the fields the activity record
  // keeps. A grant is the scope; an Agent need not have opened a binding.
  private async projectActivity(p: Project) {
    const agent = this.plugins.project(p.root, p.id).agent;
    if (!agent) return { cursor: 0, retainedFrom: 1, entries: [] };
    const granted = new Set(this.state.principals.filter(x => x.projectId === p.id && x.kind !== 'browser').map(x => x.id));
    const all = await readJson<any>(path.join(await this.dataDir(p), 'activity.json'), { cursor: 0, entries: [] });
    return { cursor: all.cursor, retainedFrom: all.entries[0]?.cursor ?? all.cursor + 1, entries: all.entries.filter((e: any) => granted.has(e.principal)) };
  }
  // The Agent sessions with access to this project, as a person needs them: which session,
  // what it may call, its latest recorded call, and whether its access has ended.
  private async agentSummaries(p: Project) {
    const activity = await this.projectActivity(p);
    return this.state.principals.filter(x => x.projectId === p.id && x.kind !== 'browser' && x.id !== 'operator').map(x => {
      const last = activity.entries.filter((e: any) => e.principal === x.id).at(-1);
      return { principal: x.id, label: x.label ?? null, profile: x.profile ?? null, methods: x.methods, expiresAt: x.expiresAt ?? null, ended: !!x.expiresAt && Date.parse(x.expiresAt) <= Date.now(),
        last: last ? { at: String(last.at), method: String(last.method), outcome: last.outcome === 'rejected' ? 'rejected' as const : 'returned' as const, ...(last.operationId ? { operationId: String(last.operationId) } : {}) } : null };
    });
  }
  private async dataDir(p: Project) { return stateDirectory(p.root, '.rho/rho'); }
  // The discriminated union is what gives every branch below a typed body: after the
  // `method` comparison TypeScript narrows `request`, so `b` is that operation's own
  // input type. `RhoOutput<RhoMethod>` is the published response union; the concrete
  // response type is checked by the contract test that validates real replies.
  // `request` is the discriminated union of every published operation, so each branch
  // below sees that operation's own input type. What a branch returns is validated
  // against the published response schema by the contract tests that drive real
  // traffic; the service does not restate the owner's value types as its own.
  async dispatch(request: OperationRequest, principal: Principal, contractRef?: string): Promise<unknown> {
    const { method } = request;
    // Narrowed per branch; see the comment above for why the response side is checked
    // by contract validation rather than by this signature.
    const b: any = request.body;
    requireThat(this.state.principals.some(current => current.id === principal.id && current.tokenHash === principal.tokenHash && current.methods.includes(method) && (!current.expiresAt || Date.parse(current.expiresAt) > Date.now())), 'unauthorized', 'Session authorization expired or was revoked before this operation.');
    if (method === 'protocol.describe') return describeProtocol(protocol, principal.methods, b);
    // A dry run of any operation body: the same schema the server enforces, with the
    // edit each problem needs. Nothing is executed and no project is touched.
    if (method === 'protocol.validate') {
      const target = String(b.method ?? '');
      requireThat(target !== 'protocol.validate', 'invalid', 'Validate another operation, not this one.');
      const validator = validators[target];
      requireThat(validator, 'not_found', `Unknown API operation "${target}".`, { remedy: 'Call protocol.describe for the accepted method names.' });
      const problems = validator(b.body) ? [] : explainSchema(validator.errors);
      return { method: target, valid: problems.length === 0, problems, requires: operations[target].required ?? [] };
    }
    if (method.startsWith('session.browser.')) {
      requireThat(principal.id === 'operator', 'unauthorized', 'Only the local operator may pair or revoke browser sessions.');
      if (method === 'session.browser.pair') return this.serial('browser:sessions', async () => this.browser.createPairing(await confined(this.state.root, b.path ?? '.')));
      const result = await this.serial('browser:sessions', () => this.state.revokeBrowser(b.sessionId));
      for (const s of this.subscribers) if (s.principal === b.sessionId) s.response.end('event: session.invalid\ndata: {}\n\n');
      return result;
    }
    if (method === 'project.list') return this.state.projects.filter(p => this.state.visible(p, principal));
    if (method === 'project.createWorkspace') return this.serial('projects', async () => {
      const project = await this.state.createWorkspace(b.name, b.selectionIds, b.changeId, principal, this.config.nativeFolders?.maxProjects ?? nativeFolderLimits.maxProjects, this.config.nativeFolders?.maxSources ?? nativeFolderLimits.maxSources);
      this.plugins.sourceFolders.set(project.id, project.sources!); return project;
    });
    if (method === 'project.pick' || method === 'project.source.pick' || method === 'project.source.add') {
      requireThat(principal.kind === 'browser', 'unauthorized', 'Only an authenticated browser tab may ask the person to select a folder.');
      requireThat(!this.pickingFolder, 'conflict', 'A system folder window is already open. Finish or cancel it before opening another.');
      if (method === 'project.source.add') await this.state.project(b.projectId, principal);
      this.pickingFolder = true;
      try {
        const home = homedir(), root = principal.projectRoot ?? this.state.root;
        const chosen = await this.folderPicker.choose(root === home || root.startsWith(home + path.sep) ? root : home);
        if (chosen === null) return method === 'project.source.pick' ? { cancelled: true, selection: null } : { cancelled: true, project: null };
        requireThat(!this.closing, 'unavailable', 'Rho is closing. No selected folder was opened.');
        if (method === 'project.source.pick') return { cancelled: false, selection: await this.state.selectFolder(chosen, principal, this.config.nativeFolders?.selectionTtlMs ?? nativeFolderLimits.selectionTtlMs, this.config.nativeFolders?.maxSelections ?? nativeFolderLimits.maxSelections) };
        if (method === 'project.source.add') {
          const target = await this.state.project(b.projectId, principal);
          const project = await this.serial(target.id, () => this.serial('projects', () => this.state.addSource(target, chosen, principal, this.config.nativeFolders?.maxSources ?? nativeFolderLimits.maxSources)));
          this.plugins.sourceFolders.set(project.id, project.sources!);
          await this.emit(project, 'project.sources.changed', project.id);
          return { cancelled: false, project };
        }
        const project = await this.serial('projects', () => this.state.openSelected(chosen, principal, this.config.nativeFolders?.maxProjects ?? nativeFolderLimits.maxProjects));
        return { cancelled: false, project };
      } finally { this.pickingFolder = false; }
    }
    if (method === 'project.create' || method === 'project.open') return this.serial('projects', async () => {
      const root = principal.projectRoot ?? this.state.root;
      const relative = method === 'project.create' ? b.name : b.path;
      requireThat(!relative.split(/[\\/]/).some((part: string) => ['.rho', '.git'].includes(part)), 'scope', 'Internal owner state is not a project.');
      const target = await confined(root, relative, method === 'project.create');
      // mkdir is not recursive, so an existing folder is reported, never adopted as a new project.
      if (method === 'project.create') await fs.mkdir(target).catch(e => { throw e.code === 'EEXIST' ? new Fault('conflict', 'A folder with that name already exists; open it instead.', { name: relative }) : e; });
      const p = await this.state.open(path.relative(this.state.root, target) || '.');
      return method === 'project.create' ? p : { ...p, host: await this.bridge.capability(p.root) };
    });
    const p = await this.state.project(b.projectId, principal);
    const owners = this.plugins.project(p.root, p.id);
    const requests = new Requests(p, this.bridge, (type, subject) => this.emit(p, type, subject), this.config, owners);
    const workspace = new Workspace(p, owners, this.config.workspace, this.config.interactions);
    const interactions = new Interactions(p, owners, this.config.interactions);
    const routing = new TaskRouting(p, this.config.capabilityLimits?.maxReceipts, this.config.maxRetainedMetadataBytes);
    // A person's own view of the folder they selected. The tab is confined to this one
    // project, so it may list that folder and open a text file from it; registering
    // resources and execution stay Agent/operator work.
    // One call answers "why does nothing work here", before any work is attempted,
    // and it changes nothing: no Host is started and no run is resumed.
    // The person owns the project, so they may see what it is running. The summary is
    // deliberately narrow: no request body, no code, no output text.
    if (method === 'project.runs') {
      const limit = Number(b.limit ?? 20);
      const all = await requests.all();
      const runs = [...all].sort((l, r) => r.acceptedAt.localeCompare(l.acceptedAt));
      return {
        runs: await Promise.all(runs.slice(0, limit).map(run => runFacts(p, run))),
        total: runs.length,
        truncated: runs.length > limit
      };
    }
    if (method === 'project.doctor') {
      const checks: Array<{ id: string; state: 'ok' | 'warn' | 'fail'; detail: string; remedy: string }> = [];
      const add = (id: string, state: 'ok' | 'warn' | 'fail', detail: string, remedy = '') => checks.push({ id, state, detail, remedy });
      // Write access is the check that a restricted sandbox fails, silently, at the
      // first picker instead of here.
      for (const [id, directory] of [['project-write', p.root], ['state-write', this.state.directory]] as const) {
        const probe = path.join(directory, '.rho-doctor-' + randomBytes(6).toString('hex'));
        try { await fs.writeFile(probe, 'probe', { mode: 0o600 }); await fs.unlink(probe); add(id, 'ok', `Rho can write in ${directory}.`); }
        catch (e: any) { add(id, 'fail', `Rho cannot write in ${directory} (${e.code ?? e.message}).`, 'Grant this process write access to that folder, or start Rho outside a restricting sandbox.'); }
      }
      const core = await this.bridge.capability(p.root);
      const socket = path.join(p.root, '.rho/host.sock');
      if (core.exitCode === 0) {
        const executors: any[] = core.reply.value.executors ?? [];
        const r = executors.find(x => x.name === 'r');
        add('core', 'ok', `A Core Host is serving this project (${r?.program ?? 'no R executor'}).`);
        if (!r || r.program !== this.bridge.rscript) add('core-executor', 'warn', `The running Host's R executor is ${r?.program ?? 'absent'}, not ${this.bridge.rscript}.`, 'Stop that Host or start Rho with the same --rscript it was given.');
      } else if (await fs.lstat(socket).then(() => true, () => false)) {
        add('core', 'warn', `A socket remains at ${socket} but no Host answers.`, 'Stop the service that owned it, or remove the stale socket after inspecting the original requests.');
      } else add('core', 'ok', 'No Host is running; the first execution starts one.');
      const rscriptAvailable = await fs.access(this.bridge.rscript, fs.constants.X_OK).then(() => true, () => false);
      add('rscript', rscriptAvailable ? 'ok' : 'fail', rscriptAvailable ? `R is available at ${this.bridge.rscript}.` : `R is unavailable at ${this.bridge.rscript}.`, rscriptAvailable ? '' : 'Select an existing Rscript with --rscript or RHO_RSCRIPT.');
      const runs = await requests.list(principal).catch(() => []);
      const unfinished = runs.filter(run => ['active', 'unobserved', 'unknown'].includes(run.execution));
      add('runs', unfinished.length ? 'warn' : 'ok', unfinished.length ? `${unfinished.length} run(s) have no settled outcome: ${unfinished.slice(0, 3).map(run => run.operationId).join(', ')}.` : 'No run needs attention.', unfinished.length ? 'Read each run with action.lookup before submitting anything again.' : '');
      const catalog: any = await new Capabilities(this.plugins, p).catalog(principal).catch(() => null);
      const owners: any[] = catalog?.plugins ?? [];
      const absent = owners.filter(entry => entry.packagePresent === false).map(entry => entry.id);
      const disabled = owners.filter(entry => entry.projectEnabled === false).map(entry => entry.id);
      add('plugins', absent.length ? 'fail' : 'ok',
        absent.length ? `Selected owners are not installed: ${absent.join(', ')}.` : disabled.length ? `Installed owners are disabled for this project: ${disabled.join(', ')}.` : 'Every selected owner is installed and enabled.',
        absent.length ? 'Install the missing owner packages, or select fewer with --plugins.' : disabled.length ? 'Enable them with capability.configure if this project needs them.' : '');
      // An intent answers "what do I need to do this here", so a session grant is
      // chosen from the contract instead of assembled by trial and error.
      const needs: Record<string, string[]> = {
        'run-r': ['action.submit', 'action.lookup', 'artifact.check', 'document.open', 'document.save', 'resource.register'],
        'edit-documents': ['document.open', 'document.read', 'document.edit', 'document.save', 'document.undoOwn'],
        'inspect-tables': ['resource.register', 'data.page', 'data.plot'],
        'present': ['composition.apply', 'capability.list']
      };
      const intent = b.intent ? needs[b.intent] : undefined;
      const answer = !b.intent ? null : {
        id: b.intent,
        methods: intent ?? [],
        missing: (intent ?? []).filter(method => !(principal.methods ?? []).includes(method)),
        ready: checks.every(check => check.state !== 'fail')
      };
      return { ok: checks.every(check => check.state !== 'fail'), checks, intent: answer };
    }
    if (method === 'project.entries') {
      const limit = this.config.nativeFolders?.maxEntries ?? 500;
      // Confined to the project root: a requested subfolder is resolved, never escaped.
      const requested: string = b.path ?? '.';
      let directory: string;
      try { directory = await confined(p.root, requested); }
      catch { requireThat(false, 'scope', 'Only folders inside this project can be listed.'); }
      const canonical = await fs.realpath(directory);
      requireThat(canonical === p.root || canonical.startsWith(p.root + path.sep), 'scope', 'Only folders inside this project can be listed.');
      requireThat((await fs.lstat(canonical)).isDirectory(), 'invalid', 'That entry is a file, not a folder.');
      const relative = path.relative(p.root, canonical).split(path.sep).join('/');
      let names: string[] = [];
      try { names = await fs.readdir(canonical); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      const entries: Array<{ path: string; name: string; kind: 'file' | 'folder'; bytes: number; hidden: boolean }> = [];
      for (const name of names.sort((a, c) => a.localeCompare(c))) {
        if (['.rho', '.git', '.DS_Store'].includes(name)) continue;
        const stat = await fs.lstat(path.join(canonical, name)).catch(() => null);
        if (!stat || stat.isSymbolicLink()) continue;
        const kind = stat.isDirectory() ? 'folder' as const : stat.isFile() ? 'file' as const : null;
        if (!kind) continue;
        const entryPath = (relative ? relative + '/' : '') + name;
        entries.push({ path: entryPath, name, kind, bytes: kind === 'file' ? stat.size : 0, hidden: name.startsWith('.') });
      }
      return { entries: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit, roots: [relative || '.'], path: relative };
    }
    if (method === 'project.openFile') {
      const document = await owners.need('documents').open(b.path, principal.id);
      const components: any[] = (owners as any).assembly?.catalog?.components ?? [];
      const editor = components.filter(component => component.id === 'rho.editor').sort((a, c) => c.version.localeCompare(a.version))[0];
      requireThat(editor, 'unavailable', 'This build selects no document editor, so the file was opened but cannot be shown.');
      // One editor per document: every view already bound to this document is folded into
      // a single one, so opening the same file twice never stacks duplicate tabs.
      // No layout yet is the first open, not a missing record: start one. A missing
      // layout arrives as a bare ENOENT, so the code is checked structurally rather
      // than by class or kind.
      const current = await workspace.read(b.compositionId).catch(error => {
        const { kind, code } = (error ?? {}) as any;
        if (kind === 'not_found' || code === 'ENOENT') return null;
        throw error;
      });
      const rootId: string = current?.rootId ?? 'root';
      const existing: any[] = current?.nodes ?? [];
      const sameDocument = existing.filter(node => node.kind === 'view' && node.bindings?.document?.documentId === document.id
        && (node.bindings.document.kind === 'live-document' || node.bindings.document.version === document.version));
      const viewId = sameDocument[0]?.id ?? 'doc-' + document.id.slice(0, 12);
      const folded = new Set(sameDocument.map(node => node.id as string));
      const group = existing.find(node => node.id === rootId && node.kind === 'group') ?? { id: rootId, kind: 'group', children: [] };
      const kept = existing.filter(node => node.id !== rootId && !folded.has(node.id));
      const children = [...(group.children as string[]).filter((id: string) => !folded.has(id) && id !== viewId), viewId];
      const view = { id: viewId, kind: 'view' as const, component: editor.id as string, version: editor.version as string, props: { title: path.basename(document.path) }, bindings: { document: { kind: 'live-document' as const, documentId: document.id } } };
      const composition = await workspace.apply({ compositionId: b.compositionId, expectedVersion: b.expectedVersion, changeId: b.changeId, operations: [{ op: 'replace', rootId, nodes: [{ ...group, children }, ...kept, view] }] }, principal.id);
      await this.emit(p, 'composition.changed', b.compositionId);
      return { document, viewId, composition };
    }
    if (method === 'session.grant') {
      requireThat(principal.id === 'operator', 'unauthorized', 'Only the local operator may provision a project-scoped session.');
      const file = path.join(this.state.directory, 'agent-' + digest(p.id + ':' + b.externalSessionId) + '.json');
      const connection = await this.agentConnection(p.id, b.externalSessionId, file, b.methods, undefined, b.profile);
      return { profile: connection.profile, connectionFile: file, projectId: p.id, methods: connection.methods, transport: 'stdio-mcp', externalSessionId: b.externalSessionId };
    }
    const capabilities = new Capabilities(this.plugins, p);
    if (method === 'capability.index' || method === 'capability.resolve' || contractRef) {
      const route = await routing.read(), bindings = await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), []);
      const reader = new Discovery(this.plugins, p, principal, route, bindings);
      if (contractRef) { requireThat(/^[a-f0-9]{64}$/.test(contractRef), 'invalid', 'Malformed selected contract reference.'); await reader.assertContract(method, contractRef); }
      if (method === 'capability.index') return reader.index(b);
      if (method === 'capability.resolve') return reader.resolve(b);
    }
    if (method === 'capability.list') return { ...await capabilities.catalog(principal), host: await this.bridge.capability(p.root) };
    if (method === 'capability.configure') { const result = await capabilities.configure(b, principal.id); await this.emit(p, 'capability.changed', p.id); return result; }
    if (method === 'skill.list') return capabilities.skills(principal);
    if (method === 'skill.read') return capabilities.readSkill(principal, b.skillId, b.expectedDigest);
    if (method === 'view.observe' || method === 'view.observations.read') {
      requireThat(principal.id === 'operator' || principal.kind === 'browser', 'unauthorized', 'Only the scoped renderer may submit or inspect DOM receipts.');
      if (method === 'view.observe') requireThat(principal.kind === 'browser', 'unauthorized', 'DOM observations require the authenticated browser tab; operator diagnostics are read-only.');
      const route = await routing.read();
      requireThat(route?.taskId === b.taskId && route.compositionId === b.compositionId && (principal.id === 'operator' || b.clientId === principal.id), 'scope', 'Visibility request belongs to another task or renderer.');
      const display = new Presentation(p, workspace, this.config.presentationWitness, this.config.visibility);
      if (method === 'view.observations.read') return display.read(b, principal.id);
      if (b.evidence === 'dom-visible') requireThat(await capabilities.isAvailable('data.page'), 'unavailable', 'Visible table evidence needs the currently enabled Tables owner.');
      const renderer = await readJson<any>(path.join(this.config.webRoot ?? webRoot, 'renderer.json'), null);
      requireThat(renderer?.rendererBuild === b.rendererBuild, 'condition', 'DOM receipt renderer differs from the selected browser build.');
      return display.observe(b, principal.id, route);
    }
    // Source ports see the same effective project selection as direct methods.
    // Thus a composition/context cannot use a disabled provider indirectly.
    const selection = await capabilities.state();
    for (const [port, method] of Object.entries({ documents: 'document.read', files: 'resource.read', tables: 'data.page', charts: 'data.plot', media: 'media.describe', objects: 'object.read', annotations: 'annotation.read' })) {
      if (!await capabilities.isAvailable(method, selection)) (owners as any)[port] = undefined;
    }
    if (method === 'workspace.observe' || method === 'workspace.enhance') {
      await capabilities.assertAvailable(method, principal);
      const route = await routing.read(), binding = (await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), [])).find(x => x.id === route?.presenter?.bindingId);
      requireThat(principal.profile === 'layered-presentation' && binding?.principal === principal.id && binding.attachment?.role === 'presentation' && route.taskId === b.taskId && route.compositionId === b.compositionId, 'scope', 'This principal is not the assigned presenter for this task/layout.');
      const display = new Presentation(p, workspace, this.config.presentationWitness, this.config.visibility);
      if (method === 'workspace.observe') return display.projection(b, route, principal.id);
      requireThat(b.presenterBindingId === binding.id, 'scope', 'Enhancement names another presentation binding.');
      const result = await display.enhance(b, route, principal.id); await this.emit(p, 'composition.changed', b.compositionId); return result;
    }
    if (method === 'task.routing.put') {
      requireThat(principal.id === 'operator', 'unauthorized', 'Only the existing control plane assigns tasks.');
      requireThat(await capabilities.isAvailable('binding.open', selection), 'unavailable', 'Enable the selected Agent entry before assigning native task routing.');
      const bindings = await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), []);
      owners.need('agent');
      if (!await routing.read()) await new (this.plugins.need('agent').NativeActivity)(p.root, p.id, this.config.agentNativeActivity).initialize();
      const result = await routing.put(b, principal.id, bindings);
      await this.emit(p, 'task.routing.changed', b.taskId); return result;
    }
    // Redelivery of a retained native intent is an observation, even after its
    // provider is disabled. Requests verifies the complete original payload.
    const retainedSubmit = ['action.submit', 'requirements.prepare'].includes(method) && await requests.lookup(principal, b.operationId).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
    if (!retainedSubmit) await capabilities.assertAvailable(method, principal);
    if (method === 'requirements.check') return this.plugins.need('requirements').checkRequirements(p.root, b.requirements, this.bridge.rscript);
    if (method === 'requirements.prepare') return publicOperation(await requests.submit(principal, b, true));
    if (method === 'action.submit') return publicOperation(await requests.submit(principal, b));
    if (method === 'action.lookup') return publicOperation(await requests.lookup(principal, b.operationId, true));
    if (method === 'action.observe') return publicOperation(await requests.observe(principal, b.operationId));
    if (method === 'action.retry') return publicOperation(await requests.retry(principal, b.operationId));
    if (method === 'action.cancel') return publicOperation(await requests.cancel(principal, b.operationId));
    if (method === 'action.output') return requests.output(principal, b.operationId, b.stream, b.offset, b.maxBytes);
    if (method === 'action.list') return (await requests.list(principal)).map(publicOperation);
    if (method === 'resource.list') return requests.artifacts(principal, b.operationId);
    if (method === 'artifact.check') return requests.check(principal, b.operationId);
    if (method === 'resource.register') {
      requireThat(!b.declaration.path.split('/').some((part: string) => ['.rho', '.git'].includes(part)), 'scope', 'Register a project file outside internal state.');
      return publicResource(await owners.need('files').register(b.declaration.path, { operationId: 'registration:' + digest(canonical(b.declaration)), registeredBy: principal.id }, 'available', {}, b.declaration, b.expectedDigest));
    }
    if (method === 'object.read') return owners.need('objects').read(b.resource);
    if (method === 'media.describe') return owners.need('media').describe(b.resource);
    if (method === 'resource.read') return owners.need('files').read(b.resource, b.offset, b.maxBytes);
    if (method === 'data.page') return owners.need('tables').page(b.resource, b.offset, b.limit, b.sort, b.filter);
    if (method === 'data.plot') return owners.need('charts').plot(b.resource, b.x, b.y, b.maxPoints);
    if (method === 'data.compare') return owners.need('tables').compare(b.left, b.right, b.options);
    if (['composition.apply', 'composition.undo', 'view.protection.set'].includes(method)) {
      const result = await workspace.apply(b, principal.id, method === 'composition.undo' ? 'undo' : method === 'view.protection.set' ? 'protect' : 'apply');
      const route = await routing.read();
      if (route) {
        try { result.witness = await new Presentation(p, workspace, this.config.presentationWitness, this.config.visibility).captureLayout(result, route); result.witnessState = result.witness ? 'retained' : 'expired'; }
        catch { result.witness = null; result.witnessState = 'pending'; }
        result.commitVersion = result.receipt.version; result.currentVersion = result.version;
      }
      await this.emit(p, 'composition.changed', b.compositionId); return result;
    }
    if (method.startsWith('task.map.')) {
      const map = new TaskMap(p, this.config.taskMap);
      if (method === 'task.map.read') return map.read();
      // The Agent declares what the task is; people answer for their own screen.
      if (method === 'task.map.declare') requireThat(principal.kind !== 'browser', 'unauthorized', 'Only the Agent declares task items and their words.');
      if (method === 'task.map.respond') requireThat(principal.kind === 'browser', 'unauthorized', 'Only a person in a browser tab pins, reverts or answers suggestions.');
      const result = method === 'task.map.declare' ? await map.declare(b, principal.id) : method === 'task.map.present' ? await map.present(b, principal.id, principal.kind === 'browser') : await map.respond(b, principal.id);
      await this.emit(p, 'task.map.changed', p.id); return result;
    }
    if (method === 'interaction.selection.read') return interactions.read(b.scope, principal.id);
    if (method === 'interaction.selection.set') {
      const result = await interactions.set(b, principal.id); await this.emit(p, 'interaction.selection.changed', result.key, b.scope.kind === 'shared' ? undefined : principal.id); return result;
    }
    if (method.startsWith('annotation.')) {
      const a = owners.need('annotations');
      if (method === 'annotation.read') return a.read(b.annotationId);
      if (method === 'annotation.list') return a.list();
      const result = method === 'annotation.create' ? await a.create(b, principal.id) : await a.reply(b, principal.id);
      await this.emit(p, 'annotation.changed', b.annotationId); return result;
    }
    if (method === 'composition.put') { const result = await workspace.put(b); await this.emit(p, 'composition.changed', b.compositionId); return result; }
    if (method === 'composition.read') return workspace.read(b.compositionId);
    if (method === 'view.close') { const result = await workspace.closeView(b.compositionId, b.viewId, b.expectedVersion, b.changeId, principal.id); await this.emit(p, 'view.closed', b.viewId); return result; }
    if (['workspace.save', 'workspace.export', 'workspace.restore'].includes(method)) requireThat(!await routing.read(), 'condition', 'Existing workspace formats omit active native-task metadata/history; do not claim a complete checkpoint or restore over it.');
    if (method === 'workspace.save') return workspace.save(b.format);
    if (method === 'workspace.export') return workspace.export(b.destination, b.format);
    if (method === 'workspace.restore') { const result = await workspace.restore(b.source, principal.id); await this.emit(p, 'workspace.restored', p.id); return result; }
    if (method === 'selection.set') {
      const data = await owners.need('tables').rows(b.resource);
      requireThat(data.entityKey, 'condition', 'Selection requires an explicit unique key and namespace.');
      requireThat(b.entities.every((id: string) => data.rows.some(r => r[data.entityKey!] === id)), 'stale', 'One or more selected entities are absent from this resource version.');
      const selection = { resource: b.resource, entities: [...new Set(b.entities)], namespace: data.namespace, at: now() };
      await atomicJson(path.join(await this.dataDir(p), 'selection.json'), selection); await this.emit(p, 'selection.changed', b.resource.id); return selection;
    }
    if (method.startsWith('document.')) {
      const d = owners.need('documents'); let result;
      if (method === 'document.open') result = await d.open(b.path, principal.id);
      if (method === 'document.read') result = await d.read(b.documentId);
      const change = b.changeId === undefined ? undefined : { changeId: b.changeId, expectedRevision: b.expectedRevision };
      if (principal.kind === 'browser' && method === 'document.undo') requireThat(false, 'unavailable', 'Browser undo uses document.undoOwn; global undo is not a keyboard action.');
      if (principal.kind === 'browser' && ['document.edit', 'document.undoOwn', 'document.revert', 'document.save', 'document.abandonSave'].includes(method)) requireThat(change, 'invalid', 'Browser document writes require changeId and expectedRevision.');
      if (method === 'document.edit') result = await d.edit(b.documentId, b.expectedVersion, b.edits, b.undoGroup, principal.id, change);
      if (method === 'document.undo') result = await d.undo(b.documentId, b.expectedVersion, principal.id, change);
      if (method === 'document.undoOwn') result = await d.undoOwn(b.documentId, b.expectedVersion, principal.id, change!);
      if (method === 'document.revert') result = await d.revert(b.documentId, b.expectedVersion, b.targetChangeId, principal.id, change!);
      if (method === 'document.history') result = await d.history(b.documentId);
      if (method === 'document.change.read') result = await d.readChange(b.documentId, b.targetChangeId);
      if (method === 'document.save') result = await d.save(b.documentId, b.expectedVersion, b.expectedDiskDigest, principal.id, change);
      if (method === 'document.abandonSave') result = await d.abandonSave(b.documentId, b.expectedVersion, b.pendingRequestDigest, principal.id, change!);
      if (!['document.read', 'document.open', 'document.history', 'document.change.read'].includes(method)) await this.emit(p, 'document.changed', b.documentId);
      return result;
    }
    if (method === 'binding.activity.append' || method === 'binding.activity' && b.source === 'native') {
      owners.need('agent');
      const route = await routing.read();
      requireThat(route?.taskId === b.taskId, 'scope', 'Native activity belongs to the configured task.');
      const native = new (this.plugins.need('agent').NativeActivity)(p.root, p.id, this.config.agentNativeActivity);
      if (method === 'binding.activity') {
        const participants = await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), []);
        requireThat(principal.id === 'operator' || route.participants.some((x: any) => participants.some(v => v.id === x.bindingId && v.principal === principal.id && v.attachment?.role === 'business')), 'scope', 'This principal cannot read the task native history.');
        return native.read(b.query);
      }
      const registration = this.nativeAdapters.get(p.id + ':' + b.adapterId);
      requireThat(registration && registration.adapterPrincipal === principal.id && registration.taskId === b.taskId, 'unauthorized', 'Only the registered native adapter may append these observations.');
      const binding = (await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), [])).find(x => x.id === b.bindingId);
      requireThat(binding?.principal === registration.principal && binding.externalSessionId === registration.externalSessionId && binding.attachment?.adapterRegistrationId === b.adapterId && route.participants.some((x: any) => x.bindingId === b.bindingId), 'scope', 'Native event binding/session/task association changed.');
      requireThat(b.events.every((e: any) => e.kind !== 'artifact.ready' || e.output.policyRef === route.policyRef), 'condition', 'Output policy does not match the configured task.');
      requireThat(binding.attachment.role === 'business' || b.events.every((e: any) => e.kind !== 'artifact.ready'), 'scope', 'Presentation observers cannot publish business artifacts.');
      const result = await native.append(b);
      if (await routing.feedbackInitialized()) for (const event of b.events) if (event.kind === 'tool.returned' && event.fetchId) await this.feedback(p, owners).returnedFetch(b.bindingId, event.fetchId, event.nativeToolUseId, event.at);
      // A real artifact hint is the trigger. No model, timer or later polling
      // call is required between owner validation and base composition.
      for (const accepted of result.accepted) if (b.events.some((e: any) => e.sourceSeq === accepted.sourceSeq && e.kind === 'artifact.ready')) {
        try { await this.observeNativeOutputLocked(p, accepted.eventId); }
        catch (e) { /* Source receipt remains authoritative; explicit re-observation can reconcile presentation. */ }
      }
      await this.emit(p, 'binding.native.changed', b.taskId); return result;
    }
    if (method === 'binding.activity') return owners.need('agent').activity(principal.id);
    if (method === 'binding.list') return owners.need('agent').bindings(principal.id);
    if (method.startsWith('binding.')) {
      if (b.attachment) {
        const registration = this.nativeAdapters.get(p.id + ':' + b.attachment.adapterRegistrationId);
        requireThat(registration?.principal === principal.id && registration.externalSessionId === b.externalSessionId && registration.taskId === b.attachment.taskId && b.attachment.role === (principal.profile === 'layered-presentation' ? 'presentation' : 'business') && canonical(registration.transportCapabilities) === canonical(b.attachment.transportCapabilities), 'scope', 'Attachment needs matching registered native evidence, role and capabilities.');
      }
      const result = await owners.need('agent').binding(method, principal.id, b.externalSessionId, b.attachment);
      await this.emit(p, 'binding.changed', result.id); return result;
    }
    if (method.startsWith('feedback.')) {
      requireThat(await routing.feedbackInitialized(), 'unavailable', 'Select feedback for this task before using it.');
      const delivery = this.feedback(p, owners), route = await routing.read();
      requireThat(route?.taskId === b.taskId, 'scope', 'Feedback belongs to another task.');
      if (method === 'feedback.submit') {
        requireThat(principal.kind === 'browser', 'unauthorized', 'Feedback submission uses the authenticated teacher tab.');
        if (b.relatedDocumentId) await owners.need('documents').read(b.relatedDocumentId);
        const result = await delivery.submit(b, principal.id, route); await this.emit(p, 'feedback.changed', b.submissionId); return result;
      }
      if (method === 'feedback.read') {
        const result = await delivery.read(b, principal.id); await this.emit(p, 'feedback.changed', b.deliveryId); return result;
      }
      return delivery.status(b, principal.id, principal.id === 'operator');
    }
    if (method === 'context.create') {
      const facts = b.run ? { run: await runContext(p, requests, principal, b.run.operationId) } : {};
      const result = await owners.need('agent').createContext(b, principal.id, facts); await this.emit(p, 'context.changed', result.contextId, principal.id); return result;
    }
    if (method === 'context.read') {
      if (await routing.feedbackInitialized()) {
        const targetId = await this.feedback(p, owners).contextTarget(b.contextId);
        if (targetId) {
          const binding = (await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), [])).find(x => x.id === targetId);
          requireThat(binding?.principal === principal.id, 'scope', 'This context belongs to the original business binding.');
          throw new Fault('condition', 'Use feedback.read with the original delivery and fetch ID to retain its exact receipt.');
        }
      }
      const result = await owners.need('agent').readContext(b.contextId, principal.id); await this.emit(p, 'context.changed', result.contextId, principal.id); if (result.principal !== principal.id) await this.emit(p, 'context.changed', result.contextId, result.principal); return result;
    }
    if (method === 'observation.snapshot') return { project: p, catalog: await capabilities.catalog(principal), documents: await owners.documentSummaries(), operations: (await requests.list(principal)).map(publicOperation), resources: (await owners.retainedResources()).map(publicResource), compositions: await workspace.compositions(), feedback: await routing.feedbackConfiguration().then(async configuration => { const route = await routing.read(); return configuration ? { taskId: route.taskId, compositionId: route.compositionId, taskVersion: route.version, targetBindingId: route.feedbackOwnerBindingId, draftDocumentId: configuration.draftDocumentId, relatedDocumentId: configuration.relatedDocumentId } : null; }), presentation: await routing.read().then(async route => route ? { taskId: route.taskId, pending: (await new Presentation(p, workspace, this.config.presentationWitness, this.config.visibility).state()).pending ?? null, witnesses: await new Presentation(p, workspace, this.config.presentationWitness, this.config.visibility).witnesses() } : null), interactions: await interactions.list(principal.id), taskMap: await new TaskMap(p, this.config.taskMap).read(), annotations: await owners.retainedAnnotations(), contexts: await owners.agent?.contextStates(principal.id) ?? [], activity: await this.projectActivity(p), agents: await this.agentSummaries(p), selection: await readJson(path.join(await this.dataDir(p), 'selection.json'), null), bindings: (await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), [])).filter(x => x.principal === principal.id), cursor: (await this.events(p)).cursor, host: await this.bridge.capability(p.root), limits: { ...serviceLimits, ...requestLimits, documents: owners.documents?.limits ?? {}, r: this.plugins.optional('r') ? { ...this.plugins.need('r').executionLimits, ...this.config.r } : {}, resources: { ...owners.files?.limits, ...owners.tables?.limits, ...owners.charts?.limits }, ...Object.fromEntries(Object.entries(this.config).filter(([, v]) => typeof v === 'number')) } };
    throw new Fault('unavailable', 'This catalog operation has not been installed.', { operation: method });
  }
  private async events(p: Project) { return readJson<any>(path.join(await this.dataDir(p), 'events.json'), { cursor: 0, events: [] }); }
  async emit(p: Project, type: string, subject: string, principal?: string) {
    let event: any;
    try {
      const retained = await this.events(p); event = { cursor: ++retained.cursor, type, subject, projectId: p.id, at: now(), ...(principal ? { principal } : {}) };
      retained.events.push(event); retained.events = retained.events.slice(-(this.config.eventRetention ?? 256));
      await atomicJson(path.join(await this.dataDir(p), 'events.json'), retained);
    }
    catch {
      // Durable owner state is not rolled back by failure of its invalidation
      // channel. Interrupt all project observers so they must resnapshot.
      for (const s of this.subscribers) if (s.projectId === p.id) {
        s.response.end('event: gap\ndata: {"kind":"event_gap","continuation":"Read observation.snapshot"}\n\n'); this.subscribers.delete(s);
      }
      return;
    }
    for (const s of this.subscribers) if (s.projectId === p.id && (!principal || s.principal === principal)) {
      if (!this.observationAuthorized(s.principal, s.tokenHash)) { s.response.end('event: session.invalid\ndata: {}\n\n'); this.subscribers.delete(s); }
      else if (s.response.writableLength > (this.config.maxEventBytes ?? 65536)) { s.response.end('event: gap\ndata: {"kind":"event_gap","continuation":"Read observation.snapshot"}\n\n'); this.subscribers.delete(s); }
      else s.response.write('id: ' + event.cursor + '\nevent: ' + type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    }
  }
  private async subscribe(url: URL, principal: Principal, response: http.ServerResponse) {
    const project = await this.state.project(url.searchParams.get('projectId') ?? '', principal);
    return this.serial(project.id, () => this.openSubscription(project, url, principal, response));
  }
  private async openSubscription(project: Project, url: URL, principal: Principal, response: http.ServerResponse) {
    requireThat(!this.closing, 'unavailable', 'The service is closing; reconnect only observes the original project.');
    requireThat(this.observationAuthorized(principal.id, principal.tokenHash), 'unauthorized', 'Observation authorization expired or was revoked.');
    const after = Number(url.searchParams.get('after') ?? 0);
    requireThat(Number.isSafeInteger(after) && after >= 0, 'invalid', 'Invalid event cursor.');
    requireThat([...this.subscribers].filter(s => s.principal === principal.id).length < (this.config.maxSubscriptions ?? 8), 'limit', 'Subscription limit reached.', { limit: 'maxSubscriptions' });
    const retained = await this.events(project);
    requireThat(after <= retained.cursor && after >= (retained.events[0]?.cursor ?? 1) - 1, 'event_gap', 'Events are outside the retained window; read the owner snapshot.', { currentCursor: retained.cursor });
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    for (const e of retained.events.filter((e: any) => e.cursor > after && (!e.principal || e.principal === principal.id))) response.write('id: ' + e.cursor + '\nevent: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
    response.write(': observation only\n\n');
    const subscription = { projectId: project.id, principal: principal.id, tokenHash: principal.tokenHash, response };
    this.subscribers.add(subscription); response.on('close', () => this.subscribers.delete(subscription));
    const heartbeat = setInterval(() => {
      if (!this.observationAuthorized(principal.id, principal.tokenHash)) response.end('event: session.invalid\ndata: {}\n\n');
      else response.write(': observation heartbeat\n\n');
    }, 15000);
    heartbeat.unref(); response.once('close', () => clearInterval(heartbeat));
  }
  private observationAuthorized(id: string, tokenHash: string) {
    return this.state.principals.some(p => p.id === id && p.tokenHash === tokenHash && p.methods.includes('observation.snapshot') && (!p.expiresAt || Date.parse(p.expiresAt) > Date.now()));
  }
  async close() {
    this.closing = true;
    this.folderPicker.close();
    for (const s of this.subscribers) s.response.end();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    const shutdown = await this.bridge.close(); await this.state.close(); return shutdown;
  }
}
