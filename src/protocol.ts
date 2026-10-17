import { requirementsSchema, executionInputSchema, declarationSchema } from './entry-contracts.js';
import { objectSchema as obj, text, refSchema as ref } from '@rho-workspace/plugin-contracts';
import { inputs as annotationInputs, outputs as annotationOutputs } from './annotation-contracts.js';
import { protocol as v1 } from './legacy-protocol.js';
const base = structuredClone(v1);
const project = { projectId: base.operations['capability.list'].properties.projectId };
const op = { ...project, operationId: base.operations['action.lookup'].properties.operationId };
const positive = { type: 'integer', minimum: 1 };
const integer = { type: 'integer', minimum: 0 };
const record = { type: 'object' };
const array = (items: any) => ({ type: 'array', items });
const response = (properties: Record<string, any>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
export const operations: Record<string, any> = { ...base.operations,
  'project.create': obj({ name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^/\\\\]+$', not: { enum: ['.', '..', '.rho', '.git'] } } }),
  'session.browser.pair': obj({ path: text }, []),
  'session.browser.revoke': obj({ sessionId: text }),
  'capability.configure': obj({ ...project, expectedVersion: integer, changeId: text, enabled: { type: 'array', items: text, maxItems: 32, uniqueItems: true } }),
  'skill.list': obj(project),
  'skill.read': obj({ ...project, skillId: text, expectedDigest: { anyOf: [ref.properties.version, { type: 'null' }] } }, ['projectId', 'skillId']),
  'requirements.check': obj({ ...project, requirements: requirementsSchema }),
  'requirements.prepare': obj({ ...op, requirements: requirementsSchema }),
  'action.submit': obj({ ...op, action: { const: 'r.execute' }, actionVersion: { const: '0.2.0' }, input: executionInputSchema }),
  'resource.register': obj({ ...project, declaration: declarationSchema, expectedDigest: ref.properties.version }),
  'data.plot': obj({ ...project, resource: ref, x: text, y: text, maxPoints: positive }, ['projectId', 'resource', 'x', 'y']),
  'data.compare': obj({ ...project, left: ref, right: ref, options: obj({ leftKey: text, rightKey: text, leftNamespace: text, rightNamespace: text, mapping: { const: 'equal-string' }, leftField: text, rightField: text, join: { enum: ['left', 'inner', 'full'] } }) }),
  'object.read': obj({ ...project, resource: ref }),
  'media.describe': obj({ ...project, resource: ref })
};
const changeId = { type: 'string', pattern: '^[A-Za-z0-9._:@-]{1,128}$' };
const condition = { ...project, compositionId: changeId, expectedVersion: integer, changeId };
const view = { ...base.operations['composition.put'].properties.views.items, additionalProperties: false };
const node = { oneOf: [obj({ id: changeId, kind: { const: 'group' }, children: { ...array(changeId), maxItems: 256, uniqueItems: true } }), obj({ ...view.properties, kind: { const: 'view' }, protected: { type: 'boolean' } }, [...view.required, 'kind'])] };
const applyOperation = { oneOf: [
  obj({ op: { const: 'replace' }, rootId: changeId, nodes: { ...array(node), minItems: 1, maxItems: 256 } }),
  obj({ op: { const: 'insert' }, parentId: changeId, index: integer, node }),
  obj({ op: { const: 'move' }, id: changeId, parentId: changeId, index: integer }),
  obj({ op: { const: 'remove' }, id: changeId }),
  obj({ op: { const: 'props' }, id: changeId, props: record }),
  obj({ op: { const: 'bind' }, id: changeId, bindings: view.properties.bindings })
] };
operations['composition.apply'] = obj({ ...condition, operations: { ...array(applyOperation), minItems: 1, maxItems: 256 } });
operations['composition.undo'] = obj(condition);
operations['view.protection.set'] = obj({ ...condition, viewId: changeId, protected: { type: 'boolean' } });
operations['view.close'] = obj({ ...operations['view.close'].properties, changeId }, operations['view.close'].required);
const selectionScope = { oneOf: [obj({ kind: { const: 'caller' } }), obj({ kind: { enum: ['view', 'shared'] }, id: changeId })] };
const documentRange = obj({ documentId: text, version: positive, from: integer, to: integer });
operations['interaction.selection.read'] = obj({ ...project, scope: selectionScope });
operations['interaction.selection.set'] = obj({ ...project, scope: selectionScope, expectedVersion: integer, changeId, selection: { oneOf: [obj({ document: documentRange }), obj({ resource: ref, entities: { ...array(text), minItems: 1, maxItems: 1024, uniqueItems: true } }), { type: 'null' }] } });
for (const [method, schema] of Object.entries(annotationInputs)) operations[method] = obj({ ...project, ...schema.properties });
operations['context.create'] = obj({ ...operations['context.create'].properties, annotations: { ...array(obj({ annotationId: changeId, version: positive })), minItems: 1, maxItems: 128 }, changeId, expectedVersion: { const: 0 } }, ['projectId']);
for (const method of ['workspace.save', 'workspace.export']) operations[method] = obj({ ...operations[method].properties, format: { enum: [1, 2, 3] } }, operations[method].required);
operations['context.create'].properties.region = obj({ page: positive, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 }, units: { enum: ['pixels', 'points'] } });
operations['session.grant'].properties.methods.items = { enum: Object.keys(operations).filter(m => !m.startsWith('session.') && !m.startsWith('project.')) };
export const resourceSchema = { ...base.definitions.resource, additionalProperties: true, properties: { ...base.definitions.resource.properties, kind: { enum: ['file', 'table', 'media', 'object', 'plot', 'model'] }, format: { anyOf: [record, { type: 'string' }] } } };
const retainedPlan: any = base.definitions.run.properties.plan;
export const runSchema = { ...base.definitions.run, properties: { ...base.definitions.run.properties, plan: { ...retainedPlan, properties: { ...retainedPlan.properties, completion: { type: ['string', 'null'] } } } } };
const selection = { ...base.definitions.selection, properties: { ...base.definitions.selection.properties, namespace: text } };
const definitions = { ...base.definitions, run: runSchema, resource: resourceSchema, selection, declaration: declarationSchema, executionInput: executionInputSchema, requirements: requirementsSchema };
const artifactFacts = response({ integrity: record, domain: record, resources: array(resourceSchema) }, ['integrity', 'domain']);
export const responses: Record<string, any> = { ...base.responses,
  'session.browser.pair': response({ code: text, expiresAt: text }),
  'session.browser.revoke': response({ sessionId: text, revoked: { type: 'boolean' } }),
  'protocol.describe': response({ apiVersion: { const: '2.0' }, schemaVersion: { const: 2 }, operations: record, definitions: record, responses: record }),
  'capability.configure': response({ version: positive, enabled: array(text), receipt: response({ changeId: text, author: text, version: positive, enabled: array(text), at: text }) }),
  'skill.list': array(response({ id: text, version: text, digest: ref.properties.version, content: text })),
  'skill.read': response({ id: text, version: text, digest: ref.properties.version, content: text }),
  'requirements.check': response({ requirements: requirementsSchema, checkedAt: text, environment: record, native: record, status: { enum: ['present', 'missing', 'unknown'] }, checkId: ref.properties.version }),
  'resource.register': resourceSchema, 'resource.list': artifactFacts, 'artifact.check': artifactFacts,
  'resource.read': response({ resource: resourceSchema, encoding: { const: 'base64' }, data: { type: 'string' }, offset: integer, nextOffset: integer, more: { type: 'boolean' } }),
  'data.page': { ...base.responses['data.page'], properties: { ...base.responses['data.page'].properties, resource: resourceSchema, namespace: { type: ['string', 'null'] } } },
  'data.plot': { ...base.responses['data.plot'], properties: { ...base.responses['data.plot'].properties, resource: resourceSchema } },
  'data.compare': resourceSchema,
  'selection.set': selection,
  'object.read': response({ resource: resourceSchema, observation: { const: 'exported-snapshot' }, value: {} }),
  'media.describe': response({ resource: resourceSchema, original: ref, mimeType: text, rendering: { const: 'unavailable' } }),
  'workspace.save': { ...base.responses['workspace.save'], properties: { ...base.responses['workspace.save'].properties, schemaVersion: { enum: [1, 2, 3] }, selection: { anyOf: [selection, { type: 'null' }] } } },
  'observation.snapshot': { ...base.responses['observation.snapshot'], properties: { ...base.responses['observation.snapshot'].properties, resources: array(resourceSchema), operations: array(runSchema), selection: { anyOf: [selection, { type: 'null' }] } } }
};
const structuredComposition = response({ format: { const: 'rho.composition/1' }, compositionId: text, version: positive, nodes: array(node), rootId: changeId, receipt: record, author: text, views: array(view), availability: record, acknowledgedAt: text });
for (const method of ['composition.apply', 'composition.undo', 'view.protection.set']) responses[method] = structuredComposition;
const composition = { anyOf: [base.definitions.composition, structuredComposition] };
responses['composition.read'] = composition;
responses['view.close'] = composition;
responses['interaction.selection.read'] = record;
responses['interaction.selection.set'] = record;
Object.assign(responses, annotationOutputs);
responses['context.create'] = record;
responses['context.read'] = record;
responses['observation.snapshot'].properties.compositions = array(composition);
responses['workspace.save'].properties.compositions = array(composition);
for (const method of ['requirements.prepare', 'action.submit', 'action.lookup', 'action.observe', 'action.retry', 'action.cancel']) responses[method] = runSchema;
responses['action.list'] = array(runSchema);
export const descriptions = { ...base.descriptions,
  'capability.configure': 'Persist the selected project plugins with a conditional version and idempotent changeId. This changes routing only; it installs no package, starts no runtime and cancels no work.',
  'skill.list': 'List the application and enabled provider Skills shipped in the selected package. Skills guide discovery but do not grant authorization.',
  'skill.read': 'Read one versioned shipped Skill after checking its digest. A stale digest requires rereading instead of applying cached instructions.',
  'action.submit': 'Execute the explicitly selected project R script snapshot and requirements. Persist operationId before delivery; identical retries retain the original Core identity. Output directory is the first R argument, followed by explicit args or frozen resource paths. Artifact paths are output-relative; completion is run-directory-relative, returned as plan.completion, so an inventory can remain beside immutable producer artifacts.',
  'resource.register': 'Declare scoped existing bytes and their type/schema at the supplied digest. This read and registration starts no runtime.',
  'requirements.check': 'Probe only the explicitly declared R packages with bounded base R; no Core Host or project script starts.',
  'data.compare': 'Join two explicit table versions using declared keys, namespaces, fields and join policy. Scientific comparability remains the project responsibility.',
  'object.read': 'Read a bounded exported JSON object snapshot, not live R memory.',
  'artifact.check': 'Verify the selected completion inventory and file bytes only; domain check reports remain project resources.'
};
export const errorKinds = base.errorKinds;
export const errorSchema = base.definitions.error;
export const errorEnvelope = obj({ apiVersion: { const: '2.0' }, ok: { const: false }, error: errorSchema });
export const responseEnvelope = (method: string) => obj({ apiVersion: { const: '2.0' }, ok: { const: true }, value: responses[method] });
export const protocol = { ...base, apiVersion: '2.0', schemaVersion: 2, transport: 'HTTP JSON POST /api/v2/{operation}; GET /api/v2/events', eventTypes: [...new Set([...base.eventTypes, 'capability.changed', 'view.closed', 'interaction.selection.changed', 'annotation.changed', 'context.changed', 'workspace.restored'])], operations, responses, descriptions, definitions, errorEnvelope, legacy: 'v1 schemas and captured fixtures are frozen. Legacy reads and explicit retry/cancel of accepted requests remain available; new recipe submissions require an explicit v2 project script.' };
