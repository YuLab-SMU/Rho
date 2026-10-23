import { execFile, type ChildProcess } from 'node:child_process';
import { Fault, requireThat } from '@rho-workspace/plugin-contracts';

export const nativeFolderLimits = { timeoutMs: 120000, maxOutputBytes: 16384, maxProjects: 128, maxSources: 32, maxSelections: 64, selectionTtlMs: 600000, maxEntries: 500 };
// Only the trusted local process supplies this script. HTTP callers supply no
// path or script: the person selects the folder in the operating system dialog.
const script = `on run argv
  activate
  try
    set selectedFolder to choose folder with prompt "Open a project folder in Rho" default location (POSIX file (item 1 of argv))
    return POSIX path of selectedFolder
  on error number -128
    return ""
  end try
end run`;

export class NativeFolderPicker {
  private child?: ChildProcess;
  constructor(private limits: typeof nativeFolderLimits) {}
  async choose(initial: string): Promise<string | null> {
    requireThat(process.platform === 'darwin', 'unavailable', 'The system folder chooser is currently supported on macOS. Open the project from your Agent on other systems.');
    return new Promise((resolve, reject) => {
      this.child = execFile('/usr/bin/osascript', ['-e', script, initial], { timeout: this.limits.timeoutMs, maxBuffer: this.limits.maxOutputBytes }, (error, stdout) => {
        this.child = undefined;
        if (error) {
          const limit = error.killed ? 'nativeFolders.timeoutMs' : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'nativeFolders.maxOutputBytes' : null;
          reject(new Fault('unavailable', 'The system folder chooser did not finish. No folder was opened. Try Open folder again.', limit ? { limit } : {})); return;
        }
        // osascript adds exactly one newline; preserve whitespace in folder names.
        const selected = stdout.replace(/\r?\n$/, '');
        resolve(selected || null);
      });
    });
  }
  close() { this.child?.kill(); }
}
