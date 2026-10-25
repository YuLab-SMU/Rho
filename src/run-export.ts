import * as fs from 'node:fs/promises';
import path from 'node:path';
import { atomicBytes, atomicJson, confined, digest, now, requireThat } from '@rho-workspace/plugin-contracts';
import type { Operation } from './requests.js';
import type { Project } from './state.js';

// One run, exported: the script that ran, the files it declared and
// a record of where they came from and what was checked, as ordinary files a person opens with
// their own tools. Nothing runs again and nothing is called checked that was not: a declared
// file that was not written, or no longer matches the inventory the run wrote, is named in the
// record and left out. Unsaved text of the script leaves only when the caller chooses it.
export const exportLimits = { maxExportBytes: 512 * 1024 * 1024, maxInventoryBytes: 65536 };
export type Unsaved = 'leave' | 'include';
type State = 'exported' | 'not-written' | 'changed' | 'not-retained' | 'left-out';
export interface ExportEntry {
  role: 'script' | 'unsaved-script' | 'output'; path: string; state: State;
  file?: string; bytes?: number; sha256?: string; check?: string; reason?: string; resource?: { id: string; version: string };
}
interface Documents { summaries(): Promise<Array<{ id: string; path: string; version: number; dirty: boolean }>>; read(id: string): Promise<{ content: string; version: number }> }
interface Resource { id: string; version: string; path: string; provenance?: { operationId?: string } }
export interface ExportOptions {
  destination?: string; unsaved?: Unsaved; documents?: Documents; resources: Resource[]; maxFileBytes: number;
  // Where a project path is on disk, source folders included.
  sourceFile: (relative: string) => Promise<string>;
  // Facts the caller already words for people: who submitted the run and how it ended.
  submittedBy: string; exit: string | null; projectName: string;
}

// The script R ran is the plan's code after the one library-path line Rho put in front of it;
// it is the script only when its digest is the one the run recorded.
function scriptThatRan(plan: any): string | null {
  const recorded = plan?.source?.sha256, code = plan?.code;
  if (typeof code !== 'string' || typeof recorded !== 'string') return null;
  const body = code.startsWith('.libPaths(') ? code.slice(code.indexOf('\n') + 1) : code;
  return digest(body) === recorded ? body : digest(code) === recorded ? code : null;
}
async function inventoryOf(root: string, plan: any) {
  if (typeof plan?.completion !== 'string') return null;
  try {
    const file = await confined(root, plan.completion, true), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > exportLimits.maxInventoryBytes) return null;
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(manifest?.artifacts) ? manifest.artifacts.filter((x: any) => typeof x?.path === 'string' && typeof x?.sha256 === 'string') as Array<{ path: string; sha256: string }> : null;
  } catch { return null; }
}
const shown = (relative: string) => relative.split(path.sep).join('/');

export async function exportRun(project: Project, run: Operation, options: ExportOptions) {
  const plan = run.plan as any, source = plan?.source ?? {};
  requireThat(plan && typeof plan.code === 'string', 'condition', 'This run has no retained plan, so there is nothing to export.');
  const destination = options.destination ?? 'exports/' + run.operationId;
  requireThat(!destination.split('/').some(part => ['.rho', '.git', '..'].includes(part)), 'scope', 'Choose an export folder inside the project and outside its internal state.');
  const scriptPath = typeof source.path === 'string' ? source.path : null;
  const buffer = scriptPath && options.documents ? (await options.documents.summaries()).find(d => d.path === scriptPath && d.dirty) : undefined;
  requireThat(!buffer || options.unsaved !== undefined, 'condition', `${scriptPath} has unsaved changes. Say whether the export includes them (unsaved: "include") or leaves them out (unsaved: "leave").`, { unsaved: [{ path: scriptPath, version: buffer?.version }] });

  // An export writes only into a folder it creates; the record is written last, so a folder
  // without provenance.json is not a finished export.
  const target = await confined(project.root, destination, true);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await confined(project.root, path.relative(project.root, path.dirname(target)) || '.');
  try { await fs.mkdir(target, { mode: 0o700 }); }
  catch (error: any) { requireThat(error?.code !== 'EEXIST', 'conflict', `${destination} already exists. Choose another folder; an export never writes into an existing one.`, { destination }); throw error; }
  const entries: ExportEntry[] = [];
  let total = 0;
  const put = async (relative: string, bytes: Uint8Array | string) => {
    const data = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
    total += data.length;
    requireThat(total <= exportLimits.maxExportBytes, 'limit', 'The export exceeds its byte budget; the files written so far are not a finished export.', { limit: 'maxExportBytes', maximum: exportLimits.maxExportBytes });
    const file = await confined(target, relative, true);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicBytes(file, data);
    return { file: shown(relative), bytes: data.length, sha256: digest(data) };
  };

  // The script that ran, from the run's own record, and how the file on disk compares now.
  if (scriptPath) {
    const name = path.posix.basename(scriptPath.split(path.sep).join('/')), ran = scriptThatRan(plan);
    const onDisk = await options.sourceFile(scriptPath).then(file => fs.readFile(file, 'utf8')).then(text => digest(text) === source.sha256 ? 'the file on disk is the same' : 'the file on disk has changed since', () => 'the file is no longer on disk');
    entries.push(ran === null
      ? { role: 'script', path: scriptPath, state: 'not-retained', sha256: source.sha256, reason: 'The run did not retain the code that ran.' }
      : { role: 'script', path: scriptPath, state: 'exported', ...await put(path.join('script', name), ran), check: `the code this run recorded; ${onDisk}` });
    if (buffer) {
      const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name, extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
      if (options.unsaved === 'include') {
        const text = (await options.documents!.read(buffer.id)).content;
        entries.push({ role: 'unsaved-script', path: scriptPath, state: 'exported', ...await put(path.join('script', `${stem}.unsaved${extension}`), text), check: `unsaved text at buffer version ${buffer.version}; it never ran` });
      } else entries.push({ role: 'unsaved-script', path: scriptPath, state: 'left-out', reason: `Unsaved text at buffer version ${buffer.version}, left out by choice.` });
    }
  }

  // Each declared file, as the run left it, checked against the inventory it wrote.
  const inventory = await inventoryOf(project.root, plan);
  const declared: Array<{ path: string }> = Array.isArray(source.artifacts) ? source.artifacts : [];
  for (const d of declared) {
    const relative = typeof plan.output === 'string' ? path.join(plan.output, d.path) : null;
    const file = relative ? await confined(project.root, relative, true).catch(() => null) : null;
    const stat = file ? await fs.lstat(file).catch(() => null) : null;
    if (!stat?.isFile()) { entries.push({ role: 'output', path: d.path, state: 'not-written', reason: 'The run declared this file but did not write it.' }); continue; }
    if (stat.size > options.maxFileBytes) { entries.push({ role: 'output', path: d.path, state: 'left-out', bytes: stat.size, reason: 'Larger than the file byte limit.' }); continue; }
    const data = await fs.readFile(file!), sha256 = digest(data), listed = inventory?.find(x => x.path === d.path);
    if (listed && listed.sha256 !== sha256) { entries.push({ role: 'output', path: d.path, state: 'changed', sha256, reason: 'It no longer matches the inventory the run wrote.' }); continue; }
    const registered = options.resources.find(r => r.provenance?.operationId === run.operationId && r.path === relative && r.version === sha256);
    entries.push({ role: 'output', path: d.path, state: 'exported', ...await put(path.join('outputs', d.path), data),
      check: listed ? 'matches the inventory the run wrote' : inventory ? 'not listed in the inventory the run wrote; not checked' : 'the run wrote no inventory; not checked',
      ...(registered ? { resource: { id: registered.id, version: registered.version } } : {}) });
  }

  const outputs = entries.filter(e => e.role === 'output');
  const partial = run.execution !== 'completed' || outputs.some(e => e.state !== 'exported');
  const name = (ref: { id?: string; version?: string }) => options.resources.find(r => r.id === ref.id && r.version === ref.version)?.path ?? `${ref.id}@${ref.version}`;
  const args = (Array.isArray(run.request?.input?.args) ? run.request.input.args : []).map((arg: any) => typeof arg === 'string' ? arg : arg?.resource ? { resource: arg.resource, path: name(arg.resource) } : arg);
  const inputs = (Array.isArray(source.inputs) ? source.inputs : []).map((ref: any) => ({ ...ref, path: name(ref) }));
  const record = {
    schemaVersion: 1, complete: true, exportedAt: now(), project: { id: project.id, name: options.projectName },
    run: { operationId: run.operationId, action: run.action, actionVersion: run.actionVersion, submittedBy: options.submittedBy, acceptedAt: run.acceptedAt, execution: run.execution, exit: options.exit, repairOf: (run as any).repairOf ?? null },
    script: scriptPath ? { path: scriptPath, sha256: source.sha256 ?? null } : null, args, inputs, partial,
    files: entries,
    checks: {
      bytes: 'Each exported file has its SHA-256 here, taken as it was written.',
      inventory: inventory ? 'The run wrote an inventory; each output says whether it matches.' : 'The run wrote no inventory, so no output was checked against one.',
      integrity: run.integrity?.state ?? 'unchecked', domain: run.domain?.state === 'checked' ? 'A domain check was recorded.' : 'No domain check was recorded.',
      scope: 'No run establishes that a statistical result is correct.'
    }
  };
  await atomicBytes(path.join(target, 'PROVENANCE.md'), provenanceText(record));
  await atomicJson(path.join(target, 'provenance.json'), record);
  return { destination: shown(destination), state: 'complete' as const, partial, exported: entries.filter(e => e.state === 'exported').length, files: entries, provenanceDigest: digest(await fs.readFile(path.join(target, 'provenance.json'))) };
}

// The same record for a person reading the folder without Rho.
function provenanceText(r: any) {
  const line = (e: ExportEntry) => `- ${e.file ?? e.path}: ${e.state === 'exported' ? `${e.bytes} bytes, SHA-256 ${e.sha256}; ${e.check}` : `${e.state.replace('-', ' ')}. ${e.reason}`}${e.resource ? ` (registered version ${e.resource.version.slice(0, 12)})` : ''}`;
  const by = (role: string) => r.files.filter((e: ExportEntry) => e.role === role);
  return [
    `# ${r.run.operationId}${r.partial ? ' (partial)' : ''}`, '',
    `Exported from the Rho project ${r.project.name} at ${r.exportedAt}.`,
    `${r.run.action} ${r.run.actionVersion}, submitted by ${r.run.submittedBy} at ${r.run.acceptedAt}: ${r.run.execution}${r.run.exit ? `, ${r.run.exit}` : ''}.${r.run.repairOf ? ` It repairs ${r.run.repairOf}.` : ''}`, '',
    '## Script', ...[...by('script'), ...by('unsaved-script')].map(line),
    ...(r.args.length ? ['', `Arguments: ${r.args.map((a: any) => typeof a === 'string' ? a : a.path).join(' ')}`] : []),
    ...(r.inputs.length ? ['', '## Inputs', ...r.inputs.map((i: any) => `- ${i.path} (version ${String(i.version).slice(0, 12)})`)] : []),
    '', '## Outputs', ...(by('output').length ? by('output').map(line) : ['- The run declared no output files.']),
    '', '## What was checked', `- ${r.checks.bytes}`, `- ${r.checks.inventory}`, `- ${r.checks.domain}`, `- ${r.checks.scope}`, ''
  ].join('\n');
}
