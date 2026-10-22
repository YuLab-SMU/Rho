import { Discovery } from './discovery.js';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Ajv } from 'ajv';
import { atomicJson, canonical, confined, digest, Fault, now, publicResource, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
import { Plugins, type PluginConfig } from './plugins.js';
import { protocol, operations } from './protocol.js';
import { protocol as legacyProtocol } from './legacy-protocol.js';
import { legacyResponse } from './legacy-response.js';
import { CoreBridge } from './bridge.js';
import { State, type Principal, type Project } from './state.js';
import { Requests, publicOperation, requestLimits } from './requests.js';
import { Workspace, workspaceLimits } from './workspace.js';
import { Interactions, interactionLimits } from './interactions.js';
import { Capabilities } from './capabilities.js';
import { BrowserAccess, browserLimits } from './browser-access.js';
import { NativeFolderPicker, nativeFolderLimits } from './native-folders.js';
import { homedir } from 'node:os';
import { serveWeb, webRoot } from './web-assets.js';
import { Presentation, presentationWitnessLimits, visibilityLimits } from './presentation.js';
import { presentationSchemas } from './presentation-contracts.js';
import { isNativeTime } from './native-contracts.js';
import { TaskRouting } from './task-routing.js';
import type { nativeActivityLimits, agentDeliveryLimits } from '@rho-workspace/plugin-agent';
import { feedbackSchemas } from './feedback-contracts.js';
export interface FeedbackTransport { accept(envelope: any): Promise<any>; lookup(envelope: any): Promise<any> }
export interface NativeAdapterRegistration {
  projectId: string; taskId: string; registrationId: string; principal: string; adapterPrincipal: string;
  externalSessionId: string; transportCapabilities: Record<string, unknown>;
  proof: { kind: 'claude-code-init'; sessionId: string; clientVersion: string };
}
export const serviceLimits = { maxRequestBytes: 1024 * 1024, maxEventBytes: 65536, eventRetention: 256, maxSubscriptions: 8, maxQueue: 32, maxContexts: 128, maxBindings: 64, maxActivities: 256, maxContextBytes: 1024 * 1024, maxRetainedMetadataBytes: 32 * 1024 * 1024 };
export interface ServiceConfig extends Partial<typeof serviceLimits>, Partial<typeof requestLimits>, PluginConfig { root: string; stateDir: string; coreBinary: string; rscript: string; port?: number; nativeFolders?: Partial<typeof nativeFolderLimits>; workspace?: Partial<typeof workspaceLimits>; interactions?: Partial<typeof interactionLimits>; browser?: Partial<typeof browserLimits>; webRoot?: string; agentNativeActivity?: Partial<typeof nativeActivityLimits>; presentationWitness?: Partial<typeof presentationWitnessLimits>; visibility?: Partial<typeof visibilityLimits>; agentDelivery?: Partial<typeof agentDeliveryLimits>; deliveryTransportTimeoutMs?: number }
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
ajv.addFormat('date-time', { type: 'string', validate: isNativeTime });
const legacyValidators = Object.fromEntries(Object.entries(legacyProtocol.operations).map(([k, v]) => [k, ajv.compile<any>(v)]));
const validators = Object.fromEntries(Object.entries(operations).map(([k, v]) => [k, ajv.compile<any>(v)]));
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
    requireThat(ajv.validate<any>(feedbackSchemas.DeliveryEnvelope, envelope), 'invalid', 'Malformed original delivery envelope.');
    const project = await this.feedbackProject(envelope.projectId);
    return this.serial(project.id, async () => { const receipt = await this.feedback(project).accept(envelope); await this.emit(project, 'feedback.changed', envelope.deliveryId); return receipt; });
  }
  async lookupFeedback(envelope: any) {
    const input = Object.fromEntries(['projectId', 'taskId', 'deliveryId', 'requestDigest', 'targetBindingId', 'externalSessionId'].map(k => [k, envelope[k]]));
    requireThat(ajv.validate<any>(feedbackSchemas.InboxLookupInput, input), 'invalid', 'Malformed original inbox lookup.');
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
  async agentConnection(projectId: string, externalSessionId: string, file: string, methods?: string[], pluginFilter?: string[], profile?: 'layered-business' | 'layered-presentation') {
    requireThat(profile === undefined || ['layered-business', 'layered-presentation'].includes(profile), 'invalid', 'Choose an explicitly supported layered profile.');
    const project = await this.state.project(projectId, this.state.principals.find(p => p.id === 'operator')!);
    this.plugins.need('agent');
    const capabilities = new Capabilities(this.plugins, project);
    const state = await capabilities.state();
    const available = Object.keys(operations).filter(m => !m.startsWith('session.') && !m.startsWith('project.') && !m.startsWith('requirements.prepare') && !m.startsWith('workspace.restore') && !['task.routing.put', 'binding.activity.append', 'feedback.submit', 'view.observe', 'view.observations.read'].includes(m));
    const profileMethods = profile === 'layered-presentation' ? ['binding.open', 'capability.index', 'capability.resolve', 'workspace.observe', 'workspace.enhance'] : available.filter(m => !['workspace.observe', 'workspace.enhance'].includes(m));
    const selected = methods ?? (profile === 'layered-presentation' ? profileMethods : (await Promise.all(profileMethods.map(async method => [method, await capabilities.isAvailable(method, state)] as const))).filter(([, enabled]) => enabled).map(([method]) => method));
    requireThat(!profile || selected.every(m => profileMethods.includes(m)), 'scope', 'The selected role cannot receive broader methods.');
    requireThat(selected.every(m => !!operations[m] && !m.startsWith('session.') && !m.startsWith('project.') && m !== 'task.routing.put'), 'invalid', 'Unknown or operator-only Agent capability.');
    requireThat(await Promise.all(selected.map(method => capabilities.isAvailable(method, state))).then(values => values.every(Boolean)), 'unavailable', 'A requested Agent operation has no selected provider.');
    requireThat(!profile || new Set(['capability.index', 'capability.resolve', ...selected]).size <= 64, 'limit', 'Layered connection methods exceed the selected 64-method profile; choose an explicit narrower grant.');
    const token = randomBytes(32).toString('hex');
    const id = 'agent:' + digest(projectId + ':' + externalSessionId).slice(0, 32);
    this.state.principals = this.state.principals.filter(p => p.id !== id);
    requireThat(!pluginFilter || pluginFilter.every(id => this.plugins.isKnown(id)), 'invalid', 'Unknown MCP plugin filter.');
    await this.state.addPrincipal({ id, tokenHash: digest(token), projectId, methods: [...new Set([...(profile ? ['capability.index', 'capability.resolve'] : ['protocol.describe', 'capability.list']), ...selected])], ...(profile ? { profile } : {}), ...(pluginFilter ? { pluginFilter } : {}) });
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
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
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
      const legacy = url.pathname.startsWith('/api/v1/');
      apiVersion = legacy ? '1.0' : '2.0';
      const method = legacy || url.pathname.startsWith('/api/v2/') ? url.pathname.slice(8) : '';
      requireThat(method === 'events' || !!operations[method], 'not_found', 'Unknown API operation.');
      const principal = this.authenticate(req, method);
      if (method === 'events') { requireThat(req.method === 'GET', 'invalid', 'Events use GET.'); await this.subscribe(url, principal, res); return; }
      requireThat(req.method === 'POST' && req.headers['content-type']?.split(';')[0] === 'application/json', 'invalid', 'Use POST with application/json.');
      const body = await this.readBody(req, this.config.maxRequestBytes ?? 1024 * 1024);
      const valid = (legacy ? legacyValidators : validators)[method];
      requireThat(valid, 'unavailable', 'This operation requires the v2 contract.');
      requireThat(valid(body), 'invalid', 'Request does not match the versioned schema.', { fields: valid.errors ?? [] });
      if (legacy && !['protocol.describe', 'action.lookup', 'action.observe', 'action.retry', 'action.cancel', 'action.output', 'action.list', 'resource.read', 'resource.list', 'document.open', 'document.read', 'context.read', 'binding.list', 'binding.activity', 'composition.read', 'observation.snapshot', 'project.list'].includes(method)) throw new Fault('unavailable', 'New writes use the explicit v2 project contract; accepted v1 operations remain observable.');
      let value;
      if (body.projectId && method !== 'project.source.add') {
        value = await this.serial(body.projectId, async () => {
          try {
            const result = await this.dispatch(method, body, principal, typeof req.headers['x-rho-contract-ref'] === 'string' ? req.headers['x-rho-contract-ref'] : undefined);
            await this.recordActivity(principal, method, body, result); return result;
          } catch (e) {
            await this.recordActivity(principal, method, body, undefined, e instanceof Fault ? e.kind : 'storage'); throw e;
          }
        });
      } else value = method === 'protocol.describe' && legacy ? legacyProtocol : await this.dispatch(method, body, principal, typeof req.headers['x-rho-contract-ref'] === 'string' ? req.headers['x-rho-contract-ref'] : undefined);
      if (legacy && method === 'protocol.describe') value = legacyProtocol;
      else if (legacy) value = legacyResponse(value);
      this.json(res, 200, { apiVersion, ok: true, value });
    } catch (e: any) {
      const fault = e instanceof Fault ? e : new Fault(e.code === 'ENOENT' ? 'not_found' : 'storage', e.code === 'ENOENT' ? 'Requested owner record or file is missing.' : 'The operation could not be confirmed; retain the original identity and inspect its state.');
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
    const p = await this.state.project(body.projectId, principal);
    await this.plugins.project(p.root, p.id).agent?.recordActivity(principal.id, method, body, result, errorKind);
  }
  private async dataDir(p: Project) { return stateDirectory(p.root, '.rho/rho'); }
  async dispatch(method: string, b: any, principal: Principal, contractRef?: string): Promise<any> {
    requireThat(this.state.principals.some(current => current.id === principal.id && current.tokenHash === principal.tokenHash && current.methods.includes(method) && (!current.expiresAt || Date.parse(current.expiresAt) > Date.now())), 'unauthorized', 'Session authorization expired or was revoked before this operation.');
    if (method === 'protocol.describe') return protocol;
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
    if (method === 'session.grant') {
      requireThat(principal.id === 'operator', 'unauthorized', 'Only the local operator may provision a project-scoped session.');
      const file = path.join(this.state.directory, 'agent-' + digest(p.id + ':' + b.externalSessionId) + '.json');
      await this.agentConnection(p.id, b.externalSessionId, file, b.methods, undefined, b.profile);
      return { ...(b.profile ? { profile: b.profile } : {}), connectionFile: file, projectId: p.id, methods: b.methods, transport: 'stdio-mcp', externalSessionId: b.externalSessionId };
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
    if (method === 'action.lookup') return publicOperation(await requests.lookup(principal, b.operationId));
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
    if (method === 'context.create') { const result = await owners.need('agent').createContext(b, principal.id); await this.emit(p, 'context.changed', result.contextId, principal.id); return result; }
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
    if (method === 'observation.snapshot') return { project: p, catalog: await capabilities.catalog(principal), documents: await owners.retainedDocuments(), operations: (await requests.list(principal)).map(publicOperation), resources: (await owners.retainedResources()).map(publicResource), compositions: await workspace.compositions(), feedback: await routing.feedbackConfiguration().then(async configuration => { const route = await routing.read(); return configuration ? { taskId: route.taskId, compositionId: route.compositionId, taskVersion: route.version, targetBindingId: route.feedbackOwnerBindingId, draftDocumentId: configuration.draftDocumentId, relatedDocumentId: configuration.relatedDocumentId } : null; }), presentation: await routing.read().then(async route => route ? { taskId: route.taskId, pending: (await new Presentation(p, workspace, this.config.presentationWitness, this.config.visibility).state()).pending ?? null, witnesses: await new Presentation(p, workspace, this.config.presentationWitness, this.config.visibility).witnesses() } : null), interactions: await interactions.list(principal.id), annotations: await owners.retainedAnnotations(), contexts: await owners.agent?.contextStates(principal.id) ?? [], selection: await readJson(path.join(await this.dataDir(p), 'selection.json'), null), bindings: (await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), [])).filter(x => x.principal === principal.id), cursor: (await this.events(p)).cursor, host: await this.bridge.capability(p.root), limits: { ...serviceLimits, ...requestLimits, documents: owners.documents?.limits ?? {}, r: this.plugins.optional('r') ? { ...this.plugins.need('r').executionLimits, ...this.config.r } : {}, resources: { ...owners.files?.limits, ...owners.tables?.limits, ...owners.charts?.limits }, ...Object.fromEntries(Object.entries(this.config).filter(([, v]) => typeof v === 'number')) } };
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
