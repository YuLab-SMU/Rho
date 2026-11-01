import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { Fault, requireThat } from '@rho-workspace/plugin-contracts';

export const nativeFolderLimits = { timeoutMs: 120000, maxOutputBytes: 16384, maxProjects: 128, maxSources: 32, maxSelections: 64, selectionTtlMs: 600000, maxEntries: 500 };
const prompt = 'Open a project folder in Rho';
// Only the trusted local process supplies this script. HTTP callers supply no
// path or script: the person selects the folder in the operating system dialog.
const script = `on run argv
  activate
  try
    set selectedFolder to choose folder with prompt "${prompt}" default location (POSIX file (item 1 of argv))
    return POSIX path of selectedFolder
  on error number -128
    return ""
  end try
end run`;
// Linux desktops show the chooser through zenity (GNOME and most others) or
// kdialog (KDE). Both print the folder and exit 0, or exit 1 when cancelled.
const linuxChoosers = [
  (initial: string) => ['zenity', ['--file-selection', '--directory', '--title=' + prompt, '--filename=' + path.join(initial, '/')]] as const,
  (initial: string) => ['kdialog', ['--getexistingdirectory', initial, '--title', prompt]] as const
];

export class NativeFolderPicker {
  private child?: ChildProcess;
  constructor(private limits: typeof nativeFolderLimits) {}
  async choose(initial: string): Promise<string | null> {
    if (process.platform === 'darwin') {
      const chosen = await this.run('/usr/bin/osascript', ['-e', script, initial]);
      requireThat(chosen !== undefined, 'unavailable', 'The system folder chooser is unavailable. Open the project from your Agent.');
      return chosen;
    }
    requireThat(process.platform === 'linux', 'unavailable', 'The system folder chooser is supported on macOS and Linux desktops. Open the project from your Agent on other systems.');
    requireThat(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, 'unavailable', 'Rho is not running in a desktop session, so it cannot show a folder window. Open the project from your Agent.');
    for (const chooser of linuxChoosers) {
      const [program, args] = chooser(initial), chosen = await this.run(program, [...args], 1);
      if (chosen !== undefined) return chosen;
    }
    throw new Fault('unavailable', 'No system folder chooser is installed. Install zenity or kdialog, or open the project from your Agent.');
  }
  // Resolves the folder, null when the person cancelled, or undefined when the program is not installed.
  private run(program: string, args: string[], cancelExit?: number): Promise<string | null | undefined> {
    return new Promise((resolve, reject) => {
      this.child = execFile(program, args, { timeout: this.limits.timeoutMs, maxBuffer: this.limits.maxOutputBytes }, (error, stdout) => {
        this.child = undefined;
        if (error?.code === 'ENOENT') { resolve(undefined); return; }
        if (error && !(cancelExit !== undefined && error.code === cancelExit && !stdout)) {
          const limit = error.killed ? 'nativeFolders.timeoutMs' : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'nativeFolders.maxOutputBytes' : null;
          reject(new Fault('unavailable', 'The system folder chooser did not finish. No folder was opened. Try Open folder again.', limit ? { limit } : {})); return;
        }
        // The choosers add exactly one newline; preserve whitespace in folder names.
        const selected = stdout.replace(/\r?\n$/, '');
        resolve(selected || null);
      });
    });
  }
  close() { this.child?.kill(); }
}
