import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lease } from './state.js';
import { running } from './running.js';

// Starting Rho in the background used to be a script each Agent wrote for itself: on Windows a
// PowerShell file run past the execution policy, with a hidden `Start-Process`, a deleted log and a
// polling loop. Each Agent wrote it differently, and security software flagged that combination as
// a downloader. These commands do the same from Rho's own code, so an Agent runs one plain command.

const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
export const logFile = (stateDirectory: string) => path.join(stateDirectory, 'rho.log');
export const previousLogFile = (stateDirectory: string) => path.join(stateDirectory, 'rho.previous.log');
// --open says when it could not open a browser, so a start on a machine without a screen (a server,
// a container, an Agent's sandbox) does not look like one that opened a tab nobody sees. The opener
// is given 5 s to say it failed; one still running then is taken as opening.
export function openInBrowser(target: string): Promise<{ opened: boolean; note: string }> {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.WSL_DISTRO_NAME)
    return Promise.resolve({ opened: false, note: `No browser was opened: this machine has no display (DISPLAY and WAYLAND_DISPLAY are unset). Open ${target} in a browser on this machine, or forward its port to one that has a browser.` });
  const [command, args] = process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]];
  return new Promise(resolve => {
    const failed = (why: string) => resolve({ opened: false, note: `Could not open a browser (${why}). Open ${target} yourself.` });
    // Both stay referenced until the opener answers, or this process could end before it does.
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    const timer = setTimeout(() => { child.unref(); resolve({ opened: true, note: 'Opened in the default browser.' }); }, 5000);
    child.on('error', error => { clearTimeout(timer); failed(error.message); });
    child.on('exit', code => { clearTimeout(timer); if (code) failed(`${command} exited with ${code}`); else resolve({ opened: true, note: 'Opened in the default browser.' }); });
  });
}
// The command a person or an Agent types on this system: in PowerShell plain `rho` is a script
// that Windows' default execution policy refuses, while `rho.cmd` runs everywhere.
export const rhoCommand = process.platform === 'win32' ? 'rho.cmd' : 'rho';

// The state's writer lock says whether a service runs there: a lock this command can take is free.
// A folder without a connection file was never a Rho state, and is not given a lock file.
export async function holds(stateDirectory: string) {
  return lease(stateDirectory).then(async release => { await release(); return false; }, (e: { kind?: string }) => { if (e?.kind === 'conflict') return true; throw e; });
}
export async function connection(stateDirectory: string) {
  return fs.readFile(path.join(stateDirectory, 'connection.json'), 'utf8')
    .then(text => JSON.parse(text) as { url?: unknown; pid?: unknown }).catch(() => null);
}
async function lines(file: string) {
  return (await fs.readFile(file, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean);
}

// What a later look at a state folder can say: whether its service runs and answers, where its log
// is, and, when it is not running, how the last one ended. A service that stopped in order wrote a
// {"shutdown":…} line; one ended from outside (killed, out of memory, its session or sandbox gone)
// could write nothing, and a crash leaves its error in the log.
export async function serviceStatus(stateDirectory: string) {
  const state = path.resolve(stateDirectory), real = (folder: string) => fs.realpath(folder).catch(() => path.resolve(folder));
  const found = await connection(state);
  const log = await fs.access(logFile(state)).then(() => logFile(state), () => undefined);
  const here = await real(state), notes = await running();
  const others = (await Promise.all(notes.map(async note => await real(note.stateDirectory) === here ? null : { state: note.stateDirectory, url: note.url, pid: note.pid }))).filter(note => note !== null);
  if (!found) return { status: { state, running: false, note: 'No Rho has run with this state folder.' }, others };
  const url = typeof found.url === 'string' ? found.url : undefined, pid = Number.isInteger(found.pid) ? found.pid as number : undefined;
  const up = await holds(state);
  let answers = 0;
  if (url) try { answers = (await fetch(url, { signal: AbortSignal.timeout(3000) })).status; } catch {}
  let note: string;
  if (up) note = answers ? 'Running.' : 'Its process holds the state folder, but the address does not answer.';
  else {
    const last = log ? (await lines(log)).at(-1) ?? '' : '';
    let ended: { by?: unknown; at?: unknown } | null = null;
    try { const parsed = JSON.parse(last); if (parsed && 'shutdown' in parsed) ended = parsed; } catch {}
    note = ended ? `Not running. It stopped in order${typeof ended.by === 'string' ? ' on ' + ended.by : ''}${typeof ended.at === 'string' ? ' at ' + ended.at : ''}.`
      : log ? 'Not running. Its log ends without a {"shutdown":…} line: it crashed (its error is in the log) or was ended from outside, such as killed, out of memory, or the session, container or sandbox that held it ended.'
      : 'Not running.';
  }
  return { status: { state, running: up, url, pid, answers, ...(log ? { log } : {}), note }, others };
}

// Windows runs the service under `cmd.exe`, which writes its output to the log. `cmd` gets a
// console with no window (all of its standard handles are its own), so R, the Agent clients and
// every other console program Rho starts share that console instead of each opening a window. The
// service is `cmd`'s child, so it is not in the job that ends `cmd` when this command returns.
function spawnWindows(args: string[], log: string): ChildProcess {
  const bad = args.find(arg => /["%\r\n]/.test(arg));
  if (bad) throw Object.assign(new Error(`--background cannot pass ${JSON.stringify(bad)} through cmd.exe on Windows. Give an --acp-command in RHO_ACP_COMMAND instead, or start Rho in a window you keep open.`), { kind: 'refused' });
  const quote = (arg: string) => '"' + arg.replace(/(\\+)$/, '$1$1') + '"';
  const line = [process.execPath, cli, ...args].map(quote).join(' ') + ' > ' + quote(log) + ' 2>&1';
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
}

// Starts the same command in the background with its output in the state's rho.log, keeps the
// last start's log as rho.previous.log, and returns once the service is ready or has failed.
export async function startInBackground(args: string[], stateDirectory: string, { waitMs = 60000, quiet = false } = {}) {
  const state = path.resolve(stateDirectory), log = logFile(state);
  await fs.mkdir(state, { recursive: true });
  const say = (text: string) => { if (!quiet) process.stdout.write(text + '\n'); }, fail = (text: string, code = 1) => { process.stderr.write(text.trimEnd() + '\n'); return code; };
  if (await connection(state) && await holds(state)) {
    const url = (await connection(state))?.url;
    return fail(`Rho is already running for ${state}${typeof url === 'string' ? ' at ' + url : ''}. Open that url, or stop that service before starting it again.`);
  }
  // A log that the last service still holds (Windows keeps it open until that process ends) is
  // left in place, and this start's output follows it.
  const moved = await fs.rename(log, previousLogFile(state)).then(() => true, (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  const before = moved ? 0 : (await lines(log)).length;
  let child: ChildProcess;
  if (process.platform === 'win32') {
    try { child = spawnWindows(args, log); } catch (error) { return fail((error as Error).message, 2); }
  } else {
    const out = openSync(log, 'a');
    child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', out, out], detached: true });
    closeSync(out);
  }
  let exited: number | null | undefined;
  child.on('exit', code => { exited = code ?? 1; });
  child.on('error', error => { exited = 1; process.stderr.write(error.message + '\n'); });
  const since = Date.now();
  let ready = '';
  while (Date.now() - since < waitMs) {
    ready = (await lines(log)).slice(before).find(line => line.startsWith('{"ready"')) ?? '';
    if (ready || exited !== undefined) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) {
    const tail = (await lines(log)).slice(before).slice(-30).join('\n');
    if (exited !== undefined) return fail(`Rho stopped before it was ready (exit ${exited}). Its output, from ${log}:\n${tail || '(nothing)'}`, exited || 1);
    child.unref();
    return fail(`Rho printed no ready line within ${waitMs / 1000} s and is still starting. Its output goes to ${log}${tail ? ':\n' + tail : '.'}\nLook again with: ${rhoCommand} --status --state-dir "${state}"`);
  }
  child.unref();
  const pid = (await connection(state))?.pid;
  say(ready);
  try { const url = JSON.parse(ready).ready.url; say(`Rho is a workspace in the browser: open ${url} in a browser on this machine.`); } catch {}
  say(`Rho runs in the background${Number.isInteger(pid) ? ` as process ${pid}` : ''}, with its output in ${log}.`);
  say(`Check it:  ${rhoCommand} --status --state-dir "${state}"`);
  say(`Stop it:   ${rhoCommand} --stop --state-dir "${state}"`);
  return 0;
}

// The Agent Skill that ships with this version, copied into the folder an Agent loads skills from.
// The files come from the installed package, which npm checked against the registry, so the Skill
// matches the Rho it describes and nothing is downloaded.
export async function installSkill(directory: string, version: string) {
  const source = fileURLToPath(new URL('../skills/rho/', import.meta.url)), target = path.resolve(directory);
  const named = async (file: string) => (await fs.readFile(file, 'utf8').catch(() => '')).match(/^name:\s*(\S+)\s*$/m)?.[1];
  const existing = await named(path.join(target, 'SKILL.md'));
  if (existing !== undefined && existing !== 'rho') throw Object.assign(new Error(`${target} holds another skill, named ${existing}. Choose another folder, or ask the person what it is.`), { kind: 'refused' });
  const files = (await fs.readdir(source, { recursive: true })).map(f => String(f).split(path.sep).join('/')).filter(f => f.endsWith('.md')).sort();
  if (!files.includes('SKILL.md')) throw new Error(`This installation has no Rho skill at ${source}.`);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(target, file));
  }
  return { skill: { name: await named(path.join(target, 'SKILL.md')), version, dir: target, files } };
}
