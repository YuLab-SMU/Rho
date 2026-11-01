// A project that comes with Rho: one finished study, kept beside the application so a person
// who starts Rho sees what a project looks like when the work is done rather than an empty page.
// It is copied once into the folder Rho keeps projects in, because a project is the person's
// own folder and `.rho` state is written into it; after that it is an ordinary project that can
// be read, edited, continued or removed like any other. Seeding never fails a start: a folder
// that cannot be written leaves the project list as it was.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson } from '@rho-workspace/plugin-contracts';
import type { Project, State } from './state.js';

// The bundled example sits beside the compiled service, like the browser files it serves.
export const exampleRoot = fileURLToPath(new URL('../example/', import.meta.url));
export const exampleName = 'PA14 quorum sensing';
export interface ExampleSeed { version: string; projectId?: string; root?: string; name?: string; at: string; skipped?: string; problem?: string }
const marker = (state: State) => path.join(state.directory, 'example.json');

// Copy a folder tree of ordinary files and folders. Symbolic links are refused rather than
// followed: the example is the application's own content and never reaches outside itself.
async function copy(from: string, to: string, budget = { bytes: 80 * 1024 * 1024, files: 4000 }) {
  await fs.mkdir(to, { recursive: true, mode: 0o755 });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await copy(source, target, budget); continue; }
    if (!entry.isFile()) continue;
    const stat = await fs.lstat(source);
    budget.bytes -= stat.size; budget.files -= 1;
    if (budget.bytes < 0 || budget.files < 0) throw new Error('The example is larger than a project Rho copies.');
    await fs.copyFile(source, target);
    await fs.chmod(target, (stat.mode & 0o777) | 0o600);
  }
}

// What the application ships, if it ships one at all: a reduced or source installation may not.
export async function bundledExample(): Promise<{ directory: string; name: string; version: string } | null> {
  const manifest = await readJson<{ project?: string; name?: string; version?: string } | null>(path.join(exampleRoot, 'example.json'), null);
  const stat = await fs.stat(exampleRoot).catch(() => null);
  if (!stat?.isDirectory() || !manifest?.project) return null;
  return { directory: path.join(exampleRoot, manifest.project), name: manifest.name ?? exampleName, version: manifest.version ?? '0' };
}

// Copy the example into the person's projects folder once, and register it as an ordinary
// project. The record stays in the service's state so a later start neither copies it again nor
// brings back a copy the person deleted.
export async function seedExampleProject(state: State, options: { enabled?: boolean; directory?: string; name?: string } = {}): Promise<ExampleSeed | null> {
  if (options.enabled === false) return null;
  const previous = await readJson<ExampleSeed | null>(marker(state), null);
  if (previous) return null;
  const at = new Date().toISOString(), record: ExampleSeed = { version: '0', at };
  try {
    const example = options.directory
      ? { directory: options.directory, name: options.name ?? exampleName, version: '0' }
      : await bundledExample();
    if (!example) { record.skipped = 'This installation ships no example project.'; return null; }
    record.version = example.version;
    const target = path.join(state.root, example.name);
    // The person's folder is never overwritten: an existing folder is left exactly as it is.
    const exists = await fs.stat(target).catch(() => null);
    if (exists) { record.skipped = 'A folder with the example\'s name is already in the projects folder.'; return null; }
    const staging = target + '.rho-example';
    await fs.rm(staging, { recursive: true, force: true });
    await copy(example.directory, staging);
    await fs.rename(staging, target);
    const project: Project = { id: '', root: target, openedAt: at, name: example.name, example: { version: example.version } };
    const opened = await state.openExample(project);
    record.projectId = opened.id; record.root = opened.root; record.name = opened.name;
    return record;
  } catch (error) {
    record.problem = error instanceof Error ? error.message : String(error);
    return record;
  } finally {
    await atomicJson(marker(state), record).catch(() => {});
  }
}
