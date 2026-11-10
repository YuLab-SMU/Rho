# Install, start, stop and upgrade Rho

## Requirements

| Needed | Detail |
| --- | --- |
| Node | `>=22.22.0 <27` (the 22, 24 and 26 lines) is the tested range. A Node outside it prints one `EBADENGINE` warning at install time; a Node 22 below 22.22 is untested rather than known to fail. Checked baseline: Node 22.22.3, npm 10.9.8. Rho needs npm as well: a Node without npm usually came with another program (an editor, or an Agent app's own runtime). Do not fetch npm into it, and ask before installing into your own app's runtime, which an update of the app can replace. |
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

If the install succeeded but `rho` is not found, npm's command folder is not on this shell's
`PATH`: it is `$(npm prefix -g)/bin` on macOS and Linux, and the `npm prefix -g` folder itself on
Windows. Use the full path, and tell the person to open a new terminal or restart their Agent
app. Do not install again.

## Start

**To open a folder (0.5.8 and later):** `rho open [FOLDER]` finds the running Rho or starts one in
the background on `~/Rho/state` and `~/Rho/projects`, makes the folder a project where it is,
and opens its page in the browser. `--state-dir`, `--root` and start flags such as
`--agent-backend codex-acp` apply when it has to start Rho; `--no-browser` and `--json` change
what it does at the end. The rest of this section is for starting Rho without opening a folder,
or on a version without `rho open`.

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
foreground of your shell tool dies with that tool call. Add `--background` to the start, on
every system (`rho.cmd` on Windows):

```sh
rho --root ~/Rho/projects --state-dir ~/Rho/state --background
```

It returns once Rho is ready, within a minute, and prints the ready line first, one JSON object:

```json
{"ready":{"url":"http://127.0.0.1:49353","connectionFile":"/…/connection.json","apiVersion":"2.0","openUrl":"…","startup":{"projects":"…","state":"…","core":"…","rscript":"…"}}}
```

Then the process and the log: `<state>/rho.log`, with the previous start's in
`<state>/rho.previous.log`. A start that fails prints Rho's own output and exits 1. In a separate
command, `rho --status --state-dir ~/Rho/state` should say `"running":true` and `"answers":200`;
if not, your client ended what your command started, and the person runs the start without
`--background` in a terminal they keep open. Tell the person the `url`. `startup.rscript` shows
which R it found, and `startup.core` the binary for managed runs. Without a Core, managed runs
are unavailable and everything else works.

Do not write a script to start Rho, and do not change a shell's execution policy. On Windows,
`--background` runs Rho under `cmd.exe` with a console no window shows, and the commands are
`npm.cmd` and `rho.cmd`: plain `npm` and `rho` are PowerShell scripts that the default execution
policy refuses. The [setup page](https://yulab-smu.top/Rho/doc/setup.md#on-windows) has every
Windows step.

A version whose `rho --help` does not list `--background` is started with
`nohup rho … > ~/Rho/rho.log 2>&1 &` on macOS and Linux, and the log is polled for the ready line.

Rho runs until it is stopped, the person logs out or the machine restarts, or the container or
sandbox that holds it ends, and it does not start again by itself.

**Useful flags.** `rho --help` lists the full set for the installed version.

| Flag | Effect |
| --- | --- |
| `--open` | Open the address in the default browser. On a machine with no display it opens nothing and says so |
| `--background` | Return once Rho is ready and leave it running, with its output in `<state>/rho.log` |
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
  The log's last line is then `{"shutdown":…,"by":"rho --stop","at":…}`; `rho --status` reads it.
  A log that ends without that line belongs to a Rho that crashed (its error is in the log) or
  was ended from outside, which no process can record.
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
| `<state>/rho.log`, `<state>/rho.previous.log` | The output of a `--background` start and of the one before it |
