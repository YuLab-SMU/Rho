import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Ajv } from 'ajv';
import { atomicJson, canonical, catalog, checkRequirements, confined, digest, Documents, documentLimits, Fault, now, publicResource, readJson, requireThat, Resources, resourceLimits, stateDirectory } from '@rho-workspace/headless';
import { protocol, operations } from './protocol.js';
import { CoreBridge } from './bridge.js';
import { State, type Principal, type Project } from './state.js';
import { Requests, publicOperation, requestLimits } from './requests.js';
import { Workspace, workspaceLimits } from './workspace.js';
export const serviceLimits = { maxRequestBytes: 1024 * 1024, maxEventBytes: 65536, eventRetention: 256, maxSubscriptions: 8, maxQueue: 32, maxContexts: 128, maxBindings: 64, maxActivities: 256, maxContextBytes: 1024 * 1024 };
export interface ServiceConfig extends Partial<typeof serviceLimits>, Partial<typeof requestLimits> { root: string; stateDir: string; coreBinary: string; rscript: string; port?: number; documents?: Partial<typeof documentLimits>; resources?: Partial<typeof resourceLimits>; workspace?: Partial<typeof workspaceLimits> }
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const validators = Object.fromEntries(Object.entries(operations).map(([k, v]) => [k, ajv.compile<any>(v)]));
export class RhoService {
  state: State; bridge: CoreBridge; url = ''; adminToken = ''; server: http.Server;
  private queues = new Map<string, Promise<any>>();
  private queued = new Map<string, number>();
  private subscribers = new Set<{ projectId: string; principal: string; response: http.ServerResponse }>();
  constructor(public config: ServiceConfig) {
    for (const [key, value] of Object.entries({ ...serviceLimits, ...requestLimits, ...config.documents, ...config.resources, ...config.workspace, ...config })) {
      if (typeof value === 'number') requireThat(Number.isSafeInteger(value) && (key === 'port' ? value >= 0 && value <= 65535 : value > 0), 'invalid', 'Invalid service budget.', { field: key });
    }
    this.state = new State(config.root, config.stateDir); this.bridge = new CoreBridge(config.coreBinary, config.rscript);
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
  }
  async start() {
    try {
    await this.state.init();
    this.adminToken = randomBytes(32).toString('hex');
    this.state.principals = this.state.principals.filter(p => p.id !== 'operator');
    await this.state.addPrincipal({ id: 'operator', tokenHash: digest(this.adminToken), methods: Object.keys(operations) });
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port ?? 0, '127.0.0.1', () => resolve()); });
    this.url = 'http://127.0.0.1:' + (this.server.address() as any).port;
    await atomicJson(path.join(this.state.directory, 'connection.json'), { url: this.url, token: this.adminToken });
    return this;
    } catch (e) {
      if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
      await this.state.close(); throw e;
    }
  }
  async agentConnection(projectId: string, externalSessionId: string, file: string, methods?: string[]) {
    await this.state.project(projectId, this.state.principals.find(p => p.id === 'operator')!);
    const selected = methods ?? Object.keys(operations).filter(m => !m.startsWith('session.') && !m.startsWith('project.') && !m.startsWith('requirements.prepare') && !m.startsWith('workspace.restore'));
    requireThat(selected.every(m => !!operations[m] && !m.startsWith('session.') && !m.startsWith('project.')), 'invalid', 'Unknown or operator-only Agent capability.');
    const token = randomBytes(32).toString('hex');
    const id = 'agent:' + digest(projectId + ':' + externalSessionId).slice(0, 32);
    this.state.principals = this.state.principals.filter(p => p.id !== id);
    await this.state.addPrincipal({ id, tokenHash: digest(token), projectId, methods: [...new Set(['protocol.describe', ...selected])] });
    const connection = { url: this.url, token, projectId, externalSessionId, methods: selected };
    await atomicJson(file, connection); return connection;
  }
  private authenticate(req: http.IncomingMessage, method: string) {
    requireThat(req.headers.host === new URL(this.url).host, 'origin', 'Host header does not match the local service.');
    if (req.headers.origin) requireThat(req.headers.origin === this.url, 'origin', 'Origin is not authorized for this service.');
    const hash = digest((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const principal = this.state.principals.find(p => timingSafeEqual(Buffer.from(p.tokenHash, 'hex'), Buffer.from(hash, 'hex')));
    requireThat(principal, 'unauthorized', 'A valid local session credential is required.');
    requireThat(principal.methods.includes(method === 'events' ? 'observation.snapshot' : method), 'unauthorized', 'Session does not authorize this operation.');
    return principal;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    try {
      const url = new URL(req.url ?? '/', this.url);
      const method = url.pathname.startsWith('/api/v1/') ? url.pathname.slice(8) : '';
      requireThat(method === 'events' || !!operations[method], 'not_found', 'Unknown API operation.');
      const principal = this.authenticate(req, method);
      if (method === 'events') { requireThat(req.method === 'GET', 'invalid', 'Events use GET.'); await this.subscribe(url, principal, res); return; }
      requireThat(req.method === 'POST' && req.headers['content-type']?.split(';')[0] === 'application/json', 'invalid', 'Use POST with application/json.');
      const max = this.config.maxRequestBytes ?? 1024 * 1024;
      let size = 0; const chunks: Buffer[] = [];
      for await (const b of req.iterator({ destroyOnReturn: false })) { size += b.length; if (size > max) { req.resume(); throw new Fault('limit', 'Request exceeds the configured byte limit.', { limit: 'maxRequestBytes', maximum: max }); } chunks.push(b); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Fault('invalid', 'Request is not valid JSON.'); }
      const valid = validators[method]!;
      requireThat(valid(body), 'invalid', 'Request does not match the versioned schema.', { fields: valid.errors ?? [] });
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
      } else value = await this.dispatch(method, body, principal);
      this.json(res, 200, { apiVersion: '1.0', ok: true, value });
    } catch (e: any) {
      const fault = e instanceof Fault ? e : new Fault(e.code === 'ENOENT' ? 'not_found' : 'storage', e.code === 'ENOENT' ? 'Requested owner record or file is missing.' : 'The operation could not be confirmed; retain the original identity and inspect its state.');
      const status = fault.kind === 'unauthorized' ? 401 : ['origin', 'scope'].includes(fault.kind) ? 403 : fault.kind === 'not_found' ? 404 : fault.kind === 'invalid' ? 400 : fault.kind === 'limit' ? 413 : fault.status;
      this.json(res, status, { apiVersion: '1.0', ok: false, error: { kind: fault.kind, message: fault.message, details: fault.details, continuation: ['stale', 'conflict', 'event_gap'].includes(fault.kind) ? 'Read the current owner snapshot and reconcile before another write.' : 'Inspect the stated condition; observe original operations without replaying actions.' } });
    }
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
    const file = path.join(await this.dataDir(p), 'activity.json');
    const retained = await readJson<any>(file, { cursor: 0, entries: [] });
    const entry = { cursor: ++retained.cursor, principal: principal.id, method, at: now(), outcome: errorKind ? 'rejected' : 'returned',
      ...(errorKind ? { errorKind } : {}),
      ...(body.operationId ? { operationId: body.operationId } : {}),
      ...(body.documentId ? { documentId: body.documentId } : {}),
      ...(result?.version ? { returnedVersion: result.version } : {}),
      ...(body.contextId ? { contextId: body.contextId } : {}) };
    retained.entries.push(entry); retained.entries = retained.entries.slice(-(this.config.maxActivities ?? serviceLimits.maxActivities));
    await atomicJson(file, retained);
  }
  private docs(p: Project) { return new Documents(p.root, this.config.documents); }
  private async dataDir(p: Project) { return stateDirectory(p.root, '.rho/rho'); }
  async dispatch(method: string, b: any, principal: Principal): Promise<any> {
    if (method === 'protocol.describe') return protocol;
    if (method === 'project.list') return this.state.projects.filter(p => !principal.projectId || p.id === principal.projectId);
    if (method === 'project.create') { await fs.mkdir(await confined(this.state.root, b.name, true)); return this.state.open(b.name); }
    if (method === 'project.open') { const p = await this.state.open(b.path); const host = await this.bridge.capability(p.root); return { ...p, host }; }
    const p = await this.state.project(b.projectId, principal);
    const resources = new Resources(p.root, p.id, this.config.resources);
    const requests = new Requests(p, this.bridge, (type, subject) => this.emit(p, type, subject), this.config, resources, this.docs(p));
    const workspace = new Workspace(p, this.docs(p), resources, this.config.workspace);
    if (method === 'session.grant') {
      requireThat(principal.id === 'operator', 'unauthorized', 'Only the local operator may provision a project-scoped session.');
      const file = path.join(this.state.directory, 'agent-' + digest(p.id + ':' + b.externalSessionId) + '.json');
      await this.agentConnection(p.id, b.externalSessionId, file, b.methods);
      return { connectionFile: file, projectId: p.id, methods: b.methods, transport: 'stdio-mcp', externalSessionId: b.externalSessionId };
    }
    if (method === 'capability.list') return { ...catalog, host: await this.bridge.capability(p.root) };
    if (method === 'requirements.check') return checkRequirements(p.root, b.action, this.bridge.rscript);
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
    if (method === 'resource.read') return resources.read(b.resource, b.offset, b.maxBytes);
    if (method === 'data.page') return resources.page(b.resource, b.offset, b.limit, b.sort, b.filter);
    if (method === 'data.plot') return resources.plot(b.resource, b.maxPoints);
    if (method === 'data.compare') return resources.compare(b.baseline, b.shrinkage);
    if (method === 'composition.put') { const result = await workspace.put(b); await this.emit(p, 'composition.changed', b.compositionId); return result; }
    if (method === 'composition.read') return workspace.read(b.compositionId);
    if (method === 'view.close') return workspace.closeView(b.compositionId, b.viewId, b.expectedVersion);
    if (method === 'workspace.save') return workspace.save();
    if (method === 'workspace.export') return workspace.export(b.destination);
    if (method === 'workspace.restore') return workspace.restore(b.source, principal.id);
    if (method === 'selection.set') {
      const data = await resources.rows(b.resource);
      requireThat(data.entityKey === 'gene_id', 'condition', 'Selection requires a table with unique stable gene identities.');
      requireThat(b.entities.every((id: string) => data.rows.some(r => r.gene_id === id)), 'stale', 'One or more selected entities are absent from this resource version.');
      const selection = { resource: b.resource, entities: [...new Set(b.entities)], at: now() };
      await atomicJson(path.join(await this.dataDir(p), 'selection.json'), selection); await this.emit(p, 'selection.changed', b.resource.id); return selection;
    }
    if (method.startsWith('document.')) {
      const d = this.docs(p); let result;
      if (method === 'document.open') result = await d.open(b.path, principal.id);
      if (method === 'document.read') result = await d.read(b.documentId);
      if (method === 'document.edit') result = await d.edit(b.documentId, b.expectedVersion, b.edits, b.undoGroup, principal.id);
      if (method === 'document.undo') result = await d.undo(b.documentId, b.expectedVersion, principal.id);
      if (method === 'document.save') result = await d.save(b.documentId, b.expectedVersion, b.expectedDiskDigest, principal.id);
      if (!['document.read', 'document.open'].includes(method)) await this.emit(p, 'document.changed', b.documentId);
      return result;
    }
    if (method === 'binding.activity') {
      const activity = await readJson<any>(path.join(await this.dataDir(p), 'activity.json'), { cursor: 0, entries: [] });
      return { cursor: activity.cursor, retainedFrom: activity.entries[0]?.cursor ?? activity.cursor + 1, entries: activity.entries.filter((x: any) => x.principal === principal.id) };
    }
    if (method.startsWith('binding.')) {
      const file = path.join(await this.dataDir(p), 'bindings.json');
      const bindings = await readJson<any[]>(file, []);
      if (method === 'binding.list') return bindings.filter(x => x.principal === principal.id);
      const key = digest(principal.id + ':' + b.externalSessionId);
      let binding = bindings.find(x => x.id === key);
      if (!binding) { requireThat(bindings.length < (this.config.maxBindings ?? serviceLimits.maxBindings), 'limit', 'Binding retention is full.', { limit: 'maxBindings' }); binding = { id: key, projectId: p.id, principal: principal.id, externalSessionId: b.externalSessionId, adapter: 'claude-code-mcp', status: 'connected', at: now() }; bindings.push(binding); }
      binding.status = method === 'binding.close' ? 'disconnected' : 'connected'; binding.at = now();
      await atomicJson(file, bindings); await this.emit(p, 'binding.changed', key); return binding;
    }
    if (method === 'context.create') {
      requireThat(b.document || b.resource, 'invalid', 'Choose an explicit document or scientific resource.');
      const context: any = { projectId: p.id, principal: principal.id, at: now(), delivery: 'not-fetched' };
      if (b.document) {
        const snapshot = await this.docs(p).snapshot(b.document.documentId, b.document.version);
        const from = b.document.from ?? 0, to = b.document.to ?? snapshot.code.length;
        requireThat(from <= to && to <= snapshot.code.length, 'invalid', 'Context text range is outside the buffer.');
        context.document = { source: snapshot.source, sha256: snapshot.sha256, from, to, text: snapshot.code.slice(from, to) };
      }
      if (b.resource) {
        const metadata = await resources.resolve(b.resource);
        if (metadata.kind === 'table') {
          const data = await resources.rows(b.resource);
          requireThat(data.entityKey === 'gene_id', 'condition', 'Entity context requires unique stable gene identities.');
          const selected = b.entities ?? [];
          requireThat(selected.length > 0 && selected.every((id: string) => data.rows.some(r => r.gene_id === id)), 'stale', 'Choose stable entities present in this resource version.');
          context.resource = { reference: b.resource, metadata: publicResource(data.resource), rows: data.rows.filter(r => selected.includes(r.gene_id)) };
        } else {
          requireThat(!b.entities?.length, 'invalid', 'Entity selection requires a table resource.');
          const page = await resources.read(b.resource, 0);
          const bytes = Buffer.from(page.data, 'base64');
          let content;
          try { content = { encoding: 'utf8', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
          catch { content = { encoding: 'base64', data: page.data }; }
          context.resource = { reference: b.resource, metadata: page.resource, ...content, offset: page.offset, nextOffset: page.nextOffset, more: page.more };
        }
      }
      const contextId = digest(canonical(context));
      requireThat(Buffer.byteLength(JSON.stringify(context)) <= (this.config.maxContextBytes ?? serviceLimits.maxContextBytes), 'limit', 'Context package exceeds its byte budget.', { limit: 'maxContextBytes' });
      const contextDirectory = await stateDirectory(p.root, '.rho/rho/contexts');
      requireThat((await fs.readdir(contextDirectory)).length < (this.config.maxContexts ?? serviceLimits.maxContexts), 'limit', 'Context retention is full.', { limit: 'maxContexts' });
      await atomicJson(path.join(contextDirectory, contextId + '.json'), context);
      return { contextId, ...context };
    }
    if (method === 'context.read') {
      const file = path.join(await stateDirectory(p.root, '.rho/rho/contexts'), b.contextId + '.json');
      const context = await readJson<any>(file);
      context.delivery = 'tool-fetched'; context.fetchedBy = principal.id; context.fetchedAt = now();
      await atomicJson(file, context); return { contextId: b.contextId, ...context };
    }
    if (method === 'observation.snapshot') return { project: p, catalog, documents: await this.docs(p).list(), operations: (await requests.list(principal)).map(publicOperation), resources: (await resources.list()).map(publicResource), compositions: await workspace.compositions(), selection: await readJson(path.join(await this.dataDir(p), 'selection.json'), null), bindings: (await readJson<any[]>(path.join(await this.dataDir(p), 'bindings.json'), [])).filter(x => x.principal === principal.id), cursor: (await this.events(p)).cursor, host: await this.bridge.capability(p.root), limits: { ...serviceLimits, ...requestLimits, documents: this.docs(p).limits, resources: resources.limits, ...Object.fromEntries(Object.entries(this.config).filter(([, v]) => typeof v === 'number')) } };
    throw new Fault('unavailable', 'This catalog operation has not been installed.', { operation: method });
  }
  private async events(p: Project) { return readJson<any>(path.join(await this.dataDir(p), 'events.json'), { cursor: 0, events: [] }); }
  async emit(p: Project, type: string, subject: string) {
    const retained = await this.events(p); const event = { cursor: ++retained.cursor, type, subject, projectId: p.id, at: now() };
    retained.events.push(event); retained.events = retained.events.slice(-(this.config.eventRetention ?? 256));
    await atomicJson(path.join(await this.dataDir(p), 'events.json'), retained);
    for (const s of this.subscribers) if (s.projectId === p.id) {
      if (s.response.writableLength > (this.config.maxEventBytes ?? 65536)) { s.response.end('event: gap\ndata: {"kind":"event_gap","continuation":"Read observation.snapshot"}\n\n'); this.subscribers.delete(s); }
      else s.response.write('id: ' + event.cursor + '\nevent: ' + type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    }
  }
  private async subscribe(url: URL, principal: Principal, response: http.ServerResponse) {
    const project = await this.state.project(url.searchParams.get('projectId') ?? '', principal);
    return this.serial(project.id, () => this.openSubscription(project, url, principal, response));
  }
  private async openSubscription(project: Project, url: URL, principal: Principal, response: http.ServerResponse) {
    const after = Number(url.searchParams.get('after') ?? 0);
    requireThat(Number.isSafeInteger(after) && after >= 0, 'invalid', 'Invalid event cursor.');
    requireThat([...this.subscribers].filter(s => s.principal === principal.id).length < (this.config.maxSubscriptions ?? 8), 'limit', 'Subscription limit reached.', { limit: 'maxSubscriptions' });
    const retained = await this.events(project);
    requireThat(after <= retained.cursor && after >= (retained.events[0]?.cursor ?? 1) - 1, 'event_gap', 'Events are outside the retained window; read the owner snapshot.', { currentCursor: retained.cursor });
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    for (const e of retained.events.filter((e: any) => e.cursor > after)) response.write('id: ' + e.cursor + '\nevent: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
    response.write(': observation only\n\n');
    const subscription = { projectId: project.id, principal: principal.id, response };
    this.subscribers.add(subscription); response.on('close', () => this.subscribers.delete(subscription));
  }
  async close() {
    for (const s of this.subscribers) s.response.end();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    const shutdown = await this.bridge.close(); await this.state.close(); return shutdown;
  }
}
