import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rho describes selected component contracts even when the component package is
// absent, so it has to keep a copy of them. A hand-maintained copy drifts: the
// earlier copies already differed from their owners in ways nobody chose. This
// script derives the copy from each owner's *pure* contract entry, records the
// package/version/entry digest it came from, and writes one generated module.
//
// Nothing here imports a component implementation: the entries below are the
// owners' schema modules. The generated snapshot is what the service reads at
// runtime, so an absent package is still describable without being installed,
// activated or imported.
const root = new URL('../', import.meta.url);
const output = new URL('src/contracts/owners.generated.ts', root);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Every owner contributes the same three things: the identity of the entry it was
// read from, the exported schemas Rho consumes, and the operations it declares.
const owners = [
  { id: 'documents', package: '@rho-workspace/plugin-documents', entry: './operations', take: ['operationContracts', 'documentSchema', 'documentSummarySchema', 'receiptSchema', 'pendingSaveSchema', 'historyEntrySchema'] },
  { id: 'files', package: '@rho-workspace/plugin-files', entry: './operations', take: ['operationContracts'] },
  { id: 'r', package: '@rho-workspace/plugin-r', entry: './operations', take: ['operationContracts'] },
  { id: 'requirements', package: '@rho-workspace/plugin-requirements', entry: './operations', take: ['operationContracts'] },
  { id: 'tables', package: '@rho-workspace/plugin-tables', entry: './operations', take: ['operationContracts'] },
  { id: 'media', package: '@rho-workspace/plugin-media', entry: './operations', take: ['operationContracts'] },
  { id: 'charts', package: '@rho-workspace/plugin-charts', entry: './operations', take: ['operationContracts'] },
  { id: 'agent', package: '@rho-workspace/plugin-agent', entry: './operations', take: ['operationContracts'] },
  { id: 'agent-feedback', package: '@rho-workspace/plugin-agent', entry: './feedback-contract', take: ['feedbackSchemas'] },
  { id: 'agent-native', package: '@rho-workspace/plugin-agent', entry: './contract', take: ['nativeSchemas'] },
  { id: 'agent-session', package: '@rho-workspace/plugin-agent', entry: './session-contract', take: ['sessionObservationSchema', 'configOptionSchema'] },
  { id: 'annotations', package: '@rho-workspace/plugin-annotations', entry: './contract', take: ['inputs', 'outputs'] },
  { id: 'console', package: '@rho-workspace/plugin-console', entry: './operations', take: ['operationContracts'] },
  { id: 'entry-files', package: '@rho-workspace/plugin-files', entry: './contract', take: ['declarationSchema'] },
  { id: 'entry-tables', package: '@rho-workspace/plugin-tables', entry: './contract', take: ['declarationSchema', 'columnSchema', 'tableFormatSchema'] },
  { id: 'entry-media', package: '@rho-workspace/plugin-media', entry: './contract', take: ['declarationSchema'] },
  { id: 'entry-r', package: '@rho-workspace/plugin-r', entry: './contract', take: ['declarationSchema', 'scriptSchema'] },
  { id: 'entry-requirements', package: '@rho-workspace/plugin-requirements', entry: './contract', take: ['requirementSchema', 'requirementsSchema'] }
];

// `r.execute` composes the owner declarations into one input. The composition is
// Rho's application decision, but every part and the function itself are the
// owners'; the snapshot records the exact inputs so a changed composition is a
// visible diff rather than a silent second definition.
async function composeExecutionInput(selected) {
  const { createExecutionInputSchema } = await import('@rho-workspace/plugin-r/contract');
  const declarations = { oneOf: [selected['entry-files'].declarationSchema, selected['entry-tables'].declarationSchema, selected['entry-media'].declarationSchema, selected['entry-r'].declarationSchema] };
  const requirements = selected['entry-requirements'].requirementsSchema;
  return { schema: createExecutionInputSchema(declarations, requirements), by: '@rho-workspace/plugin-r/contract#createExecutionInputSchema', declarationsDigest: sha(JSON.stringify(declarations)), requirementsDigest: sha(JSON.stringify(requirements)) };
}

const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])])) : value;

async function build() {
  const selected = {}, provenance = {};
  for (const owner of owners) {
    const specifier = owner.package + ('./' === owner.entry ? '' : '/' + owner.entry.slice(2));
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    const bytes = await readFile(resolved);
    const packageRoot=await realpath(new URL('node_modules/'+owner.package+'/',root));
    const relativeEntry=path.relative(packageRoot,resolved);
    if(path.isAbsolute(relativeEntry)||relativeEntry.startsWith('..'))throw new Error('Owner entry is outside its selected package.');
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL('node_modules/' + owner.package + '/package.json', root)), 'utf8'));
    const module = await import(specifier);
    const missing = owner.take.filter(name => !(name in module));
    if (missing.length) throw new Error(`${owner.package}${owner.entry} does not export ${missing.join(', ')}`);
    const exports = Object.fromEntries(owner.take.map(name => [name, sortKeys(module[name])]));
    selected[owner.id] = exports;
    provenance[owner.id] = { package: owner.package, packageVersion: pkg.version, entry: owner.entry, entryPath: owner.package+'/'+relativeEntry.split(path.sep).join('/'), entrySha256: sha(bytes), exports: Object.fromEntries(owner.take.map(name => [name, sha(JSON.stringify(exports[name]))])) };
  }
  const execution = await composeExecutionInput(selected);
  selected.execution = { input: execution.schema };
  provenance.execution = { by: execution.by, entry: './contract', package: '@rho-workspace/plugin-r', packageVersion: provenance['entry-r'].packageVersion, declarationsDigest: execution.declarationsDigest, requirementsDigest: execution.requirementsDigest, exports: { input: sha(JSON.stringify(execution.schema)) } };
  const snapshot = { format: 'rho.owner-contracts/1', selected, provenance };
  const banner = `// Generated by scripts/contract-owners.mjs from the selected owner contract entries.
// Do not edit: run \`npm run build:contracts\` (or \`npm run check:contracts\` to verify).
// The snapshot records each source package, version and entry digest, so an absent
// owner is still describable without importing or activating its implementation.
//
// The payload is opaque JSON Schema data; the typed public boundary is derived from
// the assembled protocol in src/contract.generated.ts, not inferred from this file.
export interface OwnerContractProvenance {
  readonly package?: string; readonly packageVersion?: string; readonly entry?: string;
  readonly entryPath?: string; readonly entrySha256?: string;
  readonly by?: string; readonly declarationsDigest?: string; readonly requirementsDigest?: string;
  readonly exports: Readonly<Record<string, string>>;
}
export interface OwnerContractSnapshot {
  readonly format: 'rho.owner-contracts/1';
  readonly selected: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly provenance: Readonly<Record<string, OwnerContractProvenance>>;
}
`;
  return { text: banner + 'export const ownerContracts: OwnerContractSnapshot = ' + JSON.stringify(snapshot, null, 2) + ';\n', count: Object.keys(selected).length };
}

const { text, count } = await build();
if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8').catch(() => '');
  if (current !== text) {
    console.error('src/contracts/owners.generated.ts is out of date with the selected owner contracts. Run: npm run build:contracts');
    process.exitCode = 1;
  } else console.log('Owner contract snapshot is current.');
} else {
  await mkdir(new URL('src/contracts/', root), { recursive: true });
  await writeFile(output, text);
  console.log('Owner contract snapshot: ' + count + ' entries, ' + text.length + ' bytes');
}
