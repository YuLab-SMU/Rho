// Installed third-party packages are application assembly, independent of the
// functional owners compiled into Rho. This protocol never imports their code.
const str = { type: 'string', minLength: 1, maxLength: 1024 };
const id = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,95}$' };
const sha = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const json = { type: 'object', additionalProperties: true };
const project = { projectId: str };
const selected = { ...project, pluginId: id, expectedDigest: sha };
export const extensionOperations = {
  'extension.list': object(project, []),
  'extension.describe': object({ ...project, pluginId: id }),
  'extension.content': object({ ...selected, kind: { enum: ['skill', 'view'] }, entryId: id }),
  'extension.call': object({ ...selected, operation: id, input: json, changeId: { type: 'string', pattern: '^[A-Za-z0-9._:@-]{1,128}$' } }),
  'extension.read': object({ ...project, invocationId: sha }),
  'extension.install': object({ source: str, replace: id, expectedDigest: sha }, ['source']),
  'extension.manage': object({ pluginId: id, expectedDigest: sha, action: { enum: ['enable', 'disable', 'remove'] } }),
};
const array = (items: unknown) => ({ type: 'array', items });
const text = { type: 'string' };
const entry = { ...object({ id, title: text, file: text }), additionalProperties: true };
const manifest = { ...object({ apiVersion: { const: 1 }, id, title: text, description: text, host: text,
  operations: array({ ...object({ id, title: text, description: text, effect: { enum: ['read', 'native'] }, methods: array(text), inputSchema: json }), additionalProperties: true }),
  skills: array(entry), views: array(entry),
}, ['apiVersion', 'id', 'title', 'description', 'operations', 'skills', 'views']), additionalProperties: true };
const installed = { id, name: text, version: text, title: text, description: text, digest: sha, source: text, sourceCommit: text, enabled: { type: 'boolean' }, installedAt: text };
const installedRequired = Object.keys(installed).filter(key => key !== 'sourceCommit');
const descriptor = object({ ...installed, manifest }, [...installedRequired, 'manifest']);
const receipt = object({ invocationId: sha, caller: text, projectId: text, pluginId: id, packageDigest: sha, operation: id, requestDigest: sha,
  state: { enum: ['pending', 'completed', 'unknown'] }, startedAt: text, endedAt: text, value: {}, error: text,
  delegations: array(object({ method: text, request: {}, state: { enum: ['pending', 'completed', 'unknown'] }, value: {}, error: text }, ['method', 'request', 'state'])),
}, ['invocationId', 'caller', 'projectId', 'pluginId', 'packageDigest', 'operation', 'requestDigest', 'state', 'startedAt']);
export const extensionResponses = {
  'extension.list': object({ plugins: array(object(installed, installedRequired)), directory: array(object({ id, title: text, version: text, description: text, source: text, repository: text, needs: text })), limits: json }),
  'extension.describe': descriptor,
  'extension.install': descriptor,
  'extension.content': object({ pluginId: id, packageDigest: sha, entryId: id, kind: { enum: ['skill', 'view'] }, title: text, text }),
  'extension.call': receipt,
  'extension.read': receipt,
  'extension.manage': object({ pluginId: id, action: { enum: ['enable', 'disable', 'remove'] }, retained: text }),
};
export const extensionDescriptions = {
  'extension.list': 'List independently installed third-party packages and their enabled state, source and immutable digest. Reads start no plugin or runtime. Use extension.describe to discover operation schemas and Skills.',
  'extension.describe': 'Read an installed third-party package manifest, operation input schemas, required Rho methods, Skills and views. Read its Skill with extension.content before use. Disabled packages cannot run.',
  'extension.content': 'Read one installed plugin Skill or standalone HTML view at its selected package digest. Reading starts no plugin or runtime.',
  'extension.call': 'Call an enabled third-party operation at the described package digest, under the caller and project. The package runs trusted native code. Non-read calls retain the original changeId: repeat observes that invocation, including unknown outcomes, without re-execution. Completion is not scientific validity.',
  'extension.read': 'Observe an original plugin invocation, including pending or unknown outcomes. Never reruns code. Only its original caller can read it.',
  'extension.install': 'Local person/operator: install a trusted prebuilt npm package, local folder, tarball, or Git source. Lifecycle scripts are disabled. Replacement stages and checks the new package before switching; use replace and expectedDigest for updates.',
  'extension.manage': 'Local person/operator: enable, disable or remove an installed third-party package at the expected digest. Existing native tasks, R sessions, project files and retained receipts are preserved.',
};
export const extensionManagement = ['extension.install', 'extension.manage'];
export const extensionMethods = Object.keys(extensionOperations);
