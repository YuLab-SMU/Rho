# Windows setup from an Agent's shell

Updated 2026-11-07. The user's Agent installed Rho on Windows twice and reported what it met:
[#112](https://github.com/YuLab-SMU/Rho/issues/112) (0.5.2 from source, 2026-11-02) and
[#113](https://github.com/YuLab-SMU/Rho/issues/113) (0.5.4 from npm, following the setup page's
Windows section, 2026-11-05). The user asked for both to be checked and resolved. This episode
checks every item against `cd559cc0`, runs the Windows steps from an Agent's shell, and fixes what
they exposed in Rho, the Plugins and Core.

## Setup

- Windows 11 x64 (10.0.26200), Node 24.15.0, npm 11.12.1, Windows PowerShell 5.1.26100, R 4.5.1
  and Chrome. Python is on `PATH` only as the Microsoft Store's aliases; Miniconda's 3.13.9 ran the
  Plugins suite.
- The Agent is ZCode. Its shell is Git Bash with `C:\Windows\System32` ahead of `/usr/bin` in
  `PATH`, and with `LANG` and `LC_CTYPE` set to `C.UTF-8`.
- A throwaway home (`USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`) and npm prefix (`NPM_CONFIG_PREFIX`)
  under `work/windows-setup/`. Each PowerShell block was written to a `.ps1` file and run with
  `powershell -NoProfile -ExecutionPolicy Bypass -File`, as the page now says to do from Git Bash.
- The person's own Rho 0.5.4 ran on `~/Rho/state` throughout and was left alone.

## The reports on current main

| Item | On `cd559cc0` | Now |
| --- | --- | --- |
| #113.1 `uname -s` in Git Bash | `MINGW64_NT-10.0-26200`, which step 1 did not name | Step 1 calls anything but `Darwin` or `Linux` Windows, and names it |
| #113.2 No look for an existing Rho | As reported | A PowerShell check of both state folders, and a listing of running services |
| #113.3 No log, ready line or `200` | As reported | A background start with a log, the ready line and `200` |
| #113.4 Stop only by Ctrl+Break | As reported; below, `Stop-Process` left a Host and no report | `rho --stop` |
| #113.5 Codex's `--agent-backend codex-acp` | Missing | Named in step 4 |
| #113.6 PowerShell and Git Bash | `npm` failed in this shell: its `bash` was WSL's | `npm.cmd`, `rho.cmd`, and `.ps1` files from Git Bash |
| #113.7 "not yet run end to end on Windows" | Still there | Replaced with what was run |
| #112.1 Install docs say unpublished | Already fixed: README and HEADLESS install from npm | — |
| #112.2 RELEASE names `rho-workspace-local-0.5.2.tgz` | Still there | The packer's current name, with the old one explained |
| #112.3 Node 22 only | Already fixed: `>=22.22.0 <27`; 0.5.5 ran on Node 24.15.0 here | — |
| #112.4 Files the Agent used shown `missing` | Already fixed in `5f0a701e`; no path in the example keeps the folder's name | — |
| #112.5 The Overview's timeline past its card | Reproduced | Fixed |
| #112.6 "R 4.5.2 on this machine" | Reproduced | Notebook 0.5.6 |
| #112.7a Core's build only in `ci.yml` | As reported | HEADLESS gives it |
| #112.7b A CRLF checkout changes Core | Reproduced with a build | Core `8ef933a` |
| #112.7c Plugins' `npm ci` took 14.5 minutes | Not rerun | HEADLESS says why |
| #112.7d A local Core is not CI's and names the builder | Reproduced: 78 paths | HEADLESS says so; not changed |
| #112.8 `npm` in Git Bash | Reproduced | As #113.6 |

## Baseline: 0.5.5 from npm

`npm install -g @rho-workspace/rho` into the throwaway prefix took 188 s.

**A background start that holds the Agent's command.** `Start-Process rho.cmd -WindowStyle Hidden
-RedirectStandardOutput … -RedirectStandardError …` started Rho, and its ready line was in the log
within 2 s. The Agent's command returned only 4 min 25 s later, when Rho was stopped: PowerShell
starts a redirected program with handle inheritance, so Rho's `cmd.exe` and `node` held the
Agent's output pipe. `Start-Process cmd.exe` without PowerShell's redirection, with `cmd` writing
`> rho.log 2>&1`, returned in 1.7 s. Rho kept running after the command ended and answered `200`.

**An old log read as this start's.** With the previous run's log in place, the wait for the ready
line passed at once ("waited 0 s"): `Start-Process` returns before `cmd` truncates the file.

**`Stop-Process`, the only stop an Agent had.** With a Notebook R session and a managed Core Host
running, `Stop-Process` on Rho's `node` ended `node`, its `cmd.exe` and the R session (Node's job),
but not the Host, and the log had no `{"shutdown":…}` line. Touching the project's
`.rho/host.stop` stopped the Host.

**Commands that PowerShell changes.** `npm` and `rho` in PowerShell are `npm.ps1` and `rho.ps1`;
with the `Restricted` execution policy, Windows' default, `npm -v` was refused. Windows PowerShell
5.1 dropped the inner double quotes of step 7's R check, and R stopped with `unexpected symbol`;
the same checks with single quotes inside R printed `TRUE` and `missing: DESeq2`. The skill's
eight files downloaded with `Invoke-WebRequest`, with and without `-UseBasicParsing`.

**A locale Windows does not have.** Found while running the Plugins suite from this shell: R on
Windows takes `LC_ALL`, `LC_CTYPE`, `LC_COLLATE`, `LC_TIME` and `LC_MONETARY` from the
environment, and Windows has no `C.UTF-8`. Given this shell's `LC_CTYPE`, R warned at startup,
ran in the C locale and printed `3 × 2 中文` as `3 <U+00D7> 2 <U+4E2D><U+6587>`. 0.5.5 started from
this shell refused a Notebook cell whose code held that text: its runner could not read its own
request (`lexical error: invalid character inside string`). A managed run printed the escapes,
and the kernel tests left an R session that kept their file from exiting. `LANG=C.UTF-8`,
`LANG=zh_CN.UTF-8` and `LC_CTYPE=en_US.UTF-8` were fine.

## Changes

**`rho --stop [--state-dir DIR]`** (Rho). The launcher looks for `service.stop` in its state
folder every half second and, when it finds one, removes it and stops as on Ctrl+C. `--stop`
leaves the file only while the state's writer lock is held, then waits until the lock is free and
the process `connection.json` now names has ended, and prints `{"stopped":{"state":…}}`. The
first version printed that once the lock was free, while the launcher was still writing its last
line, and removing the log failed with "Device or resource busy"; with the wait for the process,
the log was removed at once. A start removes a request no service took. Against 0.5.5, which
never takes it, `--stop` said so after 10 s and removed its request. `launcher-stop.test.mjs`
covers a request left before a start, the stop with a Host when Core is selected, and both
refusals.

**The setup page and skill** (Rho). Step 1 names Git Bash's `uname`. The Windows section mirrors
steps 1 to 8: the existing-Rho check, `npm.cmd`, the background start through `cmd.exe` with the
old log removed and `LC_ALL` and `LC_CTYPE` left out, `200` in a separate command, Codex's
backend, the skill with a line per failed file, the R checks with single quotes, and
`rho.cmd --stop`, with what `Stop-Process` leaves for a version without it. Step 8 elsewhere gives
`rho --stop` before `pkill`.

**The Overview's timeline** (Rho, `web/graph.tsx`). Each pause between stretches of work took a
fixed 44 px. A fresh copy of the example has 21 stretches, so 880 px of pauses in a 329 px track:
the plot was drawn 980 px wide, the main area scrolled from 979 to 1,233 px, and labels piled up.
Pauses now take at most half the track, a pause is labelled only when it has room, and a tick
label nearer the one before it than 60 px, or one that would start past the end, is left out. The
Graph page's timeline, which had the same arithmetic, shows no pause labels for this project now.

**"On this machine"** (Plugins `dd7ac26`, Notebook 0.5.6). The Overview said it of every session
whose place was not a server. An ended session may come with a copied project, as the example's
do, so only a live one says it now; the Notebook view never did.

**Locales** (Plugins `edf7dfa`, Rho `src/bridge.ts`). A local Notebook session and a Core Host on
Windows now start without those five categories' POSIX UTF-8 values, so R takes the system's
own locale, UTF-8 there. A Windows test in each owner fails without the change.

**Core's compiled-in documents** (Core `8ef933a`,
[CORE-20261107-01](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/work/CORE-20261107-01.md)).
A fresh clone under Git for Windows' default `core.autocrlf=true` checked `docs/ACTIVITY.md` and
`docs/MANAGED-RUN.md` out with 344 CR bytes, and a Core built from it embedded them with CRLF
where CI's has LF. Those two files are now `text eol=lf`; a fresh clone builds them in with LF.
The packer now records them among Core's build inputs. Rho still selects Core `8bed8ef`, so
HEADLESS says to clone with `core.autocrlf false`, as CI does.

**Building from source** (HEADLESS, RELEASE). HEADLESS gives CI's Core build, the Windows Core
in the packer's example, what a local Core embeds (78 paths under the builder's user folder; CI's
Core names `runneradmin` as often), `--core-composition` for reusing the accepted Cores, and the
Agent adapters' optional clients behind #112's 14.5-minute `npm ci`. RELEASE names the tarball
the packer writes now.

## The rerun

The candidate was packed from Plugins `edf7dfa` and an earlier, unpublished state of these Rho
commits (application commit `8e39ef1f`, on `cd559cc0`), reusing the published 0.5.5's `win32-x64`
Core through `--core-composition`: 125 s, and `rho-workspace-rho-0.5.6.tgz` of 19,270,055 bytes and
3,163 files. Since then one comment in `web/graph.tsx` was corrected, and the commits were placed
after three that arrived upstream meanwhile (conversation names and records). The tarball took the
registry's place in step 3, installed with `npm.cmd install -g` into a new throwaway prefix and home.
The PowerShell blocks were taken from `SETUP.md` as written, and step 4 was run again after its
locale line was added; the published page's blocks are those, byte for byte.

| Step | Result |
| --- | --- |
| 1 | `uname -s` printed `MINGW64_NT-10.0-26200`: Windows |
| 2 | Nothing installed and no state folder; the listing showed only the person's 0.5.4 |
| 3 | 23 s; `npm.cmd ls -g` named the version and `rho.cmd --help` listed `--stop` |
| 4 | The command returned in 2.7 s with the ready line; a separate check printed `200`; step 2 then reported the state answering `200` |
| 5 | Eight files, `name: rho` |
| 6 | One JSON line; its stdio MCP server listed the four tools, and `rho_index` named the granted project |
| 7 | `TRUE` and `missing: DESeq2`, each after R's warning about this shell's `LC_CTYPE`, which the page now explains |
| Notebook | A cell printing `3 × 2 中文` printed it, on the candidate and on 0.5.5 started by the final step 4 |
| 8 | `rho.cmd --stop` in 1.6 s with a live Notebook session; nothing left running; the log ended with `{"shutdown":[]}`; a start at once returned in 1.9 s and answered `200`; the next stop took 0.7 s |

In Chrome at 1280 × 720 the candidate's Overview no longer scrolls sideways (979 of 979 px), and
its Notebook section reads "R 4.5.1 on this machine" for the live session and "R 4.5.2" for the
example's ended ones. The timeline was also measured at 1024, 1440 and 390 px, and the Graph
page's at 1440, each without anything outside its card.

## Checks

| Suite | Windows result |
| --- | --- |
| Rho `npm test`, Core selected | 304 of 319, 15 skipped, none failed |
| `launcher-stop.test.mjs`, `windows-locale.test.mjs` | Pass with and without a Core; the locale test fails without its change |
| Plugins `npm test`, Miniconda's Python first on `PATH` | 180 of 190, 8 skipped, 2 failed, both from before this work: the interpreter test names `.venv/bin/nothing`, which on Windows is refused as outside the project because `bin` does not exist, and the presentation test expects `agent.sessions.list` to have no title, which Plugins `434d9a3` gave it |
| Plugins kernel locale test | Fails without the change |

Before the locale change, the Plugins suite run from this shell stopped making progress in
`kernel.test.mjs` until it was ended; without Python on `PATH` ten kernel tests failed with exit
9009.

## Not done

- The `--stop`, timeline, Notebook and locale changes reach people with the next npm release.
- The setup page and skill on the site are the earlier ones until they are deployed.
- `--open` was given; whether a tab opened was not seen from the Agent's side.
- Codex is not installed here; Claude Code and Codex did not hold a conversation in this Rho.
- Agents whose tools end the processes they start were not tried; the page's fallback is a
  window the person keeps open.
- Windows on arm64, PowerShell 7, the two Plugins test failures above, and `--remap-path-prefix`
  for local Cores, which would change every platform's Core.

Work ran from 18:13 to 20:00 (+08:00) on 2026-11-07, before the commits were published.
