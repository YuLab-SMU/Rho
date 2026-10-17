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
import { serveWeb } from './web-assets.js';
export const serviceLimits = { maxRequestBytes: 1024 * 1024, maxEventBytes: 65536, eventRetention: 256, maxSubscriptions: 8, maxQueue: 32, maxContexts: 128, maxBindings: 64, maxActivities: 256, maxContextBytes: 1024 * 1024, maxRetainedMetadataBytes: 32 * 1024 * 1024 };
export interface ServiceConfig extends Partial<typeof serviceLimits>, Partial<typeof requestLimits>, PluginConfig { root: string; stateDir: string; coreBinary: string; rscript: string; port?: number; workspace?: Partial<typeof workspaceLimits>; interactions?: Partial<typeof interactionLimits>; browser?: Partial<typeof browserLimits>; webRoot?: string }
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const legacyValidators = Object.fromEntries(Object.entries(legacyProtocol.operations).map(([k, v]) => [k, ajv.compile<any>(v)]));
const validators = Object.fromEntries(Object.entries(operations).map(([k, v]) => [k, ajv.compile<any>(v)]));
export class RhoService {
  plugins: Plugins; state: State; bridge: CoreBridge; url = ''; adminToken = ''; server: http.Server;
  private queues = new Map<string, Promise<any>>();
  private queued = new Map<string, number>();
  private subscribers = new Set<{ projectId: string; principal: string; tokenHash: string; response: http.ServerResponse }>();
  browser: BrowserAccess;
  constructor(public config: ServiceConfig) {
    for (const [key, value] of Object.entries({ ...serviceLimits, ...requestLimits, ...config.documents, ...config.resources, ...config.workspace, ...config.interactions, ...config.annotations, ...config.capabilityLimits, ...config.r, ...config.browser, ...config })) {
      if (typeof value === 'number') requireThat(Number.isSafeInteger(value) && (key === 'port' ? value >= 0 && value <= 65535 : value > 0), 'invalid', 'Invalid service budget.', { field: key });
    }
    this.plugins = new Plugins(config);
    this.state = new State(config.root, config.stateDir); this.bridge = new CoreBridge(config.coreBinary, config.rscript);
    this.browser = new BrowserAccess(this.state, config.browser);
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
  }
  async start() {
    try {
    await this.plugins.load();
    await this.state.init();
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
  async agentConnection(projectId: string, externalSessionId: string, file: string, methods?: string[], pluginFilter?: string[]) {
    const project = await this.state.project(projectId, this.state.principals.find(p => p.id === 'operator')!);
    this.plugins.need('agent');
    const capabilities = new Capabilities(this.plugins, project);
    const state = await capabilities.state();
    const available = Object.keys(operations).filter(m => !m.startsWith('session.') && !m.startsWith('project.') && !m.startsWith('requirements.prepare') && !m.startsWith('workspace.restore'));
    const selected = methods ?? (await Promise.all(available.map(async method => [method, await capabilities.isAvailable(method, state)] as const))).filter(([, enabled]) => enabled).map(([method]) => method);
    requireThat(selected.every(m => !!operations[m] && !m.startsWith('session.') && !m.startsWith('project.')), 'invalid', 'Unknown or operator-only Agent capability.');
    requireThat(await Promise.all(selected.map(method => capabilities.isAvailable(method, state))).then(values => values.every(Boolean)), 'unavailable', 'A requested Agent operation has no selected provider.');
    const token = randomBytes(32).toString('hex');
    const id = 'agent:' + digest(projectId + ':' + externalSessionId).slice(0, 32);
    this.state.principals = this.state.principals.filter(p => p.id !== id);
    requireThat(!pluginFilter || pluginFilter.every(id => this.plugins.isKnown(id)), 'invalid', 'Unknown MCP plugin filter.');
    await this.state.addPrincipal({ id, tokenHash: digest(token), projectId, methods: [...new Set(['protocol.describe', 'capability.list', ...selected])] });
    const connection = { url: this.url, token, projectId, externalSessionId, methods: selected, ...(pluginFilter ? { pluginFilter } : {}), apiVersion: '2.0' as const };
    await atomicJson(file, connection); return connection;
  }
  private authenticate(req: http.IncomingMessage, method: string) {
    requireThat(req.headers.host === new URL(this.url).host, 'origin', 'Host header does not match the local service.');
    if (req.headers.origin) requireThat(req.headers.origin === this.url, 'origin', 'Origin is not authorized for this service.');
    const hash = digest((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const principal = this.state.principals.find(p => timingSafeEqual(Buffer.from(p.tokenHash, 'hex'), Buffer.from(hash, 'hex')));
    requireThat(principal, 'unauthorized', 'A valid local session credential is required.');
    requireThat(!principal.expiresAt || Date.parse(principal.expiresAt) > Date.now(), 'unauthorized', 'Browser session expired. Pair again using the local operator entry.');
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
      const url = new URL(req.url ?? '/', this.url);
      requireThat(req.headers.host === new URL(this.url).host && (!req.headers.origin || req.headers.origin === this.url), 'origin', 'Host or Origin is not authorized for this local service.');
      if (url.pathname === '/api/browser/pair') {
        requireThat(req.headers.origin === this.url, 'origin', 'Pair from the same-origin browser entry.');
        requireThat(!url.search && req.method === 'POST' && req.headers['content-type']?.split(';')[0] === 'application/json', 'invalid', 'Pairing uses a same-origin JSON POST without URL credentials.');
        const body = await this.readBody(req, 1024);
        requireThat(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && 'code' in body, 'invalid', 'Pairing accepts only the one-time code.');
        this.json(res, 200, { apiVersion: '2.0', ok: true, value: await this.serial('browser:sessions', () => this.browser.pair(body.code)) }); return;
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
      if (body.projectId) {
        value = await this.serial(body.projectId, async () => {
          try {
            const result = await this.dispatch(method, body, principal);
            await this.recordActivity(principal, method, body, result); return result;
          } catch (e) {
            await this.recordActivity(principal, method, body, undefined, e instanceof Fault ? e.kind : 'storage'); throw e;
          }
        });
      } else value = method === 'protocol.describe' && legacy ? legacyProtocol : await this.dispatch(method, body, principal);
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
  async dispatch(method: string, b: any, principal: Principal): Promise<any> {
    requireThat(this.state.principals.some(current => current.id === principal.id && current.tokenHash === principal.tokenHash && current.methods.includes(method) && (!current.expiresAt || Date.parse(current.expiresAt) > Date.now())), 'unauthorized', 'Session authorization expired or was revoked before this operation.');
    if (method === 'protocol.describe') return protocol;
    if (method.startsWith('session.browser.')) {
      requireThat(principal.id === 'operator', 'unauthorized', 'Only the local operator may pair or revoke browser sessions.');
      if (method === 'session.browser.pair') return this.serial('browser:sessions', async () => this.browser.createPairing(await confined(this.state.root, b.path ?? '.')));
      const result = await this.serial('browser:sessions', () => this.state.revokeBrowser(b.sessionId));
      for (const s of this.subscribers) if (s.principal === b.sessionId) s.response.end('event: session.invalid\ndata: {}\n\n');
      return result;
    }
    if (method === 'project.list') return this.state.projects.filter(p => (!principal.projectId || p.id === principal.projectId) && (!principal.projectRoot || p.root === principal.projectRoot || p.root.startsWith(principal.projectRoot + path.sep)));
    if (method === 'project.create' || method === 'project.open') {
      const root = principal.projectRoot ?? this.state.root;
      const relative = method === 'project.create' ? b.name : b.path;
      requireThat(!relative.split(/[\\/]/).some((part: string) => ['.rho', '.git'].includes(part)), 'scope', 'Internal owner state is not a project.');
      const target = await confined(root, relative, method === 'project.create');
      if (method === 'project.create') await fs.mkdir(target);
      const p = await this.state.open(path.relative(this.state.root, target) || '.');
      return method === 'project.create' ? p : { ...p, host: await this.bridge.capability(p.root) };
    }
    const p = await this.state.project(b.projectId, principal);
    const owners = this.plugins.project(p.root, p.id);
    const requests = new Requests(p, this.bridge, (type, subject) => this.emit(p, type, subject), this.config, owners);
    const workspace = new Workspace(p, owners, this.config.workspace, this.config.interactions);
    const interactions = new Interactions(p, owners, this.config.interactions);
    if (method === 'session.grant') {
      requireThat(principal.id === 'operator', 'unauthorized', 'Only the local operator may provision a project-scoped session.');
      const file = path.join(this.state.directory, 'agent-' + digest(p.id + ':' + b.externalSessionId) + '.json');
      await this.agentConnection(p.id, b.externalSessionId, file, b.methods);
      return { connectionFile: file, projectId: p.id, methods: b.methods, transport: 'stdio-mcp', externalSessionId: b.externalSessionId };
    }
    const capabilities = new Capabilities(this.plugins, p);
    if (method === 'capability.list') return { ...await capabilities.catalog(principal), host: await this.bridge.capability(p.root) };
    if (method === 'capability.configure') { const result = await capabilities.configure(b, principal.id); await this.emit(p, 'capability.changed', p.id); return result; }
    if (method === 'skill.list') return capabilities.skills(principal);
    if (method === 'skill.read') return capabilities.readSkill(principal, b.skillId, b.expectedDigest);
    // Source ports see the same effective project selection as direct methods.
    // Thus a composition/context cannot use a disabled provider indirectly.
    const selection = await capabilities.state();
    for (const [port, method] of Object.entries({ documents: 'document.read', files: 'resource.read', tables: 'data.page', charts: 'data.plot', media: 'media.describe', objects: 'object.read', annotations: 'annotation.read' })) {
      if (!await capabilities.isAvailable(method, selection)) (owners as any)[port] = undefined;
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
      requireThat(b.expectedVersion > 0 || (await workspace.compositions()).length < workspace.limits.maxCompositions, 'limit', 'Composition retention limit reached.');
      const result = await workspace.structured().transact(b, principal.id, method === 'composition.undo' ? 'undo' : method === 'view.protection.set' ? 'protect' : 'apply');
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
      if (method === 'document.edit') result = await d.edit(b.documentId, b.expectedVersion, b.edits, b.undoGroup, principal.id);
      if (method === 'document.undo') result = await d.undo(b.documentId, b.expectedVersion, principal.id);
      if (method === 'document.save') result = await d.save(b.documentId, b.expectedVersion, b.expectedDiskDigest, principal.id);
      if (!['document.read', 'document.open'].includes(method)) await this.emit(p, 'document.changed', b.documentId);
      return result;
    }
    if (method === 'binding.activity') return owners.need('agent').activity(principal.id);
    if (method === 'binding.list') return owners.need('agent').bindings(principal.id);
    if (method.startsWith('binding.')) {
      const result = await owners.need('agent').binding(method, principal.id, b.externalSessionId);
      await this.emit(p, 'binding.changed', result.id); return result;
    }
    if (method === 'context.create') { const result = await owners.need('agent').createContext(b, principal.id); await this.emit(p, 'context.changed', result.contextId, principal.id); return result; }
    if (method === 'context.read') { const result = await owners.need('agent').readContext(b.contextId, principal.id); await this.emit(p, 'context.changed', result.contextId, principal.id); if (result.principal !== principal.id) await this.emit(p, 'context.changed', result.contextId, result.principal); return result; }
    if (method === 'observation.snapshot') return { project: p, catalog: await capabilities.catalog(principal), documents: await owners.retainedDocuments(), operations: (await requests.list(principal)).map(publicOperation), resources: (await owners.retainedResources()).map(publicResource), compositions: await workspace.compositions(), interactions: await interactions.list(principal.id), annotations: await owners.retainedAnnotations(), contexts: await owners.agent?.contextStates(principal.id) ?? [], selection: await readJson(path.join(await this.dataDir(p), 'selection.json'), null), bindings: (await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), [])).filter(x => x.principal === principal.id), cursor: (await this.events(p)).cursor, host: await this.bridge.capability(p.root), limits: { ...serviceLimits, ...requestLimits, documents: owners.documents?.limits ?? {}, r: this.plugins.optional('r') ? { ...this.plugins.need('r').executionLimits, ...this.config.r } : {}, resources: { ...owners.files?.limits, ...owners.tables?.limits, ...owners.charts?.limits }, ...Object.fromEntries(Object.entries(this.config).filter(([, v]) => typeof v === 'number')) } };
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
    for (const s of this.subscribers) s.response.end();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    const shutdown = await this.bridge.close(); await this.state.close(); return shutdown;
  }
}
