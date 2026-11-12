import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

// A program the code under test starts by its path (an Agent client, Core, a launcher), played by
// a Node script. Elsewhere the script is the program: `#!/usr/bin/env node` and executable. Windows
// runs a script only through a batch file, as npm installs a Node program there: the script is
// kept as written and FILE.cmd runs it with this Node. A batch file cannot be given an argument
// over several lines (the Claude CLI's system prompt), so with `exe` FILE.exe runs it instead: a
// launcher compiled once with the C# compiler Windows has, which runs the script beside it with
// this Node and every argument as given. Returns the path to give as the program.
export async function standIn(file, source, { exe = false } = {}) {
  const script = source.startsWith('#!') ? source : '#!/usr/bin/env node\n' + source;
  await fs.writeFile(file, script, { mode: 0o755 });
  if (process.platform !== 'win32') return file;
  if (exe) { await fs.copyFile(await launcher(), file + '.exe'); return file + '.exe'; }
  await fs.writeFile(file + '.cmd', `@"${process.execPath}" "${file}" %*\r\n`);
  return file + '.cmd';
}
// The stand-in gone, as a program that is not installed.
export async function removeStandIn(file) {
  for (const extension of ['', '.cmd', '.exe']) await fs.rm(file + extension, { force: true });
}

// FILE.exe: runs FILE with this Node, each argument quoted as a program reads its command line,
// with the same standard streams, and ends with its exit code.
const launcherSource = String.raw`using System; using System.Diagnostics; using System.Text;
public static class Launcher {
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '\n', '\r', '"' }) < 0) return a;
    var s = new StringBuilder("\""); int slashes = 0;
    foreach (char c in a) {
      if (c == '\\') { slashes++; continue; }
      s.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0; s.Append(c);
    }
    s.Append('\\', slashes * 2); s.Append('"'); return s.ToString();
  }
  public static int Main(string[] args) {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    var line = new StringBuilder(Quote(self.Substring(0, self.Length - 4)));
    foreach (string a in args) line.Append(' ').Append(Quote(a));
    var child = Process.Start(new ProcessStartInfo(NODE, line.ToString()) { UseShellExecute = false });
    child.WaitForExit(); return child.ExitCode;
  }
}`;
async function launcher() {
  const source = launcherSource.replace('NODE', JSON.stringify(process.execPath));
  const file = path.join(os.tmpdir(), 'rho-stand-in-' + createHash('sha256').update(source).digest('hex').slice(0, 16) + '.exe');
  if (await fs.stat(file).then(() => true, () => false)) return file;
  // Test files run at once: each compiles to a name of its own, and the first in place stays.
  const made = file + '.' + randomBytes(4).toString('hex') + '.exe';
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Add-Type -TypeDefinition $env:RHO_LAUNCHER_SOURCE -OutputAssembly $env:RHO_LAUNCHER_FILE -OutputType ConsoleApplication'],
    { env: { ...process.env, RHO_LAUNCHER_SOURCE: source, RHO_LAUNCHER_FILE: made }, windowsHide: true, stdio: 'ignore' });
  await fs.rename(made, file).catch(() => fs.rm(made, { force: true }));
  return file;
}
