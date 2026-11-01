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
// Windows shows its own folder window (IFileOpenDialog picking folders) through Windows
// PowerShell, which every Windows has. The window is owned by a hidden topmost window so it opens
// above the browser, at that window's corner: near the top left of the screen the pointer is on,
// where the person just clicked Open folder. The starting folder comes in an environment
// variable, and the chosen one goes back as base64 of its UTF-8 bytes, so neither a quote nor the
// console's code page changes it; nothing back is a cancel.
const windowsScript = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Rho {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr filters); void SetFileTypeIndex(uint index); void GetFileTypeIndex(out uint index);
    void Advise(IntPtr sink, out uint cookie); void Unadvise(uint cookie);
    void SetOptions(uint options); void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item); void SetFolder(IShellItem item); void GetFolder(out IShellItem item); void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label); void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  public static class Folder {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr context, [MarshalAs(UnmanagedType.LPStruct)] Guid iid, out IShellItem item);
    public static string Choose(IntPtr owner, string title, string initial) {
      var dialog = (IFileDialog)new FileOpenDialog();
      uint options; dialog.GetOptions(out options);
      // Folders only, on the file system, that exist; the working folder stays as it is.
      dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x8);
      dialog.SetTitle(title);
      try { IShellItem start; SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out start); dialog.SetFolder(start); } catch (Exception) { }
      int result = dialog.Show(owner);
      if (result == unchecked((int)0x800704C7)) return "";
      Marshal.ThrowExceptionForHR(result);
      IShellItem chosen; dialog.GetResult(out chosen);
      string folder; chosen.GetDisplayName(0x80058000, out folder);
      return folder;
    }
  }
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.FormBorderStyle = 'None'; $owner.Opacity = 0
$area = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea
$owner.StartPosition = 'Manual'; $owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Location = New-Object System.Drawing.Point(($area.X + [int]($area.Width / 6)), ($area.Y + [int]($area.Height / 10)))
$owner.Show(); $owner.Activate()
try { $folder = [Rho.Folder]::Choose($owner.Handle, '${prompt}', $env:RHO_FOLDER_START) } finally { $owner.Close() }
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($folder)))`;

export class NativeFolderPicker {
  private child?: ChildProcess;
  constructor(private limits: typeof nativeFolderLimits) {}
  async choose(initial: string): Promise<string | null> {
    if (process.platform === 'darwin') {
      const chosen = await this.run('/usr/bin/osascript', ['-e', script, initial]);
      requireThat(chosen !== undefined, 'unavailable', 'The system folder chooser is unavailable. Open the project from your Agent.');
      return chosen;
    }
    if (process.platform === 'win32') {
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const chosen = await this.run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64')], undefined, { RHO_FOLDER_START: initial });
      requireThat(chosen !== undefined, 'unavailable', 'The system folder chooser is unavailable. Open the project from your Agent.');
      return chosen && Buffer.from(chosen, 'base64').toString('utf8');
    }
    requireThat(process.platform === 'linux', 'unavailable', 'The system folder chooser is supported on macOS, Windows and Linux desktops. Open the project from your Agent on other systems.');
    requireThat(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, 'unavailable', 'Rho is not running in a desktop session, so it cannot show a folder window. Open the project from your Agent.');
    for (const chooser of linuxChoosers) {
      const [program, args] = chooser(initial), chosen = await this.run(program, [...args], 1);
      if (chosen !== undefined) return chosen;
    }
    throw new Fault('unavailable', 'No system folder chooser is installed. Install zenity or kdialog, or open the project from your Agent.');
  }
  // Resolves the folder, null when the person cancelled, or undefined when the program is not installed.
  private run(program: string, args: string[], cancelExit?: number, env?: Record<string, string>): Promise<string | null | undefined> {
    return new Promise((resolve, reject) => {
      this.child = execFile(program, args, { timeout: this.limits.timeoutMs, maxBuffer: this.limits.maxOutputBytes, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout) => {
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
