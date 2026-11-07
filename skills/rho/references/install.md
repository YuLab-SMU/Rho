# Install, start, stop and upgrade Rho

## Requirements

| Needed | Detail |
| --- | --- |
| Node | `>=22.22.0 <27` (the 22, 24 and 26 lines). A Node outside the range prints one `EBADENGINE` warning at install time. Checked baseline: Node 22.22.3, npm 10.9.8. |
| Agent client | Claude Code or Codex, installed and signed in by the person. Rho drives it under the person's own settings and does not copy credentials between them. |
| R | Only for R work. The Notebook's R session needs the `jsonlite` package. Without `Rscript`, the service, documents, files and saved results still work. Rho never installs project packages by itself. |
| Python 3 | macOS and Linux use it for the file writer lock. Windows does not need it. The Notebook's Python session uses it too. |
| Platform | macOS arm64 is the checked baseline. Windows x64, Linux x64 and Linux arm64 have platform builds. On macOS x64, Rho runs only under Rosetta. |

## Install

```sh
npm install -g @rho-workspace/rho
npm ls -g @rho-workspace/rho     # the installed version
```

If the global prefix belongs to root, the install fails with `EACCES`. Do not run `sudo`
yourself. Explain the options to the person and let them choose:

- install into a folder they own: `npm install --prefix ~/.rho-app @rho-workspace/rho`, then
  run `~/.rho-app/node_modules/.bin/rho`;
- point npm at a user prefix (`npm config set prefix ~/.npm-global` plus a PATH entry), or use
  a Node version manager;
- run the global install with `sudo` themselves.

## Start

First check that no service is already running for the state folder you plan to use (see
SKILL.md). If one is, give the person its address instead of starting another.

**With no flags (versions after 0.5.3 only):**

```sh
rho                       # or: npx @rho-workspace/rho
```

This uses `~/Rho/projects` and `~/Rho/state`, creates both, and prints the address to open,
the two folders, and whether the Agent client and R were found. In 0.5.3 and earlier, a start
with no flags prints the usage and exits 2, so use the flagged form there.

**With flags (every version), in a terminal the person keeps open:**

```sh
mkdir -p ~/Rho/projects ~/Rho/state
rho --root ~/Rho/projects --state-dir ~/Rho/state --open
```

These are the folders a start without flags uses after 0.5.3, so an upgrade finds the same
state. Earlier instructions on Rho's site used `~/rho-projects` and `~/.rho-service`: when
those exist, keep using them.

Keep `--state-dir` outside `--root`, so each project stays an ordinary folder.

**From your own shell tool, keep it running after the call ends.** A service started in the
foreground of your shell tool dies with that tool call, and a plain `&` may be lost too. On
macOS and Linux, use:

```sh
nohup rho --root ~/Rho/projects --state-dir ~/Rho/state > ~/Rho/rho.log 2>&1 &
```

Then wait for the first line of the log, which is one JSON object:

```json
{"ready":{"url":"http://127.0.0.1:49353","connectionFile":"/…/connection.json","apiVersion":"2.0","openUrl":"…","startup":{"projects":"…","state":"…","core":"…","rscript":"…"}}}
```

Poll the log for a few seconds. Do not assume the service is up because the command returned.
Tell the person the `url`. `startup.rscript` shows which R it found, and `startup.core` the
binary for managed runs. Without a Core, managed runs are unavailable and everything else works.

On Windows, use PowerShell with `npm.cmd` and `rho.cmd` (plain `npm` and `rho` are PowerShell
scripts that the default execution policy refuses), and let `cmd.exe` write the log. Started with
`Start-Process -RedirectStandardOutput` instead, Rho holds your shell's output open and your
command does not return:

```powershell
$log = "$HOME\Rho\rho.log"; Remove-Item $log -ErrorAction SilentlyContinue
$rho = (Get-Command rho.cmd).Source
$line = "`"$rho`" --root `"$HOME\Rho\projects`" --state-dir `"$HOME\Rho\state`" > `"$log`" 2>&1"
Start-Process cmd.exe -ArgumentList "/d /s /c `"$line`"" -WindowStyle Hidden
```

Then wait for the ready line in the log as above. The
[setup page](https://yulab-smu.top/Rho/doc/setup.md#on-windows) has every Windows step.

**Useful flags.** `rho --help` lists the full set for the installed version.

| Flag | Effect |
| --- | --- |
| `--open` | Open the address in the default browser |
| `--example off` | Do not copy the example project (a new state otherwise copies "PA14 quorum sensing" into the projects folder once) |
| `--agent-backend codex-acp` | Codex in the Agent panel (default: Claude Code via `claude-acp`) |
| `--claude PATH`, `--codex PATH` | Choose the Agent client binary (or `RHO_CLAUDE`, `RHO_CODEX`) |
| `--rscript PATH`, `--python PATH` | Choose R and Python for the Notebook (or `RHO_RSCRIPT`, `RHO_PYTHON`) |
| `--port N` | Fixed port. In 0.5.3, each start without it takes a new port. After 0.5.3, a start without it reuses the last port, and `--port 0` asks for a new one |
| `--limits FILE` | JSON budgets, such as a step cap for Agent turns (none by default since 0.5.3) |

Opening the address in a browser on this machine is the access. No link, code or login is
needed. `rho --pair <state>/connection.json` makes a one-time, five-minute link when a tab
must be limited to one folder.

## Stop

Stop only a service you started, or one the person asks you to stop. Stopping ends the live R
and Python sessions; their in-memory values are lost.

- From anywhere, when `rho --help` lists `--stop`: `rho --stop --state-dir "$HOME/Rho/state"` (no
  `--state-dir` means `~/Rho/state`; `rho.cmd` on Windows). It stops the service in order, as
  Ctrl+C does, and prints `{"stopped":…}` once it has ended. It says so when nothing runs there.
- In its own terminal: Ctrl+C (Ctrl+Break on Windows).
- Started in the background by a version without `--stop`, on Windows: `Stop-Process -Id <pid>`
  ends it at once, without the `{"shutdown":…}` line; a managed Host it started keeps running.
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*--state-dir*'`
  lists the candidates.
- Started in the background by a version without `--stop`, on macOS and Linux: find the one
  process that serves that state folder, check it, then send it SIGTERM. Write the path as it
  was given at start, with `~` expanded:

  ```sh
  pgrep -fl "[-]-state-dir $HOME/Rho/state"     # should list exactly one process
  pkill -TERM -f "[-]-state-dir $HOME/Rho/state"
  ```

  The `[-]` keeps the pattern from matching the shell that runs the command. A start with no
  flags has no `--state-dir` on its command line. Find that one by the port in its url instead:
  `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`, then `kill -TERM <pid>`.
- The log then ends with a `{"shutdown":…}` line. A service stops only the managed Hosts it
  started.

## Upgrade

```sh
npm install -g @rho-workspace/rho@latest
```

Then stop and start the service with the same `--root` and `--state-dir`, after the person
agrees (see Stop). Projects, conversations, notes and kept versions stay in their folders. On
0.5.3 and earlier, a restart can change the port, so connected Agents need a new grant (see
[connect](connect.md#after-a-restart)).

## Where things live

| Path | Holds |
| --- | --- |
| `<root>/<project>/` | The project: ordinary files the person and Agents edit |
| `<root>/<project>/project-notes.md` | Shared notes, one section per session Rho started |
| `<root>/<project>/.claude/skills/<name>/SKILL.md` | The project's own skills (how work is done here) |
| `<root>/<project>/.rho/` | Plugin state for the project, such as Notebook cells and plots in `.rho/plugins/kernel/`. Do not edit it by hand |
| `<state>/` | Service state and credentials (`connection.json`, `agent-*.json`). Never inside a project |
