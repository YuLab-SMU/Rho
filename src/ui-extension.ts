import { Ajv } from 'ajv';

// A selected UI package contributes views over an existing capability. It cannot
// declare operations, authorize calls or load a server implementation.
export const uiExtensionLimits = { maxEntries: 32, maxManifestBytes: 64 * 1024, maxEntryBytes: 16 * 1024 * 1024 };
export interface UiExtension {
  format: 'rho.ui-extension/1';
  plugin: string;
  component: string;
  version: string;
  displayName: string;
  description: string;
  entry: string;
  development: string;
  export: string;
  propsSchema: Record<string, unknown>;
  bindings: Record<string, string>;
  requiredOperations: string[];
}
export interface InstalledUiEntry {
  plugin: string; package?: string; packageVersion: string; component: string; version: string;
  entrySha256?: string; extension?: UiExtension;
}
const identity = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const ajv = new Ajv({ strict: false, allowUnionTypes: true });
export function validateUiExtension(value: unknown): asserts value is UiExtension {
  const m = value as UiExtension;
  const fail = (message: string): never => { throw new Error('UI extension: ' + message); };
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('expected a JSON object.');
  if (Buffer.byteLength(JSON.stringify(m)) > uiExtensionLimits.maxManifestBytes) fail('manifest exceeds maxManifestBytes (64 KiB).');
  const fields = ['format', 'plugin', 'component', 'version', 'displayName', 'description', 'entry', 'development', 'export', 'propsSchema', 'bindings', 'requiredOperations'];
  if (Object.keys(m).some(k => !fields.includes(k)) || fields.some(k => !(k in m))) fail('use only the documented manifest fields.');
  if (m.format !== 'rho.ui-extension/1') fail('unsupported format.');
  if (![m.plugin, m.component].every(v => typeof v === 'string' && identity.test(v)) || typeof m.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(m.version)) fail('invalid plugin, component or version.');
  if (m.component.startsWith('rho.')) fail('the rho. component namespace is reserved.');
  if (typeof m.export !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(m.export)) fail('export must name a JavaScript export.');
  if (![m.entry, m.development].every(v => typeof v === 'string' && /^\.\/[A-Za-z0-9_./-]+$/.test(v) && !v.split('/').includes('..'))) fail('entry and development must be package-relative paths.');
  if (typeof m.displayName !== 'string' || !m.displayName.trim() || m.displayName.length > 120 || typeof m.description !== 'string' || m.description.length > 600) fail('provide a displayName and a description of at most 600 characters.');
  if (!m.bindings || Array.isArray(m.bindings) || typeof m.bindings !== 'object' || Object.keys(m.bindings).length > 16 || Object.entries(m.bindings).some(([k, v]) => !identity.test(k) || !['document', 'table', 'media', 'file', 'object'].includes(v))) fail('bindings must name document, table, media, file or object resources.');
  if (!Array.isArray(m.requiredOperations) || m.requiredOperations.length > 32 || new Set(m.requiredOperations).size !== m.requiredOperations.length || m.requiredOperations.some(v => typeof v !== 'string' || !identity.test(v))) fail('requiredOperations must contain unique method names.');
  if (!m.propsSchema || m.propsSchema.type !== 'object') fail('propsSchema must describe an object.');
  const refs = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#'))) fail('propsSchema references must stay inside the schema.');
      refs(child);
    }
  };
  refs(m.propsSchema);
  try { ajv.compile(m.propsSchema); } catch (error) { fail('invalid propsSchema: ' + (error as Error).message); }
}
