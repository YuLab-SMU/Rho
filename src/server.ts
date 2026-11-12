import { Extensions, extensionLimits } from './extensions.js';
import { extensionManagement } from './extension-contract.js';
import { EvidenceExporter, evidenceExportLimits } from './evidence-export.js';
import { Discovery, applicationEffects } from './discovery.js';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Ajv } from 'ajv';
import { atomicJson, canonical, confined, digest, Fault, now, publicResource, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
import { Plugins, selectedPluginVersions, type PluginConfig } from './plugins.js';
import { protocol, operations } from './protocol.js';
import { describeProtocol } from './protocol-discovery.js';
import { CoreBridge } from './bridge.js';
import { State, type Principal, type Project } from './state.js';
import { Requests, publicOperation, requestLimits, type Operation } from './requests.js';
import { Workspace, workspaceLimits } from './workspace.js';
import { Interactions, interactionLimits } from './interactions.js';
import { TaskMap, taskMapLimits } from './task-map.js';
import { Capabilities } from './capabilities.js';
import { BrowserAccess, browserLimits, localBrowserId, localBrowserPrincipal } from './browser-access.js';
import { addToAgent, connectionInstructions, connectLimits, mcpCommand, mcpName, outsideLabel, type OutsideAgent } from './agent-connect.js';
import { NativeFolderPicker, nativeFolderLimits } from './native-folders.js';
import { homedir } from 'node:os';
import { serveWeb, servePageFrame, pageFramePath, extensionFramePath, webRoot, installedWebEntries } from './web-assets.js';
import { Presentation, presentationWitnessLimits, visibilityLimits } from './presentation.js';
import { presentationSchemas } from './presentation-contracts.js';
import { isNativeTime } from './native-time.js';
import { readOperation, type OperationRequest } from './operation-request.js';
import { isRhoMethod } from './contract-runtime.js';
import type { RhoMethod, RhoOutput } from './contract.generated.js';
import { TaskRouting } from './task-routing.js';
import { seedExampleProject, type ExampleSeed } from './example-project.js';
import { exitWords, stopState } from './execution-facts.js';
import { exportRun } from './run-export.js';
import type { nativeActivityLimits, agentDeliveryLimits, RunContext } from '@rho-workspace/plugin-agent';
import { ownerContracts } from './contracts/owners.generated.js';
import { Conversations, conversationLimits, type ConversationConfig } from './conversations.js';
import { captureUiContext } from './ui-context.js';
import { describeLimits } from './file-describer.js';
import { projectWork } from './project-work.js';
export interface FeedbackTransport { accept(envelope: any): Promise<any>; lookup(envelope: any): Promise<any> }
export interface NativeAdapterRegistration {
  projectId: string; taskId: string; registrationId: string; principal: string; adapterPrincipal: string;
  externalSessionId: string; transportCapabilities: Record<string, unknown>;
  proof: { kind: 'claude-code-init'; sessionId: string; clientVersion: string };
}
export const serviceLimits = { maxRequestBytes: 1024 * 1024, maxEventBytes: 65536, eventRetention: 256, maxSubscriptions: 8, maxQueue: 32, maxContexts: 128, maxBindings: 64, maxActivities: 256, maxContextBytes: 1024 * 1024, maxRetainedMetadataBytes: 32 * 1024 * 1024 };
export interface ServiceConfig extends Partial<typeof serviceLimits>, Partial<typeof requestLimits>, PluginConfig { root: string; stateDir: string; extensions?: Partial<typeof extensionLimits>; coreBinary?: string; rscript: string; python?: string; terminalShell?: string; ssh?: string; serverctl?: string; port?: number; nativeFolders?: Partial<typeof nativeFolderLimits>; workspace?: Partial<typeof workspaceLimits>; interactions?: Partial<typeof interactionLimits>; taskMap?: Partial<typeof taskMapLimits>; browser?: Partial<typeof browserLimits>; webRoot?: string; example?: boolean; agentNativeActivity?: Partial<typeof nativeActivityLimits>; presentationWitness?: Partial<typeof presentationWitnessLimits>; visibility?: Partial<typeof visibilityLimits>; agentDelivery?: Partial<typeof agentDeliveryLimits>; deliveryTransportTimeoutMs?: number; claude?: string; agentBackend?: ConversationConfig['backend']; claudeAcp?: ConversationConfig['claudeAcp']; acpCommand?: ConversationConfig['acpCommand']; codex?: string; codexAcp?: ConversationConfig['codexAcp']; conversations?: Partial<typeof conversationLimits>; describe?: Partial<typeof describeLimits>; modelsDev?: { url?: string; maxBytes?: number; timeoutMs?: number; refreshMs?: number; retryMs?: number }; evidence?: Partial<typeof evidenceExportLimits>; connect?: Partial<typeof connectLimits> }
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
// The same timestamp check every published contract uses; an unknown format would be skipped silently.
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
    // When Core saw the process start and when it saw it exit, from its own record; never an estimate.
    ...lifetime(run),
    stop: stopFacts(run),
    repairOf: run.repairOf ?? null
  };
}
function lifetime(run: { native?: unknown }) {
  const known = (run.native as { record?: { execution?: { Known?: { observed_at?: unknown; value?: Record<string, { spawned_at?: unknown } | undefined> } } } } | undefined)?.record?.execution?.Known;
  const [kind, fact] = Object.entries(known?.value ?? {})[0] ?? [];
  return {
    startedAt: typeof fact?.spawned_at === 'string' ? fact.spawned_at : null,
    endedAt: kind === 'ExitObserved' && typeof known?.observed_at === 'string' ? known.observed_at : null
  };
}
// One run as a context gives it to the Agent: the recorded
// facts and the end of the retained stderr, where R writes its error. `from` says where the
// excerpt starts, so a cut is never mistaken for the whole stream.
export const runContextLimits = { errorExcerptBytes: 8192 };
// The methods one layered Agent grant may hold. The Agent pages through them (20 a page, at
// most 64 KiB), so this bounds the grant rather than the Agent's context. A default business
// grant that would exceed it is refused, never silently cut.
export const layeredGrantLimits = { maxMethods: 128 };
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
// `x-rho-client: name/version`, each part URI-encoded: the MCP client's own name for itself.
// Printable text only, bounded; anything else is ignored rather than shown.
function clientOf(header: string | string[] | undefined) {
  if (typeof header !== 'string' || header.length > 300) return null;
  try {
    const [name, version] = header.split('/').map(decodeURIComponent);
    const ok = (value: string | undefined, max: number) => value !== undefined && value.length > 0 && value.length <= max && /^[\x20-\x7e]+$/.test(value);
    return ok(name, 128) ? { name, ...(ok(version, 64) ? { version } : {}) } : null;
  } catch { return null; }
}
// A terminal's raw output and size are for the page that draws it; Agents read its screen as text.
const personTerminal = ['console.terminal.read', 'console.terminal.resize'];
export class RhoService {
  extensions: Extensions; plugins: Plugins; state: State; bridge: CoreBridge; url = ''; adminToken = ''; server: http.Server;
  // What the start did about the project Rho ships, if anything.
  example: ExampleSeed | null = null;
  private queues = new Map<string, Promise<any>>();
  private queued = new Map<string, number>();
  private subscribers = new Set<{ projectId: string; principal: string; tokenHash: string; response: http.ServerResponse }>();
  browser: BrowserAccess;
  folderPicker: NativeFolderPicker;
  private pickingFolder = false;
  private nativeAdapters = new Map<string, NativeAdapterRegistration>();
  private closing = false;
  private closed = false;
  private feedbackTransports = new Map<string, FeedbackTransport>();
  // Conversations the local person starts here; Rho holds their input and runs Claude Code.
  conversations: Conversations;
  private consoles = new Map<string, import('@rho-workspace/plugin-console').ConsoleRunner>();
  private terminals = new Map<string, import('@rho-workspace/plugin-console').TerminalHost>();
  private kernels = new Map<string, import('@rho-workspace/plugin-kernel').KernelHost>();
  private figures = new Map<string, import('@rho-workspace/plugin-figures').Figures>();
  private skillHosts = new Map<string, import('@rho-workspace/plugin-skills').SkillsHost>();
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
    for (const [key, value] of Object.entries({ ...serviceLimits, ...requestLimits, ...config.documents, ...config.resources, ...config.workspace, ...config.interactions, ...config.annotations, ...config.capabilityLimits, ...config.r, ...config.browser, ...config.nativeFolders, ...config.agentNativeActivity, ...config.agentDelivery, ...config.presentationWitness, ...config.visibility, ...config.conversations, ...config.describe, ...config })) {
      if (typeof value === 'number') requireThat(Number.isSafeInteger(value) && (key === 'port' ? value >= 0 && value <= 65535 : value > 0), 'invalid', 'Invalid service budget.', { field: key });
    }
    this.extensions = new Extensions(path.join(config.stateDir, 'plugins'), config.extensions);
    this.plugins = new Plugins(config);
    this.state = new State(config.root, config.stateDir); this.bridge = new CoreBridge(config.coreBinary, config.rscript);
    this.browser = new BrowserAccess(this.state, config.browser);
    this.conversations = new Conversations({
      // The same project grant `rho --grant` gives, under this conversation's own principal.
      grant: async (project, conversation) => {
        const session = 'rho:' + conversation.id, file = path.join(this.state.directory, 'agent-' + digest(project.id + ':' + session) + '.json');
        await this.agentConnection(project.id, session, file, undefined, undefined, 'layered-business', { label: (conversation.client === 'codex' ? 'Codex' : conversation.client === 'acp' ? 'ACP agent' : 'Claude Code') + ' in Rho', conversationId: conversation.id });
        return { file, principal: 'agent:' + digest(project.id + ':' + session).slice(0, 32) };
      },
      directory: project => this.dataDir(project),
      notebook: () => this.plugins.availableIds().includes('kernel'),
      // start/send already holds the service's project serializer while this
      // observation is frozen, before the conversation is recorded or launched.
      uiContext: (project, location, limits) => captureUiContext(project, location,
        id => new Workspace(project, this.plugins.project(project.root, project.id), this.config.workspace).read(id), limits,
        this.plugins.optional('figures') ? (ref, selectionId, rows) => this.figuresFor(project).brief(ref, selectionId, rows) : undefined),
      context: async (project, id) => {
        const context = await this.plugins.project(project.root, project.id).need('agent').peekContext(id);
        requireThat(context.projectId === project.id, 'scope', 'The context belongs to another project.');
        return context;
      },
      capture: (project, file, maximum, count) => this.serial(project.id, async () => {
        const owners = this.plugins.project(project.root, project.id), files = owners.need('files');
        const snapshots: import('./evidence-capture.js').EvidenceSnapshot[] = []; let reason: string | undefined;
        const add = (resource: any, source: any) => { snapshots.push({ resource: { id: resource.id, version: resource.version }, kind: resource.kind, bytes: resource.bytes, observedAt: now(), source }); maximum -= resource.bytes; };
        try {
          const registry = await files.list();
          const known = [...registry].reverse().find(r => (r.path === file || r.provenance.originalPath === file) && r.kind === 'table');
          const captured = await files.capture(file, { maxBytes: maximum, describe: (data, relative) => {
            // A later version keeps the table's declared columns only while its header still
            // names them; a version with other columns is declared from its own header.
            const lexical = /\.csv$/i.test(relative) && owners.tables ? this.plugins.need('tables').lexicalCsvDeclaration(data, relative) : null;
            const names = (format: any) => JSON.stringify((format?.columns ?? []).map((c: any) => c.name));
            if (known && owners.tables && (!lexical || names(known.format) === names(lexical.format))) return { path: relative, kind: 'table', format: known.format as any };
            if (lexical) return lexical;
            const mime: Record<string,string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', pdf: 'application/pdf' };
            const type = mime[relative.split('.').at(-1)!.toLowerCase()];
            return { path: relative, kind: type && owners.media ? 'media' : 'file', format: { mimeType: type ?? 'text/plain' } };
          } });
          add(captured, { kind: 'disk', path: file });
        } catch (error) { reason = error instanceof Fault ? error.message : 'The disk version could not be captured.'; }
        if (snapshots.length < count && owners.documents) {
          const document = (await owners.documents.summaries()).find(d => d.path === file);
          if (document) try {
            const snapshot = await owners.documents.snapshot(document.id, document.version);
            requireThat(Buffer.byteLength(snapshot.code) <= maximum, 'limit', 'The remaining turn snapshot budget cannot hold this buffer.');
            const captured = await files.captureBytes(Buffer.from(snapshot.code), { path: file, kind: 'file', format: { mimeType: 'text/plain' } }, snapshot.source, snapshot.sha256);
            add(captured, snapshot.source);
          } catch { reason = [reason, 'The buffer version could not be captured.'].filter(Boolean).join(' '); }
        }
        if (snapshots.length) await this.emit(project, 'resource.changed', snapshots[0].resource.id);
        return { snapshots, ...(reason ? { reason } : {}) };
      }),
      // Queued behind the project's own writes; it never waits for them, so a write that
      // started a conversation is not held up by its own notification.
      claudePlugins: async () => {
        const declared = this.plugins.claudeCode();
        if (!declared.skills.length && !declared.hooks.length) return [];
        const { writeClaudePlugin } = await import('@rho-workspace/plugin-agent/conversation');
        return [await writeClaudePlugin(path.join(this.state.directory, 'claude-plugins'), { name: 'rho', version: selectedPluginVersions.agent, description: 'Skills and hooks of the plugins selected in Rho.', ...declared })];
      },
      changed: async (project, conversationId) => { void this.serial(project.id, () => this.emit(project, 'conversation.changed', conversationId, localBrowserId)).catch(() => {}); },
      nativeSession: async (project, producer, sessionId) => (await import('@rho-workspace/plugin-agent/native-sessions')).nativeSession(project.root, producer, sessionId),
      // The person's own Claude Code when one is named, with no tools and in an empty folder of
      // Rho's state, so it reads only what it is given and loads no project instructions. What
      // a call cost comes from Claude Code when it knows the model's price, else from models.dev.
      ...config.claude ? {
        modelFacts: (model: string) => this.modelFacts(model),
        describe: async (_project: unknown, request: import('./conversations.js').DescribeRequest) => {
          const { describeFile } = await import('@rho-workspace/plugin-agent/describe'), { callCost } = await import('@rho-workspace/plugin-agent/models');
          const cwd = path.join(this.state.directory, 'describer');
          await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
          const said = await describeFile({ binary: config.claude!, cwd, ...request });
          const listed = said.model ?? request.model;
          return { text: said.text, model: said.model, cost: callCost(said, listed ? await this.modelFacts(listed).catch(() => null) : null) };
        }
      } : {}
    }, config.claude, config.conversations, { backend: config.agentBackend, claudeAcp: config.claudeAcp, acpCommand: config.acpCommand, codex: config.codex, codexAcp: config.codexAcp, settingsFile: path.join(this.state.directory, 'agent-settings.json') });
    this.conversations.describing = { ...describeLimits, ...config.describe };
    this.folderPicker = new NativeFolderPicker({ ...nativeFolderLimits, ...config.nativeFolders });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
  }
  // What models.dev lists about a model, from a catalog kept in Rho's state and read again
  // from the file at most every ten minutes (the Agent component's modelCatalogLimits).
  private catalog: { at: number; value: Promise<import('@rho-workspace/plugin-agent/models').ModelCatalog | null> } | null = null;
  private async modelFacts(model: string) {
    const { loadModelCatalog, findModel } = await import('@rho-workspace/plugin-agent/models');
    if (!this.catalog || Date.now() - this.catalog.at > 600000) this.catalog = { at: Date.now(), value: loadModelCatalog(path.join(this.state.directory, 'models-dev.json'), { limits: this.config.modelsDev ?? {} }).then(r => r.catalog) };
    const catalog = await this.catalog.value;
    return catalog ? findModel(catalog, model) : null;
  }
  async start() {
    try {
    await this.plugins.load();
    this.plugins.installUi(await installedWebEntries(this.config.webRoot), Object.keys(operations));
    await this.state.init();
    await this.extensions.init();
    // A person who starts Rho on a fresh state sees one finished study beside their own work.
    // It is copied into the projects folder once and is otherwise an ordinary project.
    this.example = await seedExampleProject(this.state, { enabled: this.config.example === true }).catch(() => null);
    for (const project of this.state.projects) if (project.sources) this.plugins.sourceFolders.set(project.id, project.sources);
    this.adminToken = randomBytes(32).toString('hex');
    this.state.principals = this.state.principals.filter(p => p.id !== 'operator');
    await this.state.addPrincipal({ id: 'operator', tokenHash: digest(this.adminToken), methods: Object.keys(operations) });
    // Opening this service in a browser on this machine is the local person: one principal,
    // no credential, no expiry. It is registered once per start, replacing any earlier copy.
    // The folders this person chose in the system dialog stay theirs across restarts: the earlier
    // copy's grants carry over, each naming exactly one project still registered, nothing wider.
    const earlier = this.state.principals.find(p => p.id === localBrowserId);
    const chosen = (earlier?.selectedProjects ?? []).filter(id => this.state.projects.some(p => p.id === id && p.nativeSelected));
    this.state.principals = this.state.principals.filter(p => p.id !== localBrowserId);
    await this.state.addPrincipal({ ...localBrowserPrincipal(await fs.realpath(this.config.root)), ...(chosen.length ? { selectedProjects: chosen } : {}) });
    // A person's bookmark and every Agent connection name this service's address. A start that
    // selects no port takes the one this state's last start had, and a new one only when that
    // port is taken now; a selected port is used or refused, never replaced.
    const connectionFile = path.join(this.state.directory, 'connection.json');
    const earlierUrl = await fs.readFile(connectionFile, 'utf8').then(text => String(JSON.parse(text).url), () => '');
    const earlierPort = /^http:\/\/127\.0\.0\.1:\d+$/.test(earlierUrl) ? Number(new URL(earlierUrl).port) : 0;
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    try { await listen(this.config.port ?? earlierPort); }
    catch (error) {
      const taken = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      requireThat(!taken || this.config.port === undefined, 'conflict', `Port ${this.config.port} on 127.0.0.1 is in use by another program. If that is Rho, open http://127.0.0.1:${this.config.port}; otherwise choose another --port, or leave it out.`, { port: this.config.port });
      if (!taken) throw error;
      await listen(0);
    }
    this.url = 'http://127.0.0.1:' + (this.server.address() as any).port;
    // The process that serves it, so rho --stop can say when it has ended and not only closed.
    await atomicJson(connectionFile, { url: this.url, token: this.adminToken, apiVersion: '2.0', pid: process.pid });
    // An Agent's connection holds the address it was given. When the address changed, each one
    // that named the earlier address follows, so the Agent's next session reaches this service
    // with the grant it already has. Its token and methods are unchanged.
    if (earlierUrl && earlierUrl !== this.url) await this.followAddress(earlierUrl);
    return this;
    } catch (e) {
      if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
      await this.state.close(); throw e;
    }
  }
  // Only this state's own connection files, and only those that named the earlier address: a
  // file that cannot be read or rewritten keeps what it had, and the start goes on.
  private async followAddress(earlierUrl: string) {
    const names = await fs.readdir(this.state.directory).catch(() => [] as string[]);
    for (const name of names.filter(name => /^agent-[0-9a-f]+\.json$/.test(name))) {
      const file = path.join(this.state.directory, name);
      try {
        const connection = JSON.parse(await fs.readFile(file, 'utf8'));
        if (connection?.url === earlierUrl && typeof connection.token === 'string') await atomicJson(file, { ...connection, url: this.url });
      } catch { /* left as it was */ }
    }
  }
  async agentConnection(projectId: string, externalSessionId: string, file: string, methods?: string[], pluginFilter?: string[], profile: 'layered-business' | 'layered-presentation' = 'layered-business', who: { label?: string; conversationId?: string } = {}) {
    requireThat(profile === undefined || ['layered-business', 'layered-presentation'].includes(profile), 'invalid', 'Choose an explicitly supported layered profile.');
    const project = await this.state.project(projectId, this.state.principals.find(p => p.id === 'operator')!);
    this.plugins.need('agent');
    const capabilities = new Capabilities(this.plugins, project);
    const state = await capabilities.state();
    // The shared project listing remains available alongside an Agent's native tools.
    const available = Object.keys(operations).filter(m => !extensionManagement.includes(m) && !m.startsWith('agent.activity.') && !m.startsWith('agent.sessions.') && !m.startsWith('session.') && !m.startsWith('conversation.') && (!m.startsWith('project.') || m === 'project.entries') && !m.startsWith('requirements.prepare') && !m.startsWith('workspace.restore') && !['task.routing.put', 'binding.activity.append', 'feedback.submit', 'view.observe', 'view.observations.read', 'task.map.respond', 'annotation.decide', 'evidence.export', 'evidence.preview', 'console.run', 'console.stop', 'kernel.start', 'kernel.stop'].includes(m) && !personTerminal.includes(m));
    const profileMethods = profile === 'layered-presentation' ? ['binding.open', 'capability.index', 'capability.resolve', 'workspace.observe', 'workspace.enhance'] : available.filter(m => !['workspace.observe', 'workspace.enhance', ...(profile ? ['skill.list','skill.read','protocol.describe'] : [])].includes(m));
    const selected = methods ?? (profile === 'layered-presentation' ? profileMethods : (await Promise.all(profileMethods.map(async method => [method, await capabilities.isAvailable(method, state)] as const))).filter(([, enabled]) => enabled).map(([method]) => method));
    requireThat(profile !== 'layered-presentation' || selected.every(m => profileMethods.includes(m)), 'scope', 'The selected role cannot receive broader methods.');
    requireThat(selected.every(m => !extensionManagement.includes(m) && !!operations[m] && !m.startsWith('agent.sessions.') && !m.startsWith('session.') && !m.startsWith('conversation.') && (!m.startsWith('project.') || m === 'project.entries') && !['task.routing.put', 'console.run', 'console.stop', 'kernel.start', 'kernel.stop'].includes(m) && !personTerminal.includes(m)), 'invalid', 'Unknown or operator-only Agent capability.');
    requireThat(await Promise.all(selected.map(method => capabilities.isAvailable(method, state))).then(values => values.every(Boolean)), 'unavailable', 'A requested Agent operation has no selected provider.');
    requireThat(!profile || new Set(['capability.index', 'capability.resolve', ...selected]).size <= layeredGrantLimits.maxMethods, 'limit', `Layered connection methods exceed the ${layeredGrantLimits.maxMethods}-method profile; choose an explicit narrower grant.`, { limit: 'maxMethods', maximum: layeredGrantLimits.maxMethods });
    const id = 'agent:' + digest(projectId + ':' + externalSessionId).slice(0, 32);
    const grantedMethods = [...new Set([...(profile ? ['capability.index', 'capability.resolve'] : ['protocol.describe', 'capability.list']), ...selected])];
    const existing = this.state.principals.find(p => p.id === id);
    const kept = await fs.readFile(file, 'utf8').then(text => JSON.parse(text), () => null);
    // Repeating the same setup must not disconnect a client already using its grant.
    // Changed scope, expired access or a stale address still requires a fresh credential.
    if (existing && !(existing.expiresAt && Date.parse(existing.expiresAt) <= Date.now())
      && kept?.url === this.url && kept.projectId === projectId && kept.externalSessionId === externalSessionId
      && typeof kept.token === 'string' && digest(kept.token) === existing.tokenHash
      && canonical([...existing.methods].sort()) === canonical([...grantedMethods].sort())
      && kept.profile === profile && canonical(existing.pluginFilter ?? []) === canonical(pluginFilter ?? [])) return kept;
    const token = randomBytes(32).toString('hex');
    this.state.principals = this.state.principals.filter(p => p.id !== id);
    requireThat(!pluginFilter || pluginFilter.every(id => this.plugins.isKnown(id)), 'invalid', 'Unknown MCP plugin filter.');
    await this.state.addPrincipal({ id, tokenHash: digest(token), projectId, label: who.label ?? externalSessionId, ...(who.conversationId ? { conversationId: who.conversationId } : {}), methods: grantedMethods, ...(profile ? { profile } : {}), ...(pluginFilter ? { pluginFilter } : {}) });
    const connection = { url: this.url, token, projectId, externalSessionId, methods: [...new Set([...(profile ? ['capability.index', 'capability.resolve'] : []), ...selected])], ...(profile ? { profile } : {}), ...(pluginFilter ? { pluginFilter } : {}), apiVersion: '2.0' as const };
    await atomicJson(file, connection); return connection;
  }
  private authenticate(req: http.IncomingMessage, method: string) {
    requireThat(req.headers.host === new URL(this.url).host, 'origin', 'Host header does not match the local service.');
    if (req.headers.origin) requireThat(req.headers.origin === this.url, 'origin', 'Origin is not authorized for this service.');
    // Browsers label their own requests. A page from another site is refused here even when it
    // reaches the loopback port; anything else reaching this port is already the same user.
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') requireThat(false, 'origin', 'Cross-site requests are not authorized for this service.');
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    // No credential means the person at this machine opened this service. A credential that is
    // present must still be valid: an old or narrowed link never silently widens to local access.
    const principal = bearer
      ? this.state.principals.find(p => p.tokenHash.length === 64 && timingSafeEqual(Buffer.from(p.tokenHash, 'hex'), Buffer.from(digest(bearer), 'hex')))
      : this.state.principals.find(p => p.id === localBrowserId);
    requireThat(principal, 'unauthorized', bearer ? 'A valid local session credential is required.' : 'Open this service in a browser on this machine.');
    requireThat(!principal.expiresAt || Date.parse(principal.expiresAt) > Date.now(), 'unauthorized', 'Browser session expired. Open this service in a browser on this machine, or ask your Agent for a new link.');
    requireThat(principal.methods.includes(method === 'events' ? 'observation.snapshot' : method), 'unauthorized', 'Session does not authorize this operation.');
    return principal;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
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
        if (url.pathname === pageFramePath || url.pathname === extensionFramePath) { servePageFrame(res, req.method === 'HEAD', url.pathname === extensionFramePath); return; }
        await serveWeb(url.pathname, res, this.config.webRoot, req.method === 'HEAD'); return;
      }
      const method = url.pathname.startsWith('/api/v2/') ? url.pathname.slice(8) : '';
      requireThat(method === 'events' || !!operations[method], 'not_found', 'Unknown API operation.');
      const principal = this.authenticate(req, method);
      // An Agent's MCP bridge names the client that started it; the person's screen shows it.
      const named = principal.projectId && principal.kind !== 'browser' ? clientOf(req.headers['x-rho-client']) : null;
      if (named) void this.state.markClient(principal.id, named).catch(() => {});
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
      if (body.projectId && (method.startsWith('kernel.') || method.startsWith('console.terminal.') || method === 'extension.call')) {
        // A cell may run for minutes and a run may wait for it. The live sessions keep their own
        // order, so waiting holds no other request of the project, an interrupt among them.
        const projectId = body.projectId;
        try { value = await this.dispatch(request, principal, contractRef); }
        catch (e) { await this.serial(projectId, () => this.recordActivity(principal, method, body, undefined, e instanceof Fault ? e.kind : 'storage')); throw e; }
        const result = value;
        await this.serial(projectId, () => this.recordActivity(principal, method, body, result));
      } else if (body.projectId && method !== 'project.source.add') {
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
  // What the project's Agents did, for the person's screen:
  // only principals whose grant names this project, only the fields the activity record
  // keeps. A grant is the scope; an Agent need not have opened a binding.
  // Every Agent session in the project folder, wherever it was started: Harness conversations Rho
  // observes and the sessions Claude Code and Codex keep in their own files. Each names the Agent
  // Rho continues it with and the Rho conversation that already continues it. Reads files only.
  private async agentSessions(p: Project) {
    const agent = this.plugins.optional('agent');
    const external = agent ? agent.listExternalSessions(p.root) : { sessions: [], omitted: 0 };
    const native = (await import('@rho-workspace/plugin-agent/native-sessions')).listNativeSessions(p.root);
    const conversations = [...await this.conversations.list(p, {}), ...await this.conversations.list(p, { trashed: true })];
    const bySession = new Map(conversations.filter(c => c.sessionId).map(c => [c.sessionId!, c]));
    const harness = await this.conversations.harness();
    const sessions = [...external.sessions, ...native.sessions].flatMap(s => {
      const conversation = bySession.get(s.sessionId);
      if (conversation?.trashedAt) return [];
      const continueWith = s.producer === 'claude-code' ? 'claude-acp' as const : s.producer === 'codex' ? 'codex-acp' as const : s.producer === 'dsh' ? harness : null;
      // Harness reports a turn in progress, not whether a window holds the session idle; a turn
      // Rho itself is running is Rho's.
      const open = s.producer === 'dsh' && s.state === 'running' && conversation?.state !== 'running' ? { where: 'DeepSeek Harness' } : s.open;
      return [{ ...s, continueWith, ...(open !== undefined ? { open } : {}), ...(conversation ? { conversationId: conversation.conversationId } : {}) }];
    });
    // A session held only by Rho's own connection is not open elsewhere.
    for (const s of sessions) if (s.open && s.conversationId && await this.conversations.owns(p, s.conversationId, s.open.pid, s.producer)) s.open = null;
    sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    return { sessions: sessions.slice(0, 128), omitted: external.omitted + native.omitted + Math.max(0, sessions.length - 128) };
  }
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
      return { principal: x.id, label: x.label ?? null, profile: x.profile ?? null, methods: x.methods, expiresAt: x.expiresAt ?? null, ended: !!x.expiresAt && Date.parse(x.expiresAt) <= Date.now(), conversationId: x.conversationId ?? null, client: x.client ?? null, added: x.added ?? null,
        last: last ? { at: String(last.at), method: String(last.method), outcome: last.outcome === 'rejected' ? 'rejected' as const : 'returned' as const, ...(last.operationId ? { operationId: String(last.operationId) } : {}) } : null };
    });
  }
  private async dataDir(p: Project) { return stateDirectory(p.root, '.rho/rho'); }
  // One Console per project for the life of this service: it holds the commands it started.
  // Changes reach open pages at most four times a second.
  private consoleFor(p: Project) {
    let runner = this.consoles.get(p.id);
    if (!runner) {
      const { ConsoleRunner } = this.plugins.need('console');
      let pending: NodeJS.Timeout | undefined;
      const changed = () => {
        if (pending || this.closing) return;
        pending = setTimeout(() => { pending = undefined; void this.serial(p.id, () => this.emit(p, 'console.changed', p.id, localBrowserId)).catch(() => {}); }, 250);
      };
      runner = new ConsoleRunner(p.root, { limits: this.config.console, onChange: changed });
      this.consoles.set(p.id, runner);
    }
    return runner;
  }
  // The terminals in a project, for the life of this service: shells the person and Agents use.
  private terminalsFor(p: Project) {
    let host = this.terminals.get(p.id);
    if (!host) {
      const { TerminalHost } = this.plugins.need('console');
      // A command started or ended in a terminal reaches open pages at most four times a second.
      let pending: NodeJS.Timeout | undefined;
      const changed = () => {
        if (pending || this.closing) return;
        pending = setTimeout(() => { pending = undefined; void this.serial(p.id, () => this.emit(p, 'console.changed', p.id, localBrowserId)).catch(() => {}); }, 250);
      };
      host = new TerminalHost(p.root, { limits: this.config.terminal, python: this.config.python, shell: this.config.terminalShell, onChange: changed });
      this.terminals.set(p.id, host);
    }
    return host;
  }
  // One pair of live sessions per project for the life of this service, shared by the person
  // and their Agent. Changes reach open pages at most four times a second.
  private kernelFor(p: Project) {
    let host = this.kernels.get(p.id);
    if (!host) {
      const { KernelHost } = this.plugins.need('kernel');
      let pending: NodeJS.Timeout | undefined;
      const changed = () => {
        if (pending || this.closing) return;
        pending = setTimeout(() => { pending = undefined; void this.serial(p.id, () => this.emit(p, 'kernel.changed', p.id, localBrowserId)).catch(() => {}); }, 250);
      };
      // With the figures plugin, each local R and Python session describes the plots it draws.
      const figures = this.plugins.optional('figures');
      host = new KernelHost(p.root, { limits: this.config.kernel, rscript: this.bridge.rscript, python: this.config.python, ssh: this.config.ssh, serverctl: this.config.serverctl, onChange: changed,
        ...(figures ? { extensions: { r: [figures.rExtension], python: [figures.pythonExtension] } } : {}) });
      this.kernels.set(p.id, host);
    }
    return host;
  }
  // The figures the project's live R session drew, read from the records its cells kept.
  private figuresFor(p: Project) {
    let host = this.figures.get(p.id);
    if (!host) {
      const { Figures } = this.plugins.need('figures');
      host = new Figures(p.root, { record: (cellId, plot) => this.kernelFor(p).figureRecord(cellId, plot), saved: sha256 => this.kernelFor(p).savedFigure(sha256) });
      this.figures.set(p.id, host);
    }
    return host;
  }
  // The project's skills, written by the person and their Agent. A change reaches open pages
  // once the request that made it has finished.
  private skillsFor(p: Project) {
    let host = this.skillHosts.get(p.id);
    if (!host) {
      const { SkillsHost } = this.plugins.need('skills');
      const changed = () => { if (!this.closing) setTimeout(() => { void this.serial(p.id, () => this.emit(p, 'skills.changed', p.id, localBrowserId)).catch(() => {}); }, 0); };
      host = new SkillsHost(p.root, { limits: this.config.skills, onChange: changed });
      this.skillHosts.set(p.id, host);
    }
    return host;
  }
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
    if (extensionManagement.includes(method)) {
      requireThat(principal.id === 'operator' || principal.id === localBrowserId, 'scope', 'Plugin installation and management belong to the person at this machine.');
      if (method === 'extension.market.change') return this.extensions.changeMarket(b);
      return method === 'extension.install' ? this.extensions.install(b.source, b.replace, b.expectedDigest, b.market) : this.extensions.manage(b.pluginId, b.expectedDigest, b.action);
    }
    if (method === 'extension.list' && !b.projectId) {
      requireThat(principal.id === 'operator' || principal.id === localBrowserId, 'scope', 'A project-scoped caller must supply its project.');
      return this.extensions.list();
    }

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
    // The person's own state credential (`rho open`) may name any folder on this machine by its full
    // path, as the dialog lets them choose one: a folder outside the projects folder becomes theirs
    // in their own tab and nobody else's. A tab or an Agent names folders inside its root only.
    if (method === 'project.open' && principal.id === 'operator' && path.isAbsolute(b.path)) return this.serial('projects', async () => {
      const folder = await fs.realpath(b.path).catch(() => { throw new Fault('not_found', `There is no folder ${b.path}.`, { path: b.path }); });
      const root = await fs.realpath(this.state.root);
      const inside = folder === root || folder.startsWith(root + path.sep);
      const person = this.state.principals.find(x => x.id === localBrowserId);
      requireThat(inside || person, 'unavailable', 'This service has no tab of the person at this machine to give the folder to.');
      const p = inside ? await this.state.open(path.relative(root, folder) || '.') : await this.state.openForPerson(folder, person!, this.config.nativeFolders?.maxProjects ?? nativeFolderLimits.maxProjects);
      return { ...p, host: await this.bridge.capability(p.root) };
    });
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
    if (method.startsWith('extension.')) {
      if (contractRef) {
        const reader = new Discovery(this.plugins, p, principal, await routing.read(), await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), []));
        await reader.assertContract(method, contractRef);
      }
      if (method === 'extension.list') return this.extensions.list();
      if (method === 'extension.describe') return this.extensions.describe(b.pluginId);
      if (method === 'extension.content') return this.extensions.content(b.pluginId, b.expectedDigest, b.kind, b.entryId);
      if (method === 'extension.read') return this.extensions.read(b.invocationId, principal.id, p.id);
      if (method === 'extension.call') return this.extensions.call(b, principal.id, p.root, async (target, body, effect) => {
        requireThat(principal.methods.includes(target), 'scope', 'The caller has not been granted this Rho method.');
        requireThat(!body?.projectId || body.projectId === p.id, 'scope', 'A plugin cannot delegate into another project.');
        const request = readOperation(target, { ...body, projectId: p.id });
        requireThat(request.ok, 'invalid', 'Plugin delegated an invalid Rho request.');
        const capabilities = new Capabilities(this.plugins, p);
        const status = (await capabilities.operationStatus(principal, await capabilities.state())).find(op => op.method === target);
        requireThat(effect !== 'read' || (status?.effect ?? applicationEffects[target]) === 'read', 'scope', 'A read operation cannot delegate a mutating Rho method.');
        const run = () => this.dispatch(request.request, principal);
        return target.startsWith('kernel.') ? run() : this.serial(p.id, run);
      });
    }

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
      // A Windows Host serves a named pipe and leaves no socket behind.
      } else if (process.platform !== 'win32' && await fs.lstat(socket).then(() => true, () => false)) {
        add('core', 'warn', `A socket remains at ${socket} but no Host answers.`, 'Stop the service that owned it, or remove the stale socket after inspecting the original requests.');
      } else if (!this.bridge.binary) add('core', b.intent === 'run-r' ? 'fail' : 'ok', 'Core is not selected. Native Agent tools are available; managed runs and Host activity need Core.', 'Select --core or RHO_CORE_BINARY when those capabilities are needed.');
      else add('core', 'ok', 'No Host is running; an explicitly selected managed operation starts one.');
      const rscriptAvailable = await fs.access(this.bridge.rscript, fs.constants.X_OK).then(() => true, () => false);
      add('rscript', rscriptAvailable ? 'ok' : b.intent === 'run-r' ? 'fail' : 'warn', rscriptAvailable ? `R is available at ${this.bridge.rscript}.` : `The optional managed R entry is unavailable at ${this.bridge.rscript}. Native Agent tools remain available.`, rscriptAvailable ? '' : 'For managed R scripts, select an existing Rscript with --rscript or RHO_RSCRIPT.');
      // Conversations drive the person's installed Claude Code or Codex; the package carries none.
      const agentCommand = await import('@rho-workspace/plugin-agent/acp-command').catch(() => null);
      if (this.config.agentBackend === 'acp') {
        const cmd = this.config.acpCommand;
        add('agents', cmd?.file ? 'ok' : 'warn', cmd?.file ? `A generic ACP agent is configured (${cmd.file} ${cmd.args.join(' ')}).` : 'No ACP agent command is configured.',
          cmd?.file ? '' : 'Start Rho with --agent-backend acp --acp-command <argv> or RHO_ACP_COMMAND.');
      } else if (agentCommand) {
        const claude = this.config.claude ?? process.env.RHO_CLAUDE, codex = this.config.codex ?? process.env.RHO_CODEX;
        const env = { ...process.env, ...(claude ? { CLAUDE_CODE_EXECUTABLE: claude } : {}), ...(codex ? { CODEX_PATH: codex } : {}) };
        const preferred = this.config.agentBackend === 'codex-acp' ? 'codex' : 'claude', other = preferred === 'codex' ? 'claude' : 'codex';
        const [missing, otherMissing] = [agentCommand.missingClient(preferred, env), agentCommand.missingClient(other, env)];
        const name = { claude: 'Claude Code', codex: 'Codex' };
        add('agents', missing ? 'warn' : 'ok', missing ? [missing, otherMissing ?? `${name[other]} is installed.`].join(' ') : otherMissing ? `${name[preferred]} is installed. ${otherMissing}` : 'Claude Code and Codex are installed.',
          missing ? `Install ${name[preferred]}, or select its executable with --${preferred}.` : '');
      }
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
      const sources = p.sources ?? [];
      const requested: string = b.path ?? '.';
      // A source folder is addressed as @<sourceId>/<path>, the same reference the file and
      // document owners resolve, so what this lists is what opening will accept. The project
      // directory keeps plain relative paths; nothing is unioned or copied into it.
      const alias = /^@([^/]+)(?:\/(.*))?$/.exec(requested);
      const source = alias ? sources.find(entry => entry.id === alias[1]) : undefined;
      requireThat(!alias || source, 'scope', 'This source folder is not part of the project.');
      if (source) {
        // A folder that moved is reported, never silently followed to whatever is there now.
        const current = await fs.realpath(source.root).catch(() => null);
        requireThat(current === source.root, 'scope', current
          ? 'A source folder changed location. Add its current location before listing it.'
          : 'A source folder is missing. Add its current location before listing it.');
      }
      const base = source?.root ?? p.root, within = source ? 'Only folders inside this source folder can be listed.' : 'Only folders inside this project can be listed.';
      const at = (relative: string) => source ? '@' + source.id + (relative ? '/' + relative : '') : relative;
      let directory: string;
      try { directory = await confined(base, alias ? (alias[2] ?? '.') || '.' : requested); }
      catch { requireThat(false, 'scope', within); }
      const canonical = await fs.realpath(directory);
      requireThat(canonical === base || canonical.startsWith(base + path.sep), 'scope', within);
      requireThat((await fs.lstat(canonical)).isDirectory(), 'invalid', 'That entry is a file, not a folder.');
      const relative = path.relative(base, canonical).split(path.sep).join('/');
      let names: string[] = [];
      try { names = await fs.readdir(canonical); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      const entries: Array<{ path: string; name: string; kind: 'file' | 'folder'; bytes: number; hidden: boolean; modifiedAt?: string }> = [];
      for (const name of names) {
        if (['.rho', '.git', '.DS_Store'].includes(name)) continue;
        const stat = await fs.lstat(path.join(canonical, name)).catch(() => null);
        if (!stat || stat.isSymbolicLink()) continue;
        const kind = stat.isDirectory() ? 'folder' as const : stat.isFile() ? 'file' as const : null;
        if (!kind) continue;
        const entryPath = at((relative ? relative + '/' : '') + name);
        // When a file last changed on disk, so a view can say what changed while work ran.
        entries.push({ path: entryPath, name, kind, bytes: kind === 'file' ? stat.size : 0, hidden: name.startsWith('.'), modifiedAt: stat.mtime.toISOString() });
      }
      // The project's own folder opens with the folders it works in beside its contents, so a
      // project made from source folders does not read as empty.
      if (!alias) for (const entry of sources) entries.push({ path: '@' + entry.id, name: entry.name, kind: 'folder', bytes: 0, hidden: false });
      entries.sort((a, c) => a.name.localeCompare(c.name) || a.path.localeCompare(c.path));
      return { entries: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit, roots: [at(relative) || '.'], path: at(relative) };
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
    if (method === 'session.instructions') {
      requireThat(principal.id === localBrowserId || principal.id === 'operator', 'unauthorized', 'Only the person at this machine can read Agent setup instructions.');
      return connectionInstructions(p, this.state.directory);
    }
    if (method === 'session.grant') {
      requireThat(principal.id === 'operator', 'unauthorized', 'Only the local operator may provision a project-scoped session.');
      const file = path.join(this.state.directory, 'agent-' + digest(p.id + ':' + b.externalSessionId) + '.json');
      const connection = await this.agentConnection(p.id, b.externalSessionId, file, b.methods, undefined, b.profile);
      await this.emit(p, 'activity.changed', method);
      return { profile: connection.profile, connectionFile: file, projectId: p.id, methods: connection.methods, transport: 'stdio-mcp', externalSessionId: b.externalSessionId };
    }
    // The person's own Claude Code or Codex, outside Rho: the same grant the operator gives, kept
    // when it already exists so a connected session keeps its token, then the Agent's own `mcp add`.
    // The person does it from the page; whoever started the service, with `rho --grant --agent`.
    if (method === 'session.connect') {
      requireThat(principal.id === localBrowserId || principal.id === 'operator', 'unauthorized', 'Only the person at this machine can add Rho to their own Agent.');
      const agent = b.agent as OutsideAgent, file = path.join(this.state.directory, 'agent-' + digest(p.id + ':' + agent) + '.json');
      const id = 'agent:' + digest(p.id + ':' + agent).slice(0, 32), existing = this.state.principals.find(x => x.id === id);
      // A grant is kept while its connection still reaches this service with its token; otherwise
      // it is replaced, and a replacement the Agent then refuses is removed again.
      const connection = await fs.readFile(file, 'utf8').then(text => JSON.parse(text), () => null);
      const kept = !!existing && !(existing.expiresAt && Date.parse(existing.expiresAt) <= Date.now()) && connection?.url === this.url && typeof connection?.token === 'string' && digest(connection.token) === existing.tokenHash;
      const methods = kept ? existing!.methods.length : (await this.agentConnection(p.id, agent, file, undefined, undefined, 'layered-business', { label: outsideLabel[agent] })).methods.length;
      const binary = agent === 'codex' ? this.config.codex ?? process.env.RHO_CODEX ?? 'codex' : this.config.claude ?? process.env.RHO_CLAUDE ?? 'claude';
      const added = await addToAgent(agent, binary, p.root, mcpName(p.root), mcpCommand(file), { ...connectLimits, ...this.config.connect }).catch(async error => {
        if (!kept) { await this.state.removePrincipal(id); await fs.rm(file, { force: true }); await this.emit(p, 'activity.changed', method); }
        throw error;
      });
      await this.state.markAdded(id, added);
      await this.emit(p, 'activity.changed', method);
      return { principal: id, label: outsideLabel[agent], methods, granted: !kept, added };
    }
    // The person at this machine talks to a conversation Rho started; Agents and narrower links
    // cannot start one, and an Agent started this way cannot start another.
    if (method.startsWith('agent.sessions.')) {
      requireThat(principal.id === localBrowserId, 'unauthorized', 'Agent session history belongs to the person at this machine.');
      if (method === 'agent.sessions.list') return this.agentSessions(p);
      const listed = (await this.agentSessions(p)).sessions.find(s => s.id === b.session);
      requireThat(listed, 'not_found', 'That Agent session is not in this project.');
      const read = listed.producer === 'claude-code' || listed.producer === 'codex'
        ? await (await import('@rho-workspace/plugin-agent/native-sessions')).readNativeSession(p.root, b)
        : this.plugins.need('agent').readExternalSession(p.root, b);
      requireThat(read, 'not_found', 'That Agent session is no longer in this project.');
      return { ...read, session: { ...read.session, ...listed } };
    }
    if (method === 'project.work.read') {
      requireThat(principal.id === localBrowserId, 'scope', 'Project work is available to the person at this machine.');
      const agent = (await new Capabilities(this.plugins, p).state()).enabled.includes('agent') ? this.plugins.optional('agent') : null;
      let native: Awaited<ReturnType<NonNullable<typeof agent>['readAgentActivity']>> | null = null;
      if (agent) {
        const capability = await this.bridge.capability(p.root);
        if (capability.exitCode === 0 && capability.reply.value?.limits?.activity) {
          native = await agent.readAgentActivity(async (command, args) => {
            const result = await this.bridge.call(p.root, command, 'rho-agent-observe', undefined, args);
            requireThat(result.exitCode === 0 && result.reply.ok, 'unavailable', 'Native activity is unavailable.');
            return result.reply.value;
          }).catch(() => null);
        }
      }
      return projectWork({ project: p, cursor: (await this.events(p)).cursor, conversations: await this.conversations.work(p, b.limit),
        documents: await owners.documentSummaries(), activity: (await this.projectActivity(p)).entries,
        native, external: agent?.readExternalAcp(p.root), observed: agent?.listExternalSessions(p.root), readObserved: agent?.readExternalSession, inspect: agent?.observeSessionFiles });
    }
    if (method.startsWith('conversation.')) {
      requireThat(principal.id === localBrowserId, 'unauthorized', 'Conversations started in Rho belong to the person at this machine. Open Rho in a browser on this machine.');
      if (method === 'conversation.read') return this.conversations.read(p, b);
      if (method === 'conversation.permission') return this.conversations.permission(p, principal.id, b);
      if (method === 'conversation.stop') return this.conversations.stop(p, principal.id, b);
      if (method === 'conversation.decide') return this.conversations.decide(p, principal.id, b);
      if (method === 'conversation.list') return { conversations: await this.conversations.list(p, b) };
      if (method === 'conversation.trash') return this.conversations.trash(p, principal.id, b);
      if (method === 'conversation.restore') return this.conversations.restore(p, b);
      if (method === 'conversation.delete') return this.conversations.delete(p, principal.id, b);
      if (method === 'conversation.settings.read') return this.conversations.settings();
      this.plugins.need('agent');
      if (method === 'conversation.start' && b.continue) {
        const listed = (await this.agentSessions(p)).sessions.find(s => s.id === b.continue.session);
        requireThat(listed, 'not_found', 'That Agent session is not in this project. Nothing was sent.');
        requireThat(listed.continueWith, 'condition', listed.producer === 'dsh'
          ? 'Rho continues DeepSeek Harness sessions through Harness\'s ACP command. Add DeepSeek Harness under Agents in Rho, or continue in Harness. Nothing was sent.'
          : 'Rho cannot continue this Agent\'s sessions. Nothing was sent.');
        requireThat(!listed.conversationId, 'conflict', 'This session already continues as a conversation here. Open it to send your message.');
        requireThat(!b.continue.copy || listed.producer !== 'dsh', 'condition', 'DeepSeek Harness cannot copy a session. Continue it in place once it is not answering. Nothing was sent.');
        requireThat(!listed.open || listed.producer !== 'dsh', 'condition', 'DeepSeek Harness is answering in this session now. Continue it once that turn ends. Nothing was sent.', { heldBy: 'DeepSeek Harness' });
        return this.conversations.start(p, principal.id, { ...b, continue: { producer: listed.producer as 'claude-code' | 'codex' | 'dsh', sessionId: listed.sessionId, title: listed.title, where: listed.where ?? (listed.producer === 'dsh' ? 'DeepSeek Harness' : 'another window'), copy: !!b.continue.copy, backend: listed.continueWith } });
      }
      if (method === 'conversation.start') return this.conversations.start(p, principal.id, b);
      if (method === 'conversation.send') {
        // A Harness session reports its own turns through its adapter; Rho does not write into one it is answering.
        const listed = (await this.agentSessions(p)).sessions.find(s => s.conversationId === b.conversationId && s.producer === 'dsh');
        requireThat(!listed?.open, 'condition', 'DeepSeek Harness is answering in this session now. Send once that turn ends. Nothing was sent.', { heldBy: 'DeepSeek Harness' });
        return this.conversations.send(p, principal.id, b);
      }
      if (method === 'conversation.configure') return this.conversations.configure(p, principal.id, b);
      if (method === 'conversation.settings.update') return this.conversations.updateSettings(b);
      if (method === 'conversation.settings.check') return this.conversations.check(p, b);
      if (method === 'conversation.agents.add') return this.conversations.addAgent(p, b);
      if (method === 'conversation.agents.remove') return this.conversations.removeAgent(b);
    }
    const capabilities = new Capabilities(this.plugins, p);
    // The person runs and stops Console commands with their own shell; anyone holding the read
    // grant may read what ran.
    if (method.startsWith('console.terminal.')) {
      // The person and an Agent granted these may both open a terminal, read what it shows and
      // type in it; the raw output and the size are the page's that draws it. An Agent closes only
      // the terminals it opened. Each Agent call is recorded as its activity.
      const person = principal.id === localBrowserId;
      requireThat(person || !personTerminal.includes(method), 'unauthorized', 'The page that draws a terminal reads its raw output and sizes it. Read what it shows with console.terminal.screen.');
      await capabilities.assertAvailable(method, principal);
      const host = this.terminalsFor(p);
      if (method === 'console.terminal.open') return host.open({ cols: b.cols, rows: b.rows, cwd: b.cwd, by: principal.id });
      if (method === 'console.terminal.list') return host.list();
      if (method === 'console.terminal.screen') return host.screen(b.terminalId, { after: b.after, waitMs: b.waitMs, lines: b.lines });
      if (method === 'console.terminal.commands') return host.commandList(b.limit, b.offset);
      if (method === 'console.terminal.output') return host.commandOutput(b.commandId, b.offset, b.maxChars);
      if (method === 'console.terminal.read') return host.read(b.terminalId, b.after, b.waitMs, b.maxBytes);
      if (method === 'console.terminal.write') return host.write(b.terminalId, b.data, principal.id);
      if (method === 'console.terminal.resize') return host.resize(b.terminalId, b.cols, b.rows);
      if (method === 'console.terminal.close') {
        requireThat(person || host.list().terminals.find(t => t.terminalId === b.terminalId)?.by === principal.id, 'unauthorized', 'An Agent closes only the terminals it opened. Ask the person to close this one.');
        return host.close(b.terminalId);
      }
    }
    if (method.startsWith('console.')) {
      if (method === 'console.run' || method === 'console.stop') requireThat(principal.id === localBrowserId, 'unauthorized', 'Console commands run with the shell of the person at this machine. Open Rho in a browser on this machine.');
      await capabilities.assertAvailable(method, principal);
      const runner = this.consoleFor(p);
      if (method === 'console.run') return { command: await runner.run({ command: b.command, cwd: b.cwd, changeId: b.changeId, by: principal.id }) };
      if (method === 'console.list') return runner.list(b.limit);
      if (method === 'console.events') return runner.events(b.limit);
      if (method === 'console.output') return runner.output(b.commandId, b.offset, b.maxBytes);
      if (method === 'console.stop') return { command: await runner.stop(b.commandId, principal.id) };
    }
    // The person and their Agent run and interrupt cells in the same sessions; only the person
    // ends a session, since its values are gone with it, and starts one without a cell, as they
    // manage the sessions' processes. An Agent's first cell starts its session.
    if (method.startsWith('kernel.')) {
      if (method === 'kernel.stop') requireThat(principal.id === localBrowserId, 'unauthorized', 'Only the person at this machine ends a live session. Open Rho in a browser on this machine.');
      if (method === 'kernel.start') requireThat(principal.id === localBrowserId, 'unauthorized', 'Only the person at this machine starts a session without a cell. Run a cell to start one.');
      await capabilities.assertAvailable(method, principal);
      const host = this.kernelFor(p);
      if (method === 'kernel.run') return host.run({ language: b.language, code: b.code, purpose: b.purpose, notebook: b.notebook, changeId: b.changeId, by: principal.id, waitMs: b.waitMs, place: b.place, interpreter: b.interpreter });
      if (method === 'kernel.read') return host.read(b.limit, b.cellId);
      if (method === 'kernel.events') return host.events(b.limit);
      if (method === 'kernel.inspect') return host.inspect({ language: b.language, notebook: b.notebook, name: b.name, path: b.path, offset: b.offset, limit: b.limit, sort: b.sort, picture: b.picture });
      if (method === 'kernel.plot') return host.plot(b.cellId, b.plot);
      if (method === 'kernel.interrupt') return host.interrupt(b.cellId, principal.id);
      if (method === 'kernel.start') return host.start({ language: b.language, place: b.place, notebook: b.notebook }, principal.id);
      if (method === 'kernel.stop') return host.stop(b.sessionId, principal.id);
      // Places on servers: the person and their Agent name, check and choose them, and list and
      // copy their files, each through serverctl or with the person's own ssh setup. The servers
      // serverctl manages, and the skills bound to each, are read from its registry.
      if (method === 'kernel.places') return host.places();
      if (method === 'kernel.place.set') return host.setPlace({ place: b.place, remove: b.remove, use: b.use }, principal.id);
      if (method === 'kernel.place.check') return host.check(b.placeId, principal.id);
      if (method === 'kernel.place.list') return host.list(b.placeId, b.path ?? '');
      if (method === 'kernel.place.copy') return host.copy(b.placeId, b.path, principal.id);
      if (method === 'kernel.servers') return host.servers();
      if (method === 'kernel.server.skill') return host.serverSkill(b.server, b.name);
    }
    // A plot the live R session drew, with its marks bound to their rows. The person and their
    // Agent read it and keep the marks they point to; a kept selection reaches open pages.
    if (method.startsWith('figure.')) {
      await capabilities.assertAvailable(method, principal);
      const figures = this.figuresFor(p);
      const ref = { cellId: b.cellId, plot: b.plot, path: b.path, sha256: b.sha256 };
      if (method === 'figure.read') return figures.read({ ...ref, form: b.form, marks: b.marks, selection: b.selection, where: b.where, limit: b.limit });
      if (method === 'figure.select') {
        const result = await figures.select({ ...ref, marks: b.marks, note: b.note, changeId: b.changeId }, principal.id);
        const kept = result.selection;
        await this.emit(p, 'figure.changed', kept.sha256 ? 'file:' + kept.sha256 : kept.cellId + ':' + kept.plot, principal.id);
        return result;
      }
    }
    // How work is done in the project: the person and their Agent read its skills, and record and
    // undo changes to them, each kept with who made it, why and from what.
    if (method.startsWith('skills.')) {
      await capabilities.assertAvailable(method, principal);
      const host = this.skillsFor(p);
      if (method === 'skills.list') return host.list();
      if (method === 'skills.read') return host.read(b.name, b.limit);
      if (method === 'skills.change') return host.change({ name: b.name, description: b.description, body: b.body, remove: b.remove, reason: b.reason, evidence: b.evidence, expectedVersion: b.expectedVersion, changeId: b.changeId }, principal.id);
      if (method === 'skills.undo') return host.undo({ name: b.name, change: b.change, changeId: b.changeId }, principal.id);
    }
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
    // Both register the run's declared outputs; a tab shows them once it reads the snapshot again.
    if (method === 'resource.list') { const result = await requests.artifacts(principal, b.operationId); await this.emit(p, 'resource.changed', b.operationId); return result; }
    if (method === 'artifact.check') { const result = await requests.check(principal, b.operationId); await this.emit(p, 'resource.changed', b.operationId); return result; }
    if (method === 'action.export') {
      const run = await requests.lookup(principal, b.operationId, true), files = owners.need('files');
      return exportRun(p, run, { destination: b.destination, unsaved: b.unsaved, documents: owners.documents, resources: await files.list(), maxFileBytes: files.limits.maxFileBytes,
        sourceFile: async relative => (await files.sourceFile(relative)).file, submittedBy: authorKind(run.principal), exit: exitWords(run.native?.status?.Finished?.exit), projectName: p.name ?? path.basename(p.root) });
    }
    if (method.startsWith('agent.activity.')) {
      owners.need('agent');
      const agent = this.plugins.need('agent');
      if (method === 'agent.activity.read') {
        const capability = await this.bridge.capability(p.root);
        requireThat(capability.exitCode === 0 && capability.reply.value?.limits?.activity, 'unavailable', 'The project activity Host is unavailable or lacks the selected activity capability. Reconnect observes it without starting or restarting it.');
        return agent.readAgentActivity(async (command, args) => {
          const result = await this.bridge.call(p.root, command, 'rho-agent-observe', undefined, args);
          requireThat(result.exitCode === 0 && result.reply.ok, 'unavailable', 'Activity could not be read. Preserve the original session and reconnect to its Host.');
          return result.reply.value;
        }, b.streamId, b.after);
      }
      if (method === 'agent.activity.outputs') return agent.activityOutputs(p.root, b.directory);
      if (method === 'agent.activity.capture') {
        const files = owners.need('files');
        const capture = { restore: files.restore.bind(files), captureBytes: files.captureBytes.bind(files), validateDeclaration: (declaration: Parameters<typeof files.validateDeclaration>[0]) => {
          requireThat(selection.enabled.includes(declaration.kind === 'table' ? 'tables' : 'media'), 'unavailable', 'Enable the output type owner before opening this file.');
          files.validateDeclaration(declaration);
        } };
        const result = await agent.captureActivityArtifact(p.root, p.id, b.path, b.expectedDigest, capture,
          owners.tables ? this.plugins.need('tables').lexicalCsvDeclaration : undefined);
        await this.emit(p, 'resource.changed', result.id); return result;
      }
    }
    if (method === 'evidence.preview' || method === 'evidence.export') {
      requireThat(principal.id === localBrowserId, 'scope', 'Only the person at this machine selects an evidence export.');
      const exporter = new EvidenceExporter(p.root, { thread: id => owners.need('annotations').read(id), resources: () => owners.need('files').list(), bytes: ref => owners.need('files').bytes(ref), observations: id => this.conversations.reviewEvidence(p,id), ...(owners.tables?{table: (ref: any) => owners.need('tables').page(ref,0,200)}:{}) },this.config.evidence);
      return method === 'evidence.preview' ? exporter.preview(b.annotationId) : exporter.export(b);
    }
    if (method === 'resource.capture') {
      const files = owners.need('files');
      let result;
      if (b.document) {
        const snapshot = await owners.need('documents').snapshot(b.document.documentId, b.document.version);
        requireThat(!b.declaration, 'invalid', 'Buffer captures use their document path and text format.');
        result = await files.captureBytes(Buffer.from(snapshot.code), { path: String(snapshot.source.path), kind: 'file', format: { mimeType: 'text/plain' } }, snapshot.source, b.expectedDigest);
      } else result = await files.capture(b.path, { expectedDigest: b.expectedDigest, declaration: b.declaration });
      await this.emit(p, 'resource.changed', result.id); return result;
    }
    if (method === 'resource.register') {
      requireThat(!b.declaration.path.split('/').some((part: string) => ['.rho', '.git'].includes(part)), 'scope', 'Register a project file outside internal state.');
      const registered = publicResource(await owners.need('files').register(b.declaration.path, { operationId: 'registration:' + digest(canonical(b.declaration)), registeredBy: principal.id }, 'available', {}, b.declaration, b.expectedDigest));
      await this.emit(p, 'resource.changed', registered.id); return registered;
    }
    if (method === 'object.read') return owners.need('objects').read(b.resource);
    if (method === 'media.describe') return owners.need('media').describe(b.resource);
    if (method === 'resource.read') return owners.need('files').read(b.resource, b.offset, b.maxBytes);
    if (method === 'data.page') return owners.need('tables').page(b.resource, b.offset, b.limit, b.sort, b.filter);
    if (method === 'data.plot') return owners.need('charts').plot(b.resource, b.x, b.y, b.maxPoints);
    if (method === 'data.compare') return owners.need('tables').compare(b.left, b.right, b.options);
    if (['composition.apply', 'composition.undo', 'composition.delete', 'view.protection.set'].includes(method)) {
      if (method === 'composition.delete' && (await routing.read())?.compositionId === b.compositionId) {
        const retained = await workspace.read(b.compositionId);
        requireThat(retained.receipts?.some((r: any) => r.changeId === b.changeId), 'condition', 'An active task uses this layout.');
      }
      const result = await workspace.apply(b, principal.id, method === 'composition.undo' ? 'undo' : method === 'composition.delete' ? 'delete' : method === 'view.protection.set' ? 'protect' : 'apply');
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
      if (method === 'annotation.decide') requireThat(principal.kind === 'browser', 'unauthorized', 'Only a browser person records a review decision.');
      const result = method === 'annotation.decide' ? await a.decide(b, principal.id, true) : method === 'annotation.create' ? await a.create(b, principal.id) : await a.reply(b, principal.id);
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
    if (method === 'observation.snapshot') return { project: p, catalog: await capabilities.catalog(principal), documents: await owners.documentSummaries(), operations: (await requests.list(principal)).map(publicOperation), resources: (await owners.retainedResources()).map(publicResource), compositions: await workspace.compositions(), feedback: await routing.feedbackConfiguration().then(async configuration => { const route = await routing.read(); return configuration ? { taskId: route.taskId, compositionId: route.compositionId, taskVersion: route.version, targetBindingId: route.feedbackOwnerBindingId, draftDocumentId: configuration.draftDocumentId, relatedDocumentId: configuration.relatedDocumentId } : null; }), presentation: await routing.read().then(async route => route ? { taskId: route.taskId, pending: (await new Presentation(p, workspace, this.config.presentationWitness, this.config.visibility).state()).pending ?? null, witnesses: await new Presentation(p, workspace, this.config.presentationWitness, this.config.visibility).witnesses() } : null), interactions: await interactions.list(principal.id), taskMap: await new TaskMap(p, this.config.taskMap).read(), annotations: await owners.retainedAnnotations(), contexts: await owners.agent?.contextStates(principal.id) ?? [], activity: await this.projectActivity(p), agents: await this.agentSummaries(p), conversations: principal.id === localBrowserId ? await this.conversations.list(p) : [], selection: await readJson(path.join(await this.dataDir(p), 'selection.json'), null), bindings: (await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), [])).filter(x => x.principal === principal.id), cursor: (await this.events(p)).cursor, host: await this.bridge.capability(p.root), limits: { ...serviceLimits, ...requestLimits, conversations:this.conversations.limits,evidence:{...evidenceExportLimits,...this.config.evidence}, documents: owners.documents?.limits ?? {}, r: this.plugins.optional('r') ? { ...this.plugins.need('r').executionLimits, ...this.config.r } : {}, resources: { ...owners.files?.limits, ...owners.tables?.limits, ...owners.charts?.limits }, ...Object.fromEntries(Object.entries(this.config).filter(([, v]) => typeof v === 'number')) } };
    throw new Fault('unavailable', 'This catalog operation has not been installed.', { operation: method });
  }
  private async events(p: Project) { return readJson<any>(path.join(await this.dataDir(p), 'events.json'), { cursor: 0, events: [] }); }
  async emit(p: Project, type: string, subject: string, principal?: string) {
    // Once closed the project's state is released; a change noted late (a page's debounce) is
    // not written after it, where it would race whoever removes or reopens the project next.
    if (this.closed) return;
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
    this.extensions.close();
    this.closing = true;
    this.folderPicker.close();
    for (const s of this.subscribers) s.response.end();
    // A tab's keep-alive connection whose request was in flight would hold close() open until
    // its keep-alive timeout, longer than the tab waits to reconnect; each closes once idle.
    const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
    const idle = setInterval(() => this.server.closeIdleConnections(), 25);
    await closed; clearInterval(idle);
    // A message being answered is stopped and recorded as stopped; the conversation continues
    // after the next start, and nothing is sent again on its behalf.
    await this.conversations.close();
    // Commands the person started keep running; the next start records how each is found.
    for (const runner of this.consoles.values()) await runner.close();
    for (const host of this.terminals.values()) await host.shutdown();
    // Live sessions end with Rho: their values live only in their processes.
    for (const host of this.kernels.values()) await host.close();
    for (const host of this.skillHosts.values()) await host.close();
    // What the projects' queues already hold is written before their state is released.
    while (this.queues.size) await Promise.allSettled([...this.queues.values()]);
    this.closed = true;
    const shutdown = await this.bridge.close(); await this.state.close(); return shutdown;
  }
}
