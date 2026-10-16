import { objectSchema as obj, text, refSchema as ref, version, scriptSchema } from '@rho-workspace/headless';
const id = { type: 'string', pattern: '^[A-Za-z0-9._:@-]{1,128}$' };
const integer = { type: 'integer', minimum: 0 };
const positive = { type: 'integer', minimum: 1 };
const project = { projectId: id };
const op = { ...project, operationId: id };
const doc = { ...project, documentId: version };
const edit = obj({ from: integer, to: integer, insert: { type: 'string' } });
const nullableDigest = { anyOf: [version, { type: 'null' }] };
const binding = { oneOf: [ref, obj({ documentId: version, version: positive })] };
const view = obj({ id, component: text, version: text, props: { type: 'object' }, bindings: { type: 'object', additionalProperties: binding }, selection: { type: 'array', items: text, maxItems: 1000 } }, ['id', 'component', 'version', 'props', 'bindings']);
export const operations: Record<string, any> = {
  'protocol.describe': obj(project, []),
  'project.open': obj({ path: text }),
  'project.create': obj({ name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' } }),
  'project.list': obj({}),
  'session.grant': obj({ ...project, externalSessionId: id, methods: { type: 'array', items: text, maxItems: 64 } }, ['projectId', 'externalSessionId', 'methods']),
  'capability.list': obj(project),
  'requirements.check': obj({ ...project, action: { enum: ['airway.analyze', 'airway.shrink'] } }),
  'requirements.prepare': obj({ ...op, action: { enum: ['airway.analyze', 'airway.shrink'] } }),
  'action.submit': obj({ ...op, action: { enum: ['airway.analyze', 'airway.shrink'] }, actionVersion: { const: '0.1.0' }, input: { type: 'object' } }),
  'action.lookup': obj(op),
  'action.observe': obj(op),
  'action.retry': obj(op),
  'action.cancel': obj(op),
  'action.output': obj({ ...op, stream: { enum: ['stdout', 'stderr'] }, offset: integer, maxBytes: positive }, ['projectId', 'operationId', 'stream', 'offset']),
  'action.list': obj(project),
  'document.open': obj({ ...project, path: text }),
  'document.read': obj(doc),
  'document.edit': obj({ ...doc, expectedVersion: positive, edits: { type: 'array', items: edit, minItems: 1, maxItems: 1000 }, undoGroup: id }),
  'document.undo': obj({ ...doc, expectedVersion: positive }),
  'document.save': obj({ ...doc, expectedVersion: positive, expectedDiskDigest: nullableDigest }),
  'resource.list': obj(op),
  'artifact.check': obj(op),
  'resource.read': obj({ ...project, resource: ref, offset: integer, maxBytes: positive }, ['projectId', 'resource', 'offset']),
  'data.page': obj({ ...project, resource: ref, offset: integer, limit: positive, sort: obj({ column: text, direction: { enum: ['asc', 'desc'] } }), filter: obj({ column: text, op: { enum: ['eq', 'lt', 'gt', 'isNull'] }, value: { type: ['string', 'number', 'boolean', 'null'] } }, ['column', 'op']) }, ['projectId', 'resource', 'offset', 'limit']),
  'data.plot': obj({ ...project, resource: ref, maxPoints: positive }, ['projectId', 'resource']),
  'data.compare': obj({ ...project, baseline: ref, shrinkage: ref }),
  'selection.set': obj({ ...project, resource: ref, entities: { type: 'array', items: text, maxItems: 1000 } }),
  'context.create': obj({ ...project, document: obj({ documentId: version, version: positive, from: integer, to: integer }, ['documentId', 'version']), resource: ref, entities: { type: 'array', items: text, maxItems: 1000 } }, ['projectId']),
  'context.read': obj({ ...project, contextId: version }),
  'binding.open': obj({ ...project, externalSessionId: id, adapter: { const: 'claude-code-mcp' } }),
  'binding.close': obj({ ...project, externalSessionId: id }),
  'binding.list': obj(project),
  'binding.activity': obj(project),
  'composition.put': obj({ ...project, compositionId: id, expectedVersion: integer, views: { type: 'array', items: view, maxItems: 32 }, layout: { type: 'object' } }),
  'composition.read': obj({ ...project, compositionId: id }),
  'view.close': obj({ ...project, compositionId: id, viewId: id, expectedVersion: positive }),
  'workspace.save': obj(project),
  'workspace.export': obj({ ...project, destination: text }),
  'workspace.restore': obj({ ...project, source: text }),
  'observation.snapshot': obj(project)
};
export const descriptions: Record<string, string> = {
  'capability.list': 'Read registered actions and components. Does not start R or a Core Host.',
  'document.read': 'Read the shared acknowledged buffer, including unsaved text and its version.',
  'document.edit': 'Apply conditional UTF-16 text edits to the shared buffer; keep the returned version.',
  'action.submit': 'Submit explicitly authorized scientific work. Persist operationId before first delivery. Reuse it only for identical content.',
  'action.lookup': 'Read the original accepted operation. Missing acknowledgement is not permission for a new identity.',
  'action.observe': 'Observe original Core facts. Never starts or recovers a Host.',
  'context.read': 'Read an explicit versioned context package. Receipt establishes a tool fetch, not proactive delivery to a conversation.',
  'binding.open': 'Bind this external session to the authenticated project scope. Conversation stays in Claude Code.'
};
export const errorKinds = ['invalid', 'unauthorized', 'origin', 'scope', 'stale', 'conflict', 'condition', 'unavailable', 'limit', 'not_found', 'event_gap', 'storage', 'native'];
export const errorSchema = obj({ kind: { enum: errorKinds }, message: text, details: { type: 'object' }, continuation: text });
export const resourceSchema = obj({ id: text, version, projectId: id, owner: text, kind: { enum: ['file', 'table', 'plot', 'model'] }, path: text, bytes: integer, provenance: { type: 'object' }, coverage: { type: 'object' }, availability: { enum: ['available', 'partial', 'missing', 'unknown'] } });
operations['session.grant'].properties.methods.items = { enum: Object.keys(operations).filter(m => !m.startsWith('session.') && !m.startsWith('project.')) };
export const runSchema = obj({ operationId: id, principal: text, projectId: id, requestDigest: version, request: { type: 'object' }, action: text, actionVersion: text, acceptedAt: text, core: obj({ caller: id, requestId: id }), delivery: { enum: ['not-sent', 'sending', 'answered', 'not-delivered', 'unknown'] }, execution: { enum: ['unobserved', 'active', 'completed', 'failed', 'unknown'] }, native: {}, integrity: { type: 'object' }, domain: { type: 'object' }, interpretation: { type: 'object' }, plan: obj({ args: { type: 'array', items: { type: 'string' } }, source: { type: 'object' }, output: { type: ['string', 'null'] }, codeDigest: version }), lastCli: { type: 'object' }, checks: { type: 'object' }, cancellation: { type: 'object' } }, ['operationId', 'principal', 'projectId', 'requestDigest', 'action', 'actionVersion', 'acceptedAt', 'core', 'delivery', 'execution', 'native', 'integrity', 'domain', 'interpretation', 'request', 'plan']);
const definitions = { error: errorSchema, resource: resourceSchema, run: runSchema, script: scriptSchema,
    document: obj({ id: version, path: text, version: positive, content: { type: 'string' }, diskDigest: nullableDigest, dirty: { type: 'boolean' }, author: text, acknowledgedAt: text, undo: { type: 'array', items: obj({ content: { type: 'string' }, group: text, author: text }) } }),
    event: obj({ cursor: positive, type: text, at: text, projectId: id, subject: text }),
    selection: obj({ resource: ref, entities: { type: 'array', items: text }, at: text }),
    composition: obj({ compositionId: id, version: positive, views: { type: 'array', items: view, maxItems: 32 }, layout: { type: 'object' }, availability: { type: 'object' }, acknowledgedAt: text })
  };
// Response objects admit additive fields; required facts keep their v1 meaning.
const record = { type: 'object' };
const array = (items: any) => ({ type: 'array', items });
const response = (properties: Record<string, any>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
const cli = response({ exitCode: { type: 'integer', minimum: 0, maximum: 4 }, reply: record });
const projectResult = response({ id, root: text, openedAt: text });
const requirements = response({ action: text, actionVersion: text, checkedAt: text, environment: response({ rscript: text, libraryPaths: array(text) }), native: record, status: { enum: ['present', 'missing', 'unknown'] }, checkId: version });
const artifactFacts = response({ integrity: record, domain: record, resources: array(resourceSchema) }, ['integrity', 'domain']);
const context = response({ contextId: version, projectId: id, principal: text, at: text, delivery: { enum: ['not-fetched', 'tool-fetched'] } });
const bindingResult = response({ id: version, projectId: id, principal: text, externalSessionId: id, adapter: { const: 'claude-code-mcp' }, status: { enum: ['connected', 'disconnected'] }, at: text });
const activity = response({ cursor: integer, retainedFrom: positive, entries: array(response({ cursor: positive, principal: text, method: text, at: text, outcome: { enum: ['returned', 'rejected'] } })) });
const workspace = response({ schemaVersion: { const: 1 }, sourceProjectId: id, acknowledgedAt: text, documents: array(definitions.document), resources: array(record), compositions: array(definitions.composition), selection: { anyOf: [definitions.selection, { type: 'null' }] } });
export const responses: Record<string, any> = {
  'protocol.describe': response({ apiVersion: { const: '1.0' }, schemaVersion: { const: 1 }, operations: record, definitions: record, responses: record }),
  'project.open': response({ ...projectResult.properties, host: cli }),
  'project.create': projectResult, 'project.list': array(projectResult),
  'session.grant': response({ connectionFile: text, projectId: id, methods: array(text), transport: { const: 'stdio-mcp' }, externalSessionId: id }),
  'capability.list': response({ version: text, actions: array(record), components: array(record), agents: array(record), host: cli }, ['actions', 'components', 'host']),
  'requirements.check': requirements,
  'requirements.prepare': runSchema,
  ...Object.fromEntries(['submit', 'lookup', 'observe', 'retry', 'cancel'].map(m => ['action.' + m, runSchema])),
  'action.output': cli, 'action.list': array(runSchema),
  ...Object.fromEntries(['open', 'read', 'edit', 'undo', 'save'].map(m => ['document.' + m, definitions.document])),
  'resource.list': artifactFacts, 'artifact.check': artifactFacts,
  'resource.read': response({ resource: resourceSchema, encoding: { const: 'base64' }, data: { type: 'string' }, offset: integer, nextOffset: integer, more: { type: 'boolean' } }),
  'data.page': response({ resource: resourceSchema, columns: array(response({ name: text, type: { enum: ['number', 'string', 'boolean'] } })), total: integer, filtered: integer, offset: integer, nextOffset: integer, more: { type: 'boolean' }, rows: array(record), entityKey: { type: ['string', 'null'] } }),
  'data.plot': response({ resource: resourceSchema, spec: record, points: array(record), originalPoints: integer, downsampled: { type: 'boolean' }, method: text }),
  'data.compare': resourceSchema, 'selection.set': definitions.selection,
  'context.create': context, 'context.read': context,
  'binding.open': bindingResult, 'binding.close': bindingResult, 'binding.list': array(bindingResult), 'binding.activity': activity,
  'composition.put': definitions.composition, 'composition.read': definitions.composition, 'view.close': definitions.composition,
  'workspace.save': workspace,
  'workspace.export': response({ destination: text, state: { const: 'complete' }, files: positive, writeCondition: { const: 'new-directory' }, manifestDigest: version }),
  'workspace.restore': response({ sourceProjectId: id, documents: array(record), resources: array(record), compositions: array(record), execution: { const: 'not-replayed' }, selection: record }, ['sourceProjectId', 'documents', 'resources', 'compositions', 'execution']),
  'observation.snapshot': response({ project: projectResult, catalog: record, documents: array(definitions.document), operations: array(runSchema), resources: array(resourceSchema), compositions: array(definitions.composition), selection: { anyOf: [definitions.selection, { type: 'null' }] }, bindings: array(bindingResult), cursor: integer, host: cli, limits: record })
};
export const errorEnvelope = obj({ apiVersion: { const: '1.0' }, ok: { const: false }, error: errorSchema });
export const responseEnvelope = (method: string) => obj({ apiVersion: { const: '1.0' }, ok: { const: true }, value: responses[method] });
export const protocol = { apiVersion: '1.0', schemaVersion: 1, transport: 'HTTP JSON POST /api/v1/{operation}; GET /api/v1/events', operations, responses, descriptions, errorKinds, errorEnvelope,
  definitions, eventTypes: ['operation.accepted', 'operation.delivery', 'operation.cancel-requested', 'document.changed', 'selection.changed', 'composition.changed', 'binding.changed'],
  compatibility: 'Major API path changes for incompatible fields/semantics; additive optional fields allowed. Per-resource versions are independent.' };
