# Setup reports: Windows with Codex Desktop, a Linux sandbox and a security warning

Updated 2026-11-09. Three reports about the setup page arrived on 2026-11-08 and 2026-11-09:
[#114](https://github.com/YuLab-SMU/Rho/issues/114), a first install by Codex Desktop on Windows
11 that stopped after `npm install`; [#115](https://github.com/YuLab-SMU/Rho/issues/115), an
install by another client in a Linux sandbox whose service had gone 12 hours later; and the
user's report that Huorong (火绒) frequently flags a `Start-Rho.ps1` as
`HEUR:TrojanDownloader/PS.NetLoader.ae`. The user asked how to resolve them. This episode traces
each item to its owner, changes Rho, and follows the page again.

## The security warning

The name is Huorong's heuristic class for a PowerShell network loader, not a signature match. The
page caused it. From Git Bash it told an Agent to write each PowerShell block to a `.ps1` file and
run it with `powershell -NoProfile -ExecutionPolicy Bypass -File`; one block downloaded the
Skill's eight files with `Invoke-WebRequest`, another removed a log, started `cmd.exe` with
`Start-Process -WindowStyle Hidden` and polled the log. A script that bypasses the execution
policy, fetches files and starts a hidden process is what a PowerShell downloader looks like. Each
Agent wrote its own file, so every user's had different bytes and a different hash, and no
reputation or allow-list could form: hence frequent rather than occasional.

A signature or allow-list would not fix that. The page now has no script: Rho itself does what
the script did, and an Agent runs plain `npm.cmd` and `rho.cmd` commands.

| The script did | Now |
| --- | --- |
| `-ExecutionPolicy Bypass -File` on a written `.ps1` | Nothing to write; the page says not to write the steps into a file or change an execution policy |
| `Invoke-WebRequest` of eight Skill files | `rho --install-skill DIR` copies the Skill from the installed package |
| `Start-Process cmd.exe -WindowStyle Hidden`, the log removed first, a polling loop | `rho … --background` |
| A loop reading `connection.json` and requesting the address | `rho --status` |

This has not been tried against Huorong: there is no Windows machine or Huorong here.

## The two issues, item by item

| Report | Cause | Change |
| --- | --- | --- |
| #114.1 `node -v` passed, then `npm` was missing | Codex Desktop's own Node, with no npm; step 1 checked only `node -v` | Step 1 checks `npm -v` and `npm prefix -g`. No npm: say Rho needs Node with npm, and stop; never fetch npm into another program's folder. A prefix inside your own app's runtime (`.cache/codex-runtimes`): ask first |
| #114.2 the Agent assumed `%APPDATA%\npm`, cleaned up and reinstalled; `PATH` changes did not reach its shells | The page gave no way to find the command folder; a changed `PATH` reaches only programs started later | Step 3 names the folder (`$(npm prefix -g)/bin`, or `npm prefix -g` on Windows), says to use the full path and tell the person to restart their app, and not to install again |
| #114.3 the Windows start had no `--agent-backend codex-acp` | Since #113 it was named only in prose after the block | Steps 4 and Windows 4 give Claude Code's and Codex's commands in full; step 6 gives `--agent` |
| #114.4 `codex mcp list`: `failed to resolve CODEX_HOME` | Codex's CLI in the app's shell could not find its home folder; not Rho's | Step 6 first checks that the client reads its own configuration; when it cannot, the Agent does not set `HOME` or `CODEX_HOME` system-wide but gives the person the command for their own terminal. Not reproduced: no Codex Desktop on Windows here |
| #114.5 a reading tool refused `text/markdown` | GitHub Pages serves `setup.md` as Markdown | Not changed. The page's first lines give `curl.exe` for Windows PowerShell |
| #114.6 run the whole path on Windows | — | CI's installed check now runs the page's commands through `rho.cmd` in a folder whose name has spaces and Chinese; Codex Desktop is not run |
| #115 P1-1 47 minutes waiting on Node 22.13.1 | Step 1 stopped on anything below 22.22. That floor is the tested baseline (Node 22.22.3 on the development Mac), not an API Rho needs: the suite also passed on 18.20.8 ([example project](EXAMPLE-PROJECT-EPISODE.md)) | A Node 22 below 22.22 is reported as untested and the Agent goes on; below 22 or from 27 it still stops. `engines` is unchanged |
| #115 P1-2 service gone after 12 h, the log only its ready line | A service ended from outside (killed, out of memory, its session or sandbox gone) writes nothing; a stop in order writes `{"shutdown":…}`, a crash its error | `rho --status`; the shutdown line names `by` and `at`; a start keeps the last log; the page says what ends a background Rho and that a remote `127.0.0.1` is not the person's |
| #115 P2-3 the other-client branch left `.mcp.json` fields to guesswork | `--grant --session` printed bare JSON | Step 6 sends other clients to `rho connect`, whose reply names the server, its command and arguments, ready entries for four clients, and the `rho_index` check. No generic `mcpServers` entry: no such client was checked |
| #115 P2-4 `--open` in a sandbox said nothing | `xdg-open` with no display failed silently | On Linux with no `DISPLAY`, `WAYLAND_DISPLAY` or WSL, `--open` opens nothing and says so; an opener that exits non-zero is reported |
| #115 P2-5 the grant reply shows the credential's path | It does, by design: it is the configuration | The page and Skill say to configure from it and report the project and server name instead of pasting it |
| #115 P2-6 the Skill's integrity | Fetched file by file from the site, unrelated to the installed version | The Skill ships in the package (`skills/rho`), so npm's integrity check and the package's provenance cover it and it matches the installed version. No separate checksum list |

## Changes

**Rho** (`src/background.ts`, `src/cli.ts`, `src/connect-cli.ts`):

- `--background` added to a start runs the same start detached with its output in
  `<state>/rho.log`, renames the last log to `rho.previous.log`, and returns once the ready line
  appears, printing it first, then the process, the log and how to check and stop it. A start
  that ends first prints its output and exit code; a state already running is refused before
  anything starts. On macOS and Linux the service gets its own session. On Windows it runs under
  `cmd.exe /d /s /c "… > log 2>&1"`, started with no window and no inherited handles: `cmd` gets a
  console that shows no window, which the service and the console programs it starts share, and
  the service is outside the job that ends `cmd` when the command returns. Arguments containing
  `"` or `%` are refused there.
- `--status [--state-dir]`: running or not, address, process, whether the address answers, the
  log, a note on how the last service ended, and the other services announced on this machine.
- `--install-skill DIR` copies `skills/rho` from the package, refusing a folder that holds
  another skill; `--version`.
- The `{"shutdown":…}` line adds `by` (`rho --stop`, `SIGTERM`, `SIGINT`, `SIGBREAK`) and `at`.
- `--open` reports a missing display and a failed opener.
- `rho connect` treated one state folder named through a link as two services and refused
  ("More than one running Rho…"). Found below; it now compares real paths.

**Pages:** [SETUP.md](../SETUP.md) uses these commands and has no script on any system; the Skill's
install, troubleshooting and connect references follow it; the site build no longer requires the
page to list the Skill's files; [Headless](HEADLESS.md) and the documentation's start page
describe the commands.

**Checks:** `launcher-background.test.mjs` starts, checks, refuses a second start, stops,
restarts, kills from outside and fails a start, with `--open` on a Linux runner with no display;
it also installs the Skill over an earlier copy and next to another skill. A command that held its
caller's output open would time out there. The connect test names one state through a link and
fails without the change. CI's installed check runs `--version`, `--install-skill`,
`--background`, `--status` and `--stop` through the installed `rho` and `rho.cmd`. The packer
requires `skills/rho/SKILL.md`.

## The run

macOS arm64, Node 22.22.3 and npm 10.9.8, Claude Code 2.1.319, R 4.5.2, in a throwaway home with
`rho` pointing at this checkout's build (the commands are not on npm yet), following the page as
written except `--open`, so no tab opened on the user's screen.

| Step | Result |
| --- | --- |
| 1 | `npm prefix -g` and `node -p process.execPath` were under `~/.hermes/node`: this Mac's Node and npm came with another program. The first wording stopped on any folder inside another program, so it would have stopped here, as #115 did; it now stops only without npm and asks only for the Agent app's own runtime |
| 2 | Both `rho --status` lines: "No Rho has run with this state folder." |
| 4 | Returned in 0.8 s with the ready line; `--status` in a separate command: running, `200`; the example was copied |
| 5 | `{"skill":{"name":"rho",…}}` with eight files |
| 6 | `claude mcp list` answered; `--grant --agent claude-code` added `rho-pa14-quorum-sensing` for the folder; `claude mcp list` there: ✔ Connected. A new `claude -p` session in the folder (model `westlakehpc/glm-5.3-flash`, only `rho_index` allowed) called it and answered the granted project id in 28.6 s. `rho connect … --as trial-agent` refused: "More than one running Rho" named the state as `/private/tmp/…` and `/tmp/…`. Fixed, it printed the steps |
| 7 | `TRUE`; `missing: car DESeq2` |
| 8 | `rho --stop` printed `{"stopped":…}`; `--status`: "Not running. It stopped in order on rho --stop at 2026-11-09T15:30:56.541Z." |

Before that, by hand: a failed start (no projects folder) printed Rho's `ENOENT` and exited 1 in
0.5 s; a second start was refused with the address; after `kill -9` the status note said the log
ends without a shutdown line; a restart kept the stop's log as `rho.previous.log`.

The suite on macOS: 340 of 343, 3 skipped (Windows only), after one test that required the page
to list the Skill's files was changed to require the package to ship them.
[CI run 42646616217](https://github.com/YuLab-SMU/Rho/actions/runs/42646616217) on `511309a6`
passed every job once its macOS Core build, cancelled before it started, was run again: the
suite on macOS, Linux and Windows, and the installed check, with `--version`, `--install-skill`,
`--background`, `--status` and `--stop` through the installed `rho` and `rho.cmd`, on macOS arm64,
Linux arm64, Linux x64 with Node 22, 24 and 26, and Windows x64.

## Not done

- No Windows machine, Huorong or Codex Desktop here. Whether Huorong stops flagging, and whether
  Codex Desktop's sandbox lets a background Rho outlive the command, are unobserved.
- The page goes to the site with the next npm release: its steps 4 and 5 need commands that 0.5.7
  lacks. The front page's terminal fragment is the 0.5.3 run of the old steps and is recorded
  again then.
- `setup.md` is still served as `text/markdown`.
- The Linux sandbox's 12-hour end is not reproduced; `--status` can only say that the log has no
  shutdown line. Rho gives no service-manager unit for keeping it running across restarts.
- No pre-install diagnosis command: Rho cannot run before npm has installed it, so those checks
  stay in step 1.
