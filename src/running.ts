import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Each Rho started from the command line notes here which state folder it serves and where, so
// `rho connect` finds the Rho that holds a project folder without being given its state folder.
// A note holds no credential. The Rho removes it when it stops; a note left by one that did not
// stop in order is ignored once its process is gone. RHO_RUNNING_DIR moves the folder (tests).
export type Running = { stateDirectory: string; url: string; pid: number };
export const runningDirectory = (env: NodeJS.ProcessEnv = process.env) => env.RHO_RUNNING_DIR || path.join(os.homedir(), 'Rho', 'running');
const noteFile = (stateDirectory: string, directory: string) =>
  path.join(directory, createHash('sha256').update(path.resolve(stateDirectory)).digest('hex').slice(0, 16) + '.json');

async function read(file: string): Promise<Running | null> {
  try {
    const note = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof note?.stateDirectory === 'string' && typeof note?.url === 'string' && Number.isInteger(note?.pid) ? note : null;
  } catch { return null; }
}
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export async function announce(note: Running, directory = runningDirectory()) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = noteFile(note.stateDirectory, directory), partial = `${file}.${process.pid}.tmp`;
  await fs.writeFile(partial, JSON.stringify({ ...note, stateDirectory: path.resolve(note.stateDirectory) }) + '\n', { mode: 0o600 });
  await fs.rename(partial, file);
}

// Only the Rho that wrote a note removes it, so a later start on the same state keeps its own.
export async function withdraw(stateDirectory: string, pid = process.pid, directory = runningDirectory()) {
  const file = noteFile(stateDirectory, directory);
  if ((await read(file))?.pid === pid) await fs.rm(file, { force: true });
}

export async function running(directory = runningDirectory()) {
  const names = (await fs.readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
  const notes = await Promise.all(names.map(name => read(path.join(directory, name))));
  return notes.filter((note): note is Running => !!note && alive(note.pid));
}

export async function announced(stateDirectory: string, directory = runningDirectory()) {
  const note = await read(noteFile(stateDirectory, directory));
  return !!note && note.stateDirectory === path.resolve(stateDirectory) && alive(note.pid);
}
