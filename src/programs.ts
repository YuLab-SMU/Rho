import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { locate } from '@rho-workspace/plugin-agent/acp-command';

// A program the person names (an Agent client, Core), started as Windows starts it. Windows finds
// a program named without a folder by the extensions PATHEXT lists, as a shell does (Node tries
// only .com and .exe), and runs a batch file (an npm shim such as codex.cmd) only through cmd.exe,
// which Node no longer does for a program it is asked to start. There the batch file and each
// argument are quoted as a program reads its command line and cmd's own characters escaped with ^,
// twice, as cmd reads the line again when it runs the batch file (the escaping cross-spawn uses):
// quotes, %, ^, &, |, <, > and an empty argument reach the program as given. cmd ends a command
// line at a line break, so an argument over several lines is refused for a batch file rather
// than cut. A program not found starts as named, and fails as missing. Elsewhere, and for any
// other file, the program starts as named.
const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;
const batchArgument = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(cmdMeta, '^$1').replace(cmdMeta, '^$1');
export function spawnProgram(program: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.platform !== 'win32') return spawn(program, args, options);
  const file = locate(program, options.env ?? process.env);
  // Node refuses to start a batch file's path at all (EINVAL); one that is not there is missing.
  if (!file && /\.(cmd|bat)$/i.test(program)) throw Object.assign(new Error(`spawn ${program} ENOENT`), { code: 'ENOENT', syscall: 'spawn ' + program, path: program });
  if (!file || !/\.(cmd|bat)$/i.test(file)) return spawn(file ?? program, args, options);
  if (args.some(arg => /[\r\n]/.test(arg))) throw new Error(`${path.basename(file)} is a batch file, which Windows cannot give an argument over several lines. Select the program it runs (an .exe) instead.`);
  const line = [`"${file}"`.replace(cmdMeta, '^$1'), ...args.map(batchArgument)].join(' ');
  const cmd = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return spawn(cmd, ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true });
}
// Ends a program started so, at once. On Windows that is its process tree (taskkill /T /F): a
// batch file's cmd.exe ended alone leaves the program it started running, holding the output.
export function endProgram(child: ChildProcess) {
  if (process.platform !== 'win32' || !child.pid) { child.kill('SIGKILL'); return; }
  execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
}
