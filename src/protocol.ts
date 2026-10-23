import { enhancementSchemas } from './enhancement-contracts.js';
import { discoverySchemas } from './discovery-contracts.js';
import { feedbackSchemas } from './feedback-contracts.js';
import { presentationSchemas } from './presentation-contracts.js';
import { requirementsSchema, executionInputSchema, declarationSchema } from './entry-contracts.js';
import { objectSchema as obj, text, refSchema as ref } from '@rho-workspace/plugin-contracts';
import { inputs as annotationInputs, outputs as annotationOutputs } from './annotation-contracts.js';
import { nativeSchemas } from './native-contracts.js';
import { protocol as v1 } from './legacy-protocol.js';
import { operationContracts as documentContracts, documentSchema, documentSummarySchema } from './document-contract.js';
const base = structuredClone(v1);
const project = { projectId: base.operations['capability.list'].properties.projectId };
const op = { ...project, operationId: base.operations['action.lookup'].properties.operationId };
const positive = { type: 'integer', minimum: 1 };
const integer = { type: 'integer', minimum: 0 };
const record = { type: 'object' };
const array = (items: any) => ({ type: 'array', items });
const response = (properties: Record<string, any>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
export const operations: Record<string, any> = { ...base.operations,
  'protocol.describe': obj({ ...project, method: text, cursor: { type: ['string', 'null'], maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, maxBytes: { type: 'integer', minimum: 1024, maximum: 65536 } }, []),
  'project.pick': obj({}),
  'project.source.pick': obj({}),
  'project.source.add': obj(project),
  'project.createWorkspace': obj({ name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' }, selectionIds: { type: 'array', items: text, minItems: 1, maxItems: 32, uniqueItems: true }, changeId: text }),
  'project.create': obj({ name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^/\\\\]+$', not: { enum: ['.', '..', '.rho', '.git'] } } }),
  // The person's own view of their selected folders: bounded one-level entries and
  // opening one text file as a document in front of them.
  'project.entries': obj({ ...project, path: { type: 'string', minLength: 1, maxLength: 1024 } }, ['projectId']),
  'project.openFile': obj({ ...project, path: { type: 'string', minLength: 1, maxLength: 1024 }, compositionId: text, expectedVersion: integer, changeId: text }),
  // What this project is running: a bounded summary a person may read.
  'project.runs': obj({ ...project, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['projectId']),
  // Dry run: check a body against an operation's schema without doing anything.
  'protocol.validate': obj({ method: text, body: record }),
  'project.doctor': obj({ ...project, intent: { enum: ['run-r', 'edit-documents', 'inspect-tables', 'present'] } }, ['projectId']),
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
for (const [method, contract] of Object.entries(documentContracts)) operations[method] = { ...contract.inputSchema, properties: { ...project, ...contract.inputSchema.properties }, required: ['projectId', ...contract.inputSchema.required] };
const condition = { ...project, compositionId: changeId, expectedVersion: integer, changeId };
const view = { ...base.operations['composition.put'].properties.views.items, additionalProperties: false };
view.properties.bindings = { type: 'object', additionalProperties: { oneOf: [ref, obj({ documentId: ref.properties.version, version: positive }), obj({ kind: { const: 'live-document' }, documentId: ref.properties.version })] } };
operations['composition.put'].properties.views.items = view;
view.properties.presentation = obj({ emphasis: { enum: ['normal', 'highlight'] } });
const node = { oneOf: [obj({ id: changeId, kind: { const: 'group' }, children: { ...array(changeId), maxItems: 256, uniqueItems: true }, presentation: presentationSchemas.GroupPresentation }, ['id', 'kind', 'children']), obj({ ...view.properties, kind: { const: 'view' }, protected: { type: 'boolean' } }, [...view.required, 'kind'])] };
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
// Task map: the words are the Agent's. Kinds, states, tones, roles and form names
// are open identifiers; schemas bound only their shape and size.
// The Agent's words may be any script; prototype keys are refused.
const word = { type: 'string', minLength: 1, maxLength: 64, pattern: '^\\S+$', not: { enum: ['__proto__', 'constructor', 'prototype'] } };
const hint = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' };
const phrase = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const term = obj({ label: phrase(80), tone: hint, role: hint, icon: hint, description: phrase(240) }, ['label']);
const terms = { type: 'object', maxProperties: 64, propertyNames: word, additionalProperties: { anyOf: [term, { type: 'null' }] } };
const mapTarget = { type: 'string', pattern: '^(map:[a-z0-9-]{1,32}|item:[A-Za-z0-9._:@-]{1,128})$' };
const formParams = { type: 'object', maxProperties: 16 };
const taskItem = obj({ id: changeId, kind: word, state: word, title: phrase(160), group: phrase(60), summary: phrase(280),
  lines: { ...array(obj({ label: phrase(40), text: phrase(280), tone: hint, judgment: { type: 'boolean' } }, ['text'])), maxItems: 12 },
  progress: obj({ done: integer, total: positive, unit: phrase(24) }, ['done']), view: changeId, from: { ...array(changeId), maxItems: 16, uniqueItems: true } }, ['id', 'kind', 'state', 'title']);
operations['task.map.read'] = obj(project);
operations['task.map.declare'] = obj({ ...project, expectedVersion: integer, changeId, question: { anyOf: [phrase(240), { type: 'null' }] }, compositionId: { anyOf: [changeId, { type: 'null' }] }, vocabulary: obj({ kinds: terms, states: terms }, []), items: { ...array(taskItem), maxItems: 256 }, remove: { ...array(changeId), maxItems: 256, uniqueItems: true }, next: { ...array(changeId), maxItems: 16, uniqueItems: true } }, ['projectId', 'expectedVersion', 'changeId']);
operations['task.map.present'] = obj({ ...project, expectedVersion: integer, changeId, target: mapTarget, form: hint, params: formParams, focus: { anyOf: [changeId, { type: 'null' }] }, reason: phrase(160) }, ['projectId', 'expectedVersion', 'changeId', 'target']);
operations['task.map.respond'] = obj({ ...project, expectedVersion: integer, changeId, target: mapTarget, action: { enum: ['pin', 'unpin', 'revert', 'accept', 'dismiss'] }, form: hint, params: formParams, suggestionId: changeId }, ['projectId', 'expectedVersion', 'changeId', 'target', 'action']);
for (const [method, schema] of Object.entries(annotationInputs)) operations[method] = obj({ ...project, ...schema.properties });
operations['context.create'] = obj({ ...operations['context.create'].properties, annotations: { ...array(obj({ annotationId: changeId, version: positive })), minItems: 1, maxItems: 128 }, changeId, expectedVersion: { const: 0 } }, ['projectId']);
for (const method of ['workspace.save', 'workspace.export']) operations[method] = obj({ ...operations[method].properties, format: { enum: [1, 2, 3] } }, operations[method].required);
operations['context.create'].properties.region = obj({ page: positive, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 }, units: { enum: ['pixels', 'points'] } });
for (const [method, schema] of Object.entries({ 'feedback.submit': feedbackSchemas.FeedbackSubmitInput, 'feedback.read': feedbackSchemas.FeedbackReadInput, 'feedback.status': feedbackSchemas.DeliveryStatusInput })) operations[method] = schema;
operations['view.observe'] = presentationSchemas.VisibilityInput;
operations['view.observations.read'] = presentationSchemas.VisibilityReadInput;
operations['task.routing.put'] = nativeSchemas.RouteInput;
operations['binding.open'] = nativeSchemas.BindingOpenExtended;
operations['binding.activity.append'] = nativeSchemas.ActivityAppendInput;
operations['binding.activity'] = { ...nativeSchemas.NativeActivityReadInput, required: ['projectId'], allOf: [{ if: { required: ['source'] }, then: { required: ['source', 'taskId', 'query'] }, else: { not: { anyOf: [{ required: ['taskId'] }, { required: ['query'] }] } } }] };
for (const [method, schema] of Object.entries({ 'workspace.observe': enhancementSchemas.PresentationReadInput, 'workspace.enhance': enhancementSchemas.EnhanceInput, 'capability.index': discoverySchemas.IndexInput, 'capability.resolve': discoverySchemas.ResolveInput })) operations[method] = schema;
operations['session.grant'].properties.profile = { enum: ['layered-business', 'layered-presentation'] };
operations['session.grant'].properties.methods.items = { enum: Object.keys(operations).filter(m => !m.startsWith('session.') && !m.startsWith('project.')) };
export const resourceSchema = { ...base.definitions.resource, additionalProperties: true, properties: { ...base.definitions.resource.properties, kind: { enum: ['file', 'table', 'media', 'object', 'plot', 'model'] }, format: { anyOf: [record, { type: 'string' }] } } };
const retainedPlan: any = base.definitions.run.properties.plan;
export const runSchema = { ...base.definitions.run, properties: { ...base.definitions.run.properties, plan: { ...retainedPlan, properties: { ...retainedPlan.properties, completion: { type: ['string', 'null'] } } } } };
const selection = { ...base.definitions.selection, properties: { ...base.definitions.selection.properties, namespace: text } };
const definitions = { ...base.definitions, document: documentSchema, run: runSchema, resource: resourceSchema, selection, declaration: declarationSchema, executionInput: executionInputSchema, requirements: requirementsSchema };
const artifactFacts = response({ integrity: record, domain: record, resources: array(resourceSchema) }, ['integrity', 'domain']);
export const responses: Record<string, any> = { ...base.responses,
  'project.pick': response({ cancelled: { type: 'boolean' }, project: { anyOf: [base.responses['project.create'], { type: 'null' }] } }),
  'project.source.pick': response({ cancelled: { type: 'boolean' }, selection: { anyOf: [response({ selectionId: text, id: text, root: text, name: text }), { type: 'null' }] } }),
  'project.source.add': response({ cancelled: { type: 'boolean' }, project: { anyOf: [base.responses['project.create'], { type: 'null' }] } }),
  'project.createWorkspace': base.responses['project.create'],
  'project.runs': response({ runs: array(response({ operationId: text, action: text, execution: text, delivery: text, acceptedAt: text, author: text, artifacts: array(text), hasStderr: { type: 'boolean' } })), total: integer, truncated: { type: 'boolean' } }),
  'protocol.validate': response({ method: text, valid: { type: 'boolean' }, problems: array(response({ path: text, keyword: text, message: text, fix: text })), requires: array(text) }),
  'project.doctor': response({ ok: { type: 'boolean' }, checks: array(response({ id: text, state: { enum: ['ok', 'warn', 'fail'] }, detail: text, remedy: text })), intent: { anyOf: [response({ id: text, methods: array(text), missing: array(text), ready: { type: 'boolean' } }), { type: 'null' }] } }),
  'project.entries': response({ entries: array(response({ path: text, name: text, kind: { enum: ['file', 'folder'] }, bytes: integer, hidden: { type: 'boolean' } })), total: integer, truncated: { type: 'boolean' }, roots: array(text), path: text }),
  'session.browser.pair': response({ code: text, expiresAt: text }),
  'session.browser.revoke': response({ sessionId: text, revoked: { type: 'boolean' } }),
  'protocol.describe': response({ apiVersion: { const: '2.0' }, schemaVersion: { const: 2 }, revision: ref.properties.version, entries: array(response({ method: text, summary: text })), next: { type: ['string', 'null'] }, complete: { type: 'boolean' }, contract: response({ method: text, inputSchema: record, outputSchema: record, definitions: record, description: text }) }, ['apiVersion', 'schemaVersion', 'revision', 'entries', 'next', 'complete']),
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
  'media.describe': response({ resource: resourceSchema, original: ref, mimeType: text, rendering: { const: 'unobserved' } }),
  'workspace.save': { ...base.responses['workspace.save'], properties: { ...base.responses['workspace.save'].properties, schemaVersion: { enum: [1, 2, 3] }, selection: { anyOf: [selection, { type: 'null' }] } } },
  'observation.snapshot': { ...base.responses['observation.snapshot'], properties: { ...base.responses['observation.snapshot'].properties, resources: array(resourceSchema), operations: array(runSchema), selection: { anyOf: [selection, { type: 'null' }] } } }
};
const structuredComposition = response({ format: { const: 'rho.composition/1' }, compositionId: text, version: positive, nodes: array(node), rootId: changeId, receipt: record, author: text, views: array(view), availability: record, acknowledgedAt: text });
for (const [method, contract] of Object.entries(documentContracts)) responses[method] = contract.outputSchema;
responses['observation.snapshot'].properties.documents = array(documentSummarySchema);
responses['workspace.save'].properties.documents = array(documentSchema);
for (const method of ['composition.apply', 'composition.undo', 'view.protection.set']) responses[method] = structuredComposition;
responses['project.openFile'] = response({ document: base.responses['document.open'], viewId: text, composition: structuredComposition });
const composition = { anyOf: [base.definitions.composition, structuredComposition] };
responses['composition.read'] = composition;
responses['view.close'] = composition;
responses['interaction.selection.read'] = record;
responses['interaction.selection.set'] = record;
const taskMap = response({ format: { const: 'rho.task-map/1' }, version: integer, vocabulary: record, items: array(record), next: array(text), presentation: record, suggestions: array(record), receipts: array(record) }, ['format', 'version', 'vocabulary', 'items', 'next', 'presentation', 'suggestions']);
for (const method of ['task.map.read', 'task.map.declare', 'task.map.present', 'task.map.respond']) responses[method] = taskMap;
Object.assign(responses, annotationOutputs);
responses['context.create'] = record;
responses['context.read'] = record;
responses['observation.snapshot'].properties.compositions = array(composition);
responses['workspace.save'].properties.compositions = array(composition);
for (const method of ['requirements.prepare', 'action.submit', 'action.lookup', 'action.observe', 'action.retry', 'action.cancel']) responses[method] = runSchema;
responses['action.list'] = array(runSchema);
responses['feedback.submit'] = feedbackSchemas.SubmissionRecord;
responses['feedback.read'] = feedbackSchemas.FeedbackReadOutput;
responses['feedback.status'] = feedbackSchemas.DeliveryStatusOutput;
responses['view.observe'] = presentationSchemas.VisibilityReceipt;
responses['view.observations.read'] = presentationSchemas.VisibilityReadOutput;
responses['task.routing.put'] = nativeSchemas.RouteOutput;
responses['binding.open'] = { anyOf: [responses['binding.open'], nativeSchemas.BindingRecordExtension] };
responses['binding.activity.append'] = nativeSchemas.ActivityAppendOutput;
responses['binding.activity'] = { anyOf: [responses['binding.activity'], nativeSchemas.NativeActivityReadOutput] };
for (const [method, schema] of Object.entries({ 'workspace.observe': enhancementSchemas.PresentationReadOutput, 'workspace.enhance': presentationSchemas.CompositionCommit, 'capability.index': discoverySchemas.IndexOutput, 'capability.resolve': discoverySchemas.ResolveOutput })) responses[method] = schema;
responses['session.grant'].properties.profile = operations['session.grant'].properties.profile;
export const descriptions = {
  'workspace.observe': 'Assigned presenter only: bounded layout/basis/owner summary/visibility projection. No feedback, full documents or native trace. Reading starts no model or renderer.',
  'workspace.enhance': 'Assigned presenter only: conditional display emphasis/title/plain Agent note using exact current generation, witness and observation. Does not modify business resources, feedback or protection.',
  'capability.index': 'Read a small role-narrowed index of currently authorized, enabled operations and immutable Skill/contract references.',
  'capability.resolve': 'Fetch selected relevant Skills with complete owner contracts, whole objects only. Pages pin catalog/bundle/caller; knownRefs only reuse currently available immutable bodies.', ...base.descriptions,
  'feedback.submit': 'Teacher browser only: freeze the original draft/anchor, prepare the committed message and retain one original-session delivery. Preserve submissionId across missing acknowledgements; stages are separate durable facts.',
  'feedback.read': 'Original business binding only: fetch one complete frozen feedback object using its original delivery/context and a stable fetchId. relatedDocumentId is a pointer: read its CURRENT version before conditional edit/save and preserve human changes. This owner-served receipt does not prove client return or understanding.',
  'feedback.status': 'Observe original delivery, exact-target fetches and explicitly linked replies. No send, session start or recovery. Keep original identities and unknown outcomes; continuation cursors pin their snapshot.',
  'task.map.read': 'Observe the task map: declared items, vocabulary, next steps, forms, pins and pending suggestions. Reading starts, resumes or reruns nothing.',
  'task.map.declare': 'Agent only: conditionally declare task items, your own kind/state vocabulary (label, tone, optional role) and the next steps you will take. Rho shows next only from this declaration and never infers it.',
  'task.map.present': 'Change a map placement or item card form, its parameters (including a subset) or the focus. Shared by the Agent and people. An Agent change to a pinned target, or within agentFormIntervalMs of its last applied form change, is merged into one pending suggestion instead of applied; Agent changes stay attributed and revertible.',
  'task.map.respond': 'Browser person only: pin or unpin what they see, revert an Agent form change (layout only, never the work), or accept/dismiss a pending suggestion.',
  'capability.configure': 'Persist the selected project plugins with a conditional version and idempotent changeId. This changes routing only; it installs no package, starts no runtime and cancels no work.',
  'skill.list': 'List the application and enabled provider Skills shipped in the selected package. Skills guide discovery but do not grant authorization.',
  'skill.read': 'Read one versioned shipped Skill after checking its digest. A stale digest requires rereading instead of applying cached instructions.',
  'action.submit': 'Execute the explicitly selected project R script snapshot and requirements. Persist operationId before delivery; identical retries retain the original Core identity. Output directory is the first R argument, followed by explicit args or frozen resource paths. Artifact paths are output-relative; completion is run-directory-relative, returned as plan.completion, so an inventory can remain beside immutable producer artifacts.',
  'binding.activity.append': 'Registered native adapter only: retain original CLI tool and artifact-ready observations. This does not execute, validate, or present artifacts.',
  'task.routing.put': 'Control plane only: conditionally assign one task and business binding to this project without starting a native session.',
  'resource.register': 'Declare scoped existing bytes and their type/schema at the supplied digest. This read and registration starts no runtime.',
  'project.runs': 'Report what this project has run and what it is running: one bounded summary per operation with its execution state, accepted time, author kind, declared artifact paths and whether output was retained. It carries no request body, no code and no output text, and starts nothing.',
  'protocol.validate': 'Check one operation body against its versioned schema without executing it: the same checks the server applies, reported with the edit each problem needs. Use it before a write whose shape is uncertain; it changes nothing and starts nothing.',
  'project.doctor': 'Report whether this project can actually do work right now: Core binary, Rscript, write access to the project and state folders, plugin selection, Host socket and unfinished runs. Each check carries the next action when it does not pass. It starts no Host and changes nothing.',
  'project.entries': 'List one level of the selected project folder for the person who opened it: ordinary files and folders, bounded and confined to the project root, excluding owner state. Listing reads no file contents and starts no runtime.',
  'project.openFile': 'Open one text file from the selected project as a document and place it in the person\'s own layout in one conditional step, so a person can see and edit their own source files without an Agent. Confined to the project root; it executes nothing.',
  'requirements.check': 'Probe only the explicitly declared R packages with bounded base R; no Core Host or project script starts.',
  'data.compare': 'Join two explicit table versions using declared keys, namespaces, fields and join policy. Scientific comparability remains the project responsibility.',
  'object.read': 'Read a bounded exported JSON object snapshot, not live R memory.',
  'artifact.check': 'Verify the selected completion inventory and file bytes only; domain check reports remain project resources.'
};
export const errorKinds = base.errorKinds;
export const errorSchema = base.definitions.error;
export const errorEnvelope = obj({ apiVersion: { const: '2.0' }, ok: { const: false }, error: errorSchema });
export const responseEnvelope = (method: string) => obj({ apiVersion: { const: '2.0' }, ok: { const: true }, value: responses[method] });
export const protocol = { ...base, apiVersion: '2.0', schemaVersion: 2, transport: 'HTTP JSON POST /api/v2/{operation}; GET /api/v2/events', eventTypes: [...new Set([...base.eventTypes, 'project.sources.changed', 'capability.changed', 'view.closed', 'interaction.selection.changed', 'annotation.changed', 'context.changed', 'workspace.restored', 'task.routing.changed', 'binding.native.changed', 'feedback.changed', 'task.map.changed'])], operations, responses, descriptions, definitions, errorEnvelope, legacy: 'v1 schemas and captured fixtures are frozen. Legacy reads and explicit retry/cancel of accepted requests remain available; new recipe submissions require an explicit v2 project script.' };
