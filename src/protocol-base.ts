// Baseline definitions for the single versioned contract in protocol.ts.
// This module declares no contract identity of its own: it is the substrate the
// current protocol extends, and the required facts recorded here keep the meaning
// they were first accepted with.
//
// Operations declared by a functional component are not repeated here. Their one
// authoritative definition is the owning package's pure contract entry, which
// protocol.ts snapshots and scopes with the application's project identity.
import { objectSchema as obj, text, refSchema as ref, version } from '@rho-workspace/plugin-contracts';
const id = { type: 'string', pattern: '^[A-Za-z0-9._:@-]{1,128}$' };
const integer = { type: 'integer', minimum: 0 };
const positive = { type: 'integer', minimum: 1 };
const project = { projectId: id };
const op = { ...project, operationId: id };
const binding = { oneOf: [ref, obj({ documentId: version, version: positive })] };
const view = obj({ id, component: text, version: text, props: { type: 'object' }, bindings: { type: 'object', additionalProperties: binding }, selection: { type: 'array', items: text, maxItems: 1000 } }, ['id', 'component', 'version', 'props', 'bindings']);
export const operations: Record<string, any> = {
  'protocol.describe': obj(project, []),
  'project.open': obj({ path: text }),
  'project.create': obj({ name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' } }),
  'project.list': obj({}),
  'session.grant': obj({ ...project, externalSessionId: id, methods: { type: 'array', items: text, maxItems: 64 } }, ['projectId', 'externalSessionId', 'methods']),
  'capability.list': obj(project),
  'action.lookup': obj(op),
  'action.observe': obj(op),
  'action.retry': obj(op),
  'action.cancel': obj(op),
  'action.output': obj({ ...op, stream: { enum: ['stdout', 'stderr'] }, offset: integer, maxBytes: positive }, ['projectId', 'operationId', 'stream', 'offset']),
  'action.list': obj(project),
  'selection.set': obj({ ...project, resource: ref, entities: { type: 'array', items: text, maxItems: 1000 } }),
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
  'action.lookup': 'Read the original accepted operation. Missing acknowledgement is not permission for a new identity.',
  'action.observe': 'Observe original Core facts. Never starts or recovers a Host.',
  'binding.open': 'Bind this external session to the authenticated project scope. Conversation stays in Claude Code.'
};
export const errorKinds = ['invalid', 'unauthorized', 'origin', 'scope', 'stale', 'conflict', 'condition', 'unavailable', 'limit', 'not_found', 'event_gap', 'storage', 'native'];
export const errorSchema = obj({ kind: { enum: errorKinds }, message: text, details: { type: 'object' }, continuation: text });
export const resourceSchema = obj({ id: text, version, projectId: id, owner: text, kind: { enum: ['file', 'table', 'plot', 'model'] }, path: text, bytes: integer, provenance: { type: 'object' }, coverage: { type: 'object' }, availability: { enum: ['available', 'partial', 'missing', 'unknown'] } });
// The grantable-method enum is derived from the assembled contract in protocol.ts:
// this module no longer sees every operation it is extended with, so computing the
// enum here would publish a list that silently omits them.
export const runSchema = obj({ operationId: id, principal: text, projectId: id, requestDigest: version, request: { type: 'object' }, action: text, actionVersion: text, acceptedAt: text, core: obj({ caller: id, requestId: id }), delivery: { enum: ['not-sent', 'sending', 'answered', 'not-delivered', 'unknown'] }, execution: { enum: ['unobserved', 'active', 'completed', 'failed', 'unknown'] }, native: {}, integrity: { type: 'object' }, domain: { type: 'object' }, interpretation: { type: 'object' }, plan: obj({ args: { type: 'array', items: { type: 'string' } }, source: { type: 'object' }, output: { type: ['string', 'null'] }, codeDigest: version }), lastCli: { type: 'object' }, checks: { type: 'object' }, cancellation: { type: 'object' } }, ['operationId', 'principal', 'projectId', 'requestDigest', 'action', 'actionVersion', 'acceptedAt', 'core', 'delivery', 'execution', 'native', 'integrity', 'domain', 'interpretation', 'request', 'plan']);
const definitions = { error: errorSchema, resource: resourceSchema, run: runSchema,
    event: obj({ cursor: positive, type: text, at: text, projectId: id, subject: text }),
    selection: obj({ resource: ref, entities: { type: 'array', items: text }, at: text }),
    composition: obj({ compositionId: id, version: positive, views: { type: 'array', items: view, maxItems: 32 }, layout: { type: 'object' }, availability: { type: 'object' }, acknowledgedAt: text })
  };
// Response objects admit additive fields; required facts keep their original meaning.
const record = { type: 'object' };
const array = (items: any) => ({ type: 'array', items });
const response = (properties: Record<string, any>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
const cli = response({ exitCode: { type: 'integer', minimum: 0, maximum: 4 }, reply: record });
const projectResult = response({ id, root: text, openedAt: text });
const bindingResult = response({ id: version, projectId: id, principal: text, externalSessionId: id, adapter: { const: 'claude-code-mcp' }, status: { enum: ['connected', 'disconnected'] }, at: text });
export const responses: Record<string, any> = {
  'project.open': response({ ...projectResult.properties, host: cli }),
  'project.create': projectResult, 'project.list': array(projectResult),
  'session.grant': response({ connectionFile: text, projectId: id, methods: array(text), transport: { const: 'stdio-mcp' }, externalSessionId: id }),
  'capability.list': response({ version: text, actions: array(record), components: array(record), agents: array(record), host: cli }, ['actions', 'components', 'host']),
  'action.output': cli, 'action.list': array(runSchema),
  'selection.set': definitions.selection,
  'binding.open': bindingResult, 'binding.close': bindingResult, 'binding.list': array(bindingResult),
  'composition.put': definitions.composition, 'composition.read': definitions.composition, 'view.close': definitions.composition,
  'workspace.save': response({ schemaVersion: { const: 1 }, sourceProjectId: id, acknowledgedAt: text, documents: array(record), resources: array(record), compositions: array(definitions.composition), selection: { anyOf: [definitions.selection, { type: 'null' }] } }),
  'workspace.export': response({ destination: text, state: { const: 'complete' }, files: positive, writeCondition: { const: 'new-directory' }, manifestDigest: version }),
  'workspace.restore': response({ sourceProjectId: id, documents: array(record), resources: array(record), compositions: array(record), execution: { const: 'not-replayed' }, selection: record }, ['sourceProjectId', 'documents', 'resources', 'compositions', 'execution']),
  'observation.snapshot': response({ project: projectResult, catalog: record, documents: array(record), operations: array(runSchema), resources: array(resourceSchema), compositions: array(definitions.composition), selection: { anyOf: [definitions.selection, { type: 'null' }] }, bindings: array(bindingResult), cursor: integer, host: cli, limits: record })
};
// Definitions only. The API version, transport and envelopes belong to the one
// contract exported by protocol.ts, so nothing here names a second contract.
export const baseProtocol = { operations, responses, descriptions, errorKinds, definitions,
  eventTypes: ['operation.accepted', 'operation.delivery', 'operation.cancel-requested', 'document.changed', 'selection.changed', 'composition.changed', 'binding.changed'],
  compatibility: 'Major API path changes for incompatible fields/semantics; additive optional fields allowed. Per-resource versions are independent.' };
