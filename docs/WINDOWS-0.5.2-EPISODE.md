# 0.5.2 on Windows

Updated 2026-11-02. The user moved to a Windows machine and asked for Windows to be completed. The
0.5.2 candidate served macOS arm64 and Linux x64/arm64 ([platforms episode](PLATFORMS-0.5.2-EPISODE.md)).
Its Core commit, `c3dbeca`, carries Core's Windows port, which had only been type-checked for
`x86_64-pc-windows-gnu`. This episode builds and tests that Core with MSVC, makes Rho and the
Plugins run on Windows, packs a Windows candidate and installs it on this machine: Windows 11 x64
(10.0.26200), Node 22.23.4, R 4.5.1, Python 3.13.9 and Chrome.

## Core

`c3dbeca` passes format, Clippy, 79 regressions and the example with MSVC Build Tools 2022 and
Rust 1.97.0. The two Unix-only regressions are excluded. The checkout had LF line endings and
`CARGO_PROFILE_DEV_DEBUG=0`, as for the other platforms' Cores. The Windows Core is 4,614,144
bytes, SHA-256 `ce5acef1564cf7056a151c38582012e68cde0c60df8b91576567030e09d4d77a`. Core's library
and binary are unchanged. Core `6f83226` corrects only the Windows test fixtures, which logged the
pid of a `cat` instead of their own shell, and records the findings below
([CORE-20261101-02](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/work/CORE-20261101-02.md)).

A Host given Ctrl+Break ends at once (`0xC000013A`) without its shutdown report. Its console
handler returns 0, so Windows' default handler ends the process. Started on a console without a
window, it does not react to Ctrl+C. Only `RHO_CORE_STOP_FILE`, which Core's documentation calls
a test aid, stops it in order. Rho now relies on it. Core decides whether to make it a documented
interface or to have the handler return 1. The latter changes the binary, so every platform's
Core would be rebuilt.

A Host serves one named-pipe instance at a time and makes the next one only after it takes a
connection. Until then, another client finds the pipe busy, and Core reports the call as not
delivered (exit 3), with nothing done. The wait grows when the machine is busy. With every
processor busy, 8 of 200 concurrent `capability` calls were not delivered.

## Rho

**The Host outlives the service.** Node on Windows puts the processes it starts in a job that
ends them when Node ends. A Host started directly died with Rho, and its runs went on unheld.
`cmd.exe` now starts the Host and waits for it. What cmd starts is outside the job, so the Host
outlives Rho as a detached Host does elsewhere. Each argument reaches cmd as a variable inside
quotes, where neither cmd's expansion nor `& ^ ( )` apply. A project folder named
`a & b ^ %OS% !OS! (1) 中文 🧬` reached the Host unchanged, R ran in it, and no window opened
for cmd, the Host or R. Detached instead, the Host would have no console, and every run it
started would open a window.

**It stops with its report.** Rho starts its Host with a stop file and creates the file on close.
The Host reports `"signal": 15` and its runs, and Rho counts the report as confirmed. After a crash, a
restarted Rho finds the surviving Host among Core's pipes by the project its capability names.
Another program stops Rho with Ctrl+Break on Rho's console (`SIGBREAK`), which the launcher now
handles like `SIGINT`. Before, Rho ended at once (`0xC000013A`) and left its Host running.

**Calls that find the Host busy are tried again.** Core's contract for exit 3 is to try again.
A call on a pipe is tried up to five times, 20 to 80 ms apart, unless the CLI could not start.
With every processor busy, the same 200 calls were then all delivered. A full suite run had
failed `before-cli` this way. Retrying a CLI that could not start at all slowed every pipe
probe. That made one run fail the browser test with a one-second session, and that case is
excluded now.

**Other paths.** The service's writer lock is a file opened without sharing. The system releases
it when the service ends, so Windows needs no Python for it. Executables are found with `.exe`.
Directory flushes, which Windows refuses (EPERM), are skipped; NTFS journals the rename.
Open folder shows Windows' own folder window through PowerShell, above the browser, and returns a
Unicode path. Agent-reported Windows paths (`C:\…`, `c:/…`, Git Bash's `/c/…`) name project files.
`--open` opened Edge with the URL's fragment intact. The packer runs npm's CLI under Node, since
`npm.cmd` needs a shell. The recovery acceptance ends its R process tree.

## Plugins

Notebook 0.5.2, Console 0.3.1, Agent 0.4.25, Files 0.5.1, Documents 0.4.10 and R 0.4.2 run on
Windows ([Plugins status](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/STATUS.md)).
A Notebook session, Console command or Agent client gets a console of its own without a window.
Interrupt and Stop raise Ctrl+Break or Ctrl+C there, then end the process tree. R answers on a
named pipe, since it cannot open descriptor 3. A Console command's shell ends with Rho on
Windows, while the programs it started go on, so a command running when Rho closed is `unknown`
at the next start.

## Source checks

| Suite | Windows result |
| --- | --- |
| Core `c3dbeca` (fixtures as in `6f83226`) | fmt, Clippy, 79 regressions, example |
| Plugins `491c440` | 158/166; 8 skipped: Unix script stand-ins for Claude Code (3) and for ssh and serverctl (5) |
| Rho `ef8a0a2f` | 259/273; 13 skipped; MCP v2 stdio cancelled at its 30 s limit, as on macOS (26 s alone) |

The 13 Rho skips are stand-ins written as Unix scripts for Claude Code, Codex or Core (11) and
two checks of Unix socket files. Before this pass, the suite had 4 failures and the MCP
cancellation. One failure was a test reading R's `entry\r\n` as `entry\n`, which an `EBUSY` in
its cleanup had hidden. The three continuity tests failed on the Host lifetime above.
`launcher-stop` and a cmd-quoting test were added; each fails without its change.

## Candidate

| Field | Value |
| --- | --- |
| Artifact | `rho-workspace-local-0.5.2.tgz`, 12,129,769 bytes, 5,101 files |
| SHA-256 | `cf4336f2991642cc8f02a6b0c760360f6f5b78efe3d4435a4e0e23cff56f8753` |
| Platforms | win32-x64; packed on win32-x64 with Node 22.23.4 |
| Application | `5b9b613a`, clean (the code of `ef8a0a2f`, with its Windows notes in `docs/HEADLESS.md`) |
| Plugins | `491c440`, clean |
| Core | `c3dbeca` (tree `7ffadb94`, build inputs `6a01f9e8…`), packed from a clean worktree |

It carries only the Windows Core: the macOS and Linux Cores are on the Mac
(`work/platforms-0.5.2/`). Core is unchanged, so one tarball for all four platforms takes those
three binaries and this one, each with `--core PLATFORM=BINARY`, and `--core-source` at
`c3dbeca`. Two earlier candidates are superseded: `c9fbd861…`, in which Ctrl+Break still ended
Rho at once, and `a977f571…`, whose installed checks matched these but whose `HEADLESS.md` did
not yet describe Windows.

## Installation checks

The tarball was installed outside every checkout, offline with an empty npm cache, and run
with `RHO_CORE_BINARY` unset.

| Check | Windows 11 x64 |
| --- | --- |
| Offline install | 41 s; 51.8 MiB in 5,137 files; `rho.cmd` runs |
| Own platform's Core selected and digest-checked | Yes; removing win32-x64 from the composition and changing the Core's bytes were each refused, and the bytes restored |
| Packaged recovery acceptance (base R through Core, paused, Host lost) | 7 checks |
| Packaged acceptance, ordinary R project | 7 checks |
| Launcher ready | 2.8 s |
| Notebook | R message, warning, printed text and value in order; a 1008×720 plot; Python in order; no window for either session |
| Home at 1440/1024/768/390 | No page errors; shortcut shown as Ctrl K |
| Open folder | Windows' folder window, in front; choosing `打开的 folder & co` opened that project |
| `project.doctor` | All ok; Claude Code installed, Codex not found |
| Stopped with Ctrl+Break | Exit 0; no Core or Notebook session of the installation left |

Choosing the folder first failed. The test's own UI driver invoked automation id 1, which is
also the id of a row in the folder list. The window opened that folder instead of choosing it.
Clicking the Select Folder button with the row selected returned the folder in 4.5 s.

## Not done

- One tarball for macOS, Linux and Windows: it needs the Mac's three Cores.
- Real Claude Code and Codex conversations on Windows. Claude Code is installed but was not
  run with the person's account; Codex is not installed.
- The stand-in tests, and remote places over ssh or serverctl on Windows.
- Ctrl+C in a person's own terminal. The console here passes Ctrl+C turned off.
- The other episode scripts in `scripts/` still assume `/tmp` and process groups.
- Windows on arm64. No push, registry publication, GitHub release or signing.

## Open items

- Core: the stop file's standing, Ctrl+Break handling, and the single pipe instance. The
  client also does not wait for a busy pipe. Each of these changes the binary.
- The pipe name hashes the state folder, so callers cannot derive it. While a project has no
  Host, each Core call lists the pipes and asks up to 64 Core Hosts for their project.
- Each full Core regression leaves about 15 empty directory trees in `%TEMP%`.

Work ran from 2026-11-01 21:13 to 2026-11-02 01:56 (+08:00). Core's part is recorded separately.
