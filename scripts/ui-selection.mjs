import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateUiExtension, uiExtensionLimits } from '../dist/ui-extension.js';
import { operations } from '../dist/protocol.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function json(file) {
  if (fs.statSync(file).size > uiExtensionLimits.maxManifestBytes) throw new Error('UI selection exceeds maxManifestBytes (64 KiB): ' + path.basename(file));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function inside(directory, relative) {
  const resolved = fs.realpathSync(path.resolve(directory, relative));
  if (!resolved.startsWith(fs.realpathSync(directory) + path.sep)) throw new Error('UI entry must stay inside its package.');
  return resolved;
}
export function readUiPackage(directory, { development = false } = {}) {
  directory = fs.realpathSync(directory);
  const pkg = json(path.join(directory, 'package.json'));
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name ?? '') || typeof pkg.version !== 'string' || !pkg.version) throw new Error('UI package needs a valid name and exact version.');
  if (typeof pkg.rho?.ui !== 'string') throw new Error('Set package.json rho.ui to the package-relative manifest file.');
  const manifestPath = inside(directory, pkg.rho.ui), extension = json(manifestPath);
  validateUiExtension(extension);
  if (!extension.requiredOperations.every(method => Object.hasOwn(operations, method))) throw new Error('UI extension requires an unknown operation.');
  const exported = pkg.exports?.[extension.entry];
  if (typeof exported !== 'string' || !exported.startsWith('./')) throw new Error('Export ' + extension.entry + ' as a compiled JavaScript entry in package.json.');
  const source = inside(directory, development ? extension.development : exported);
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size > uiExtensionLimits.maxEntryBytes) throw new Error('UI entry must be a file within maxEntryBytes (16 MiB).');
  return { plugin: extension.plugin, package: pkg.name, packageVersion: pkg.version, entry: extension.entry, component: extension.component, version: extension.version,
    source, directory, extension, entrySha256: sha(fs.readFileSync(source)), manifestSha256: sha(fs.readFileSync(manifestPath)) };
}
export function extensionPackages(selectionFile = process.env.RHO_UI_EXTENSIONS) {
  if (!selectionFile) return [];
  const file = path.resolve(selectionFile), selection = json(file);
  if (selection.format !== 'rho.ui-selection/1' || !Array.isArray(selection.packages) || selection.packages.length > uiExtensionLimits.maxEntries) throw new Error('Select at most ' + uiExtensionLimits.maxEntries + ' packages with format rho.ui-selection/1.');
  const require = createRequire(file), entries = selection.packages.map(item => {
    if (typeof item.package !== 'string' || typeof item.version !== 'string') throw new Error('Pin each selected package name and version.');
    const directory = item.directory ? path.resolve(path.dirname(file), item.directory) : path.dirname(require.resolve(item.package + '/package.json'));
    const entry = readUiPackage(directory);
    if (entry.package !== item.package || entry.packageVersion !== item.version) throw new Error('Selected UI package identity/version mismatch: ' + item.package);
    return { ...entry, localOverride: !!item.directory };
  });
  if (new Set(entries.map(e => e.component)).size !== entries.length) throw new Error('Duplicate UI extension component.');
  return entries;
}
export function selectedUiEntries() {
  const entries = JSON.parse(fs.readFileSync(path.join(root, 'ui-entries.json'), 'utf8'));
  const selected = process.env.RHO_UI_PLUGINS?.split(','), omitted = process.env.RHO_UI_OMIT?.split(',') ?? [];
  // Rho's own selection of first-party views over existing capabilities, then any chosen for this build.
  const extensions = [...extensionPackages(path.join(root, 'ui-extensions.json')), ...extensionPackages()];
  if (new Set(extensions.map(e => e.component)).size !== extensions.length) throw new Error('Duplicate UI extension component.');
  const known = new Set(['documents', 'files', 'r', 'requirements', 'tables', 'media', 'charts', 'annotations', 'agent', 'console']);
  for (const e of extensions) if (!known.has(e.plugin)) throw new Error('Choose an existing capability owner for ' + e.component + ': ' + e.plugin);
  return [...entries, ...extensions].filter(e => e.package ? selected === undefined || selected.includes(e.plugin) : !omitted.includes(e.plugin));
}
export function contributionMetadata(e) {
  return { entryVersion: '0.1-draft', owner: e.package, package: e.package, packageVersion: e.packageVersion, component: e.component, componentVersion: e.version,
    propsSchema: e.extension.propsSchema, bindings: Object.fromEntries(Object.entries(e.extension.bindings).map(([key, kind]) => [key, kind === 'document' ? 'document' : 'resource'])),
    requiredOperations: e.extension.requiredOperations, selection: [], commands: [], displayName: e.extension.displayName };
}
