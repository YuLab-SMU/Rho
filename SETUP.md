# Set up Rho

This page is for an Agent. A person asked you to read it and install and configure Rho for
them. If you are reading a summary of this page, get the whole file first:
`curl -fsSL https://yulab-smu.top/Rho/doc/setup.md` (`curl.exe` in Windows PowerShell).

Rho is a local workspace with a browser interface. The person and their Agent work on the same
R and Python projects there: a live Notebook, files, figures and notes. Rho runs on this machine
and drives the Agent client the person already has (Claude Code or Codex). There is no Rho
account and no Rho server. Steps 4 and 5 need a version whose `rho --help` lists `--background`
and `--install-skill`; step 3 installs one.

Do the steps in order; each one says how to check it. Write to the person in the language they
used. Ask the person only where a step says so, and otherwise go on. If you cannot run commands
on this machine, give the person these steps instead. On Windows, read [On Windows](#on-windows)
first.

## Rules

- Use the person's own permissions. Never run `sudo`. When a step needs it, say why and what
  the person can do, then wait.
- Leave alone anything that already exists or runs. Do not stop, restart, overwrite or delete
  it unless the person says so.
- Run each command as it is given. Do not write the steps into a script file, and do not change
  a shell's execution policy or security settings to run them.
- The `connection.json` and `agent-*.json` files in Rho's state folder are credentials. Name
  their paths, but never print or paste their contents.
- Report what you saw. When a step fails, give the command and what it printed, and stop. Tell
  the person which steps are done and which one to continue from: each step checks before it
  changes anything, so running the steps again is safe.

## 1. Check the machine

| Check | Command | What is needed |
| --- | --- | --- |
| System | `uname -s` | `Darwin` (macOS) or `Linux`. Anything else is Windows, such as `MINGW64_NT-…` in Git Bash, and so is a shell with no `uname`: follow [On Windows](#on-windows) |
| Node | `node -v` | Rho is tested on 22.22 or later, below 27. A Node 22 below 22.22 has not been tested: say so in your report and go on (npm prints one `EBADENGINE` warning). Below 22, or 27 and later: tell the person to install Node 22, 24 or 26 (from nodejs.org or a version manager), and stop |
| npm | `npm -v` and `npm prefix -g` | A version, and the folder npm installs into; `node -p process.execPath` says where this Node is. No npm means this Node came with another program, such as your own app's runtime: tell the person Rho needs a Node with npm, from nodejs.org or a version manager, and stop. Do not fetch npm into that program's folder. If `npm prefix -g` is inside your own app's runtime (such as `.cache/codex-runtimes`), ask the person before installing there: an update of the app can remove what is installed in it |
| Python 3 | `python3 -c "import fcntl"` | It prints nothing. Rho's file lock needs it on macOS and Linux. On a Mac where it fails, the person installs the Command Line Tools with `xcode-select --install`; wait for that |
| R | `Rscript --version` | Optional: only R work needs R |
| Your client | `claude --version` or `codex --version` | Which Agent you are. Another client works too; steps 5 and 6 say how |

## 2. Look for a Rho that is already here

```sh
npm ls -g @rho-workspace/rho
rho --status
rho --status --state-dir "$HOME/.rho-service"
```

The first command shows the installed version, if there is one. `rho --status` looks at the
state folder `~/Rho/state`, and the last command at `~/.rho-service`, which earlier instructions
used. Each prints one JSON line: `status.running`, its `url`, `answers` (`200` when the address
answers), a `note` saying how it stands or how it last ended, and `others`, the other Rho
services running on this machine.

- **Nothing installed, or no state folder has run Rho:** go on with step 3.
- **A state folder is running and answers `200`:** Rho is already set up. Use that state folder
  and address from here on, skip to step 5, and do not start another service.
- **A state folder has run Rho but is not running:** ask the person whether to start their
  existing Rho again or set up a new one. For `~/.rho-service`, the projects folder is the one
  they chose earlier (`~/rho-projects` by default); ask them if it is not there.
- **`rho --status` is refused as an unknown option:** that Rho is older. Read a state folder's
  address with `node -p "require('$HOME/Rho/state/connection.json').url"`, and check it with
  `curl -s -o /dev/null -w '%{http_code}' <url>` (`200` running, `000` nothing answering).

The services in `others` belong to other work, so leave them alone.

## 3. Install

```sh
npm install -g @rho-workspace/rho
```

- **`EACCES`:** npm's global folder belongs to root. Do not use `sudo`. Offer the person three
  ways, then wait for their choice:
  - they run `sudo npm install -g @rho-workspace/rho` themselves;
  - npm uses a folder they own: `npm config set prefix ~/.npm-global`, add `~/.npm-global/bin`
    to `PATH` in their shell profile, and install again;
  - a Node version manager such as nvm, fnm or Volta.
- **Very slow or timing out** (common in mainland China): tell the person. With their
  agreement, install again with `--registry=https://registry.npmmirror.com`.

Check: `npm ls -g @rho-workspace/rho` shows the version, and `rho --version` prints it.

- **The install succeeded but `rho` is not found:** the folder npm puts commands in is not on
  this shell's `PATH`. It is `$(npm prefix -g)/bin` on macOS and Linux and the `npm prefix -g`
  folder itself on Windows. Check that `rho` is there, use its full path in place of `rho` in
  the steps below, and tell the person to open a new terminal, or restart their Agent app, so
  that it finds `rho`. A `PATH` changed after a program started does not reach that program or
  the shells it starts. Do not install again: the package is installed.

## 4. Start Rho

```sh
mkdir -p "$HOME/Rho/projects"
rho --root "$HOME/Rho/projects" --state-dir "$HOME/Rho/state" --open --background
```

If you are Codex, Rho's Agent panel should use Codex too:

```sh
rho --root "$HOME/Rho/projects" --state-dir "$HOME/Rho/state" --agent-backend codex-acp --open --background
```

The command returns once Rho is ready, within a minute. Its first line is one JSON object that
starts `{"ready":{"url":"http://127.0.0.1:…`, and the lines after it name the process and the
log, `~/Rho/state/rho.log` (the previous start's is `rho.previous.log` beside it). `--open` opens
the address in the person's browser; where it cannot, such as on a machine with no display, the
log says so.

- **It printed an error instead:** show the person what it printed and stop.
- **Check again in a separate command,** after the start command has returned:
  `rho --status --state-dir "$HOME/Rho/state"` should say `"running":true` and `"answers":200`. If
  it does not, your client ended the processes your command started. Give the person the start
  command without `--background`, to run in a terminal they keep open. Go on when it answers.

The first start copies an example project, `PA14 quorum sensing`, into `~/Rho/projects`.

Rho keeps running until it is stopped, the person logs out or the machine restarts, or the
container or sandbox it runs in ends; it does not start again by itself. On a remote machine or
in a sandbox, `127.0.0.1` is that machine's own address, not the person's: say so, and say that
reaching it from their browser needs a forwarded port.

## 5. Install the Rho skill for yourself

The skill tells you, and your later sessions, how to work with Rho: its tools, the live
Notebook, how to connect, and what to do when something fails. It ships in the package you
installed, matching its version, so nothing is downloaded:

```sh
rho --install-skill "$HOME/.claude/skills/rho"
```

Codex: `rho --install-skill "${CODEX_HOME:-$HOME/.codex}/skills/rho"`.

- **Another client:** use the folder it loads user skills from. If you do not know it, skip this
  step and say so in your report.
- **A `rho` folder is already there:** it is an earlier copy of this skill, and these files
  replace it. If it holds another skill, the command refuses: ask the person first.
- **`--install-skill` is refused as an unknown option:** the installed Rho is older. Run
  `npx -y @rho-workspace/rho@latest --install-skill "<folder>"`, which installs the skill of the
  latest version without changing the installed Rho.

Check: the command prints one JSON line with `"name":"rho"` and the files it wrote. New sessions
load the skill.

## 6. Connect yourself to the example project

Use the state folder from step 2 if Rho was already set up. First check that your client can
read its own configuration: `claude mcp list` or `codex mcp list` lists its MCP servers, or says
there are none, without an error. If it cannot, such as Codex's `failed to resolve CODEX_HOME`,
your shell does not see the configuration folder the person's app uses. Do not set `HOME` or
`CODEX_HOME` for the whole system to work around it: give the person the command below to run
in their own terminal, and go on with step 7.

Claude Code and Codex add Rho to their own configuration with one command:

```sh
rho --grant "$HOME/Rho/state/connection.json" --project "PA14 quorum sensing" --agent claude-code
```

(or `--agent codex`). Its reply is one JSON line, and `added` names the entry it made.

Another client gives itself a stable session name and asks Rho how to connect:

```sh
rho connect "$HOME/Rho/projects/PA14 quorum sensing" --as YOUR_AGENT_NAME
```

The reply names the MCP server to add, its `command` and `args`, ready entries for the clients
Rho has been used with, and how to check the connection. Add it with your own client's mechanism
for a local stdio MCP server, keep unrelated settings, and use private configuration scoped to
this project when available. The reply names the path of your credential file: use it to
configure, and do not paste the reply whole into chats or issues.

Reload your MCP tools if supported, or start a new session in the project folder.
Check that `rho_index` answers and names the correct project scope. A configuration
entry alone is not a successful connection. If the current session cannot reload,
tell the person what was configured and that verification needs a new session.
A client without local stdio MCP support must report that limitation.

## 7. Check R for the Notebook

Skip this step if there is no R: everything except running R works without it. Rho's live R
session needs the package `jsonlite`:

```sh
Rscript -e 'cat(requireNamespace("jsonlite", quietly = TRUE), "\n")'
```

If it prints `FALSE`, install it with
`Rscript -e 'install.packages("jsonlite", repos = "https://cloud.r-project.org")'`.

The example project's scripts also use ggplot2, dplyr, tidyr, patchwork, scales, car and
Bioconductor's DESeq2. Say which are missing, and install them only when the person asks:

```sh
Rscript -e 'p <- c("ggplot2", "dplyr", "tidyr", "patchwork", "scales", "car", "DESeq2"); cat("missing:", p[!vapply(p, requireNamespace, logical(1), quietly = TRUE)], "\n")'
```

## 8. Tell the person

Keep it brief, in their language:

1. **Rho is a page in their web browser,** not this chat or a terminal: the address
   `http://127.0.0.1:…`. Opening it in a browser on this machine is all the access needed: no
   account, link or code.
2. **Where things are:** projects in `~/Rho/projects`, service state in `~/Rho/state`, the log
   at `~/Rho/state/rho.log`, and the version installed.
3. **What is done and what is missing,** step by step, and what works without what is missing.
4. **How to start working**, in either place:
   - in the browser: open `PA14 quorum sensing` and ask in Rho's Agent panel;
   - in a new session of this client started in `~/Rho/projects/PA14 quorum sensing`, where
     Rho's tools and the skill are available.

   Read the example's `README.md` and suggest three questions they could ask about it.
5. **How to open their own folders:** `rho open <folder>`, or asking an Agent to open the folder
   with Rho. The folder stays where it is and opens as a project in their browser.
6. **How to check, stop and start Rho:** `rho --status` says whether it runs and how it last
   ended. `rho --stop --state-dir "$HOME/Rho/state"` stops it in order and prints
   `{"stopped":…}` once it has ended. Start it again with the command from step 4.

## On Windows

The steps above apply, typed as below, in PowerShell or in Git Bash. They need no script file,
no change to the execution policy and no hidden window: run each command as it is. Earlier
versions of this page had Agents write PowerShell files that bypassed the execution policy,
downloaded the skill and started Rho hidden, and security software such as Huorong flagged them
as a downloader.

- Call `npm.cmd`, `npx.cmd` and `rho.cmd` rather than `npm`, `npx` and `rho`. In PowerShell
  those are scripts, which Windows' default execution policy refuses to run. In Git Bash, `npm`
  fails when `C:\Windows\System32` comes first in `PATH`, because the `bash` there is WSL's.
- Write paths as `"$HOME\Rho\state"` in PowerShell and `"$HOME/Rho/state"` in Git Bash. In
  Windows PowerShell 5.1, `curl` is another command: use `curl.exe`.
- Python is not needed.

1. **Check the machine** as in step 1, with `npm.cmd -v` and `npm.cmd prefix -g`. Commands go
   in the `npm prefix -g` folder itself.
2. **Look for a Rho that is already here** with `npm.cmd ls -g @rho-workspace/rho`,
   `rho.cmd --status` and `rho.cmd --status --state-dir "$HOME\.rho-service"`, and go on as
   step 2 says.
3. **Install** with `npm.cmd install -g @rho-workspace/rho`, and check with
   `rho.cmd --version`. A `PATH` the person changed reaches your shells only after your app
   restarts; until then use the full path, `<npm prefix -g>\rho.cmd`.
4. **Start Rho:**

   ```powershell
   New-Item -ItemType Directory -Force "$HOME\Rho\projects" | Out-Null
   rho.cmd --root "$HOME\Rho\projects" --state-dir "$HOME\Rho\state" --open --background
   ```

   If you are Codex:
   `rho.cmd --root "$HOME\Rho\projects" --state-dir "$HOME\Rho\state" --agent-backend codex-acp --open --background`.
   In Git Bash, make the folder with `mkdir -p "$HOME/Rho/projects"`. Then check with
   `rho.cmd --status --state-dir "$HOME\Rho\state"` in a separate command, as step 4 says.
5. **Install the skill** with `rho.cmd --install-skill "$HOME\.claude\skills\rho"`. Codex:
   `"$env:USERPROFILE\.codex\skills\rho"` in PowerShell, or `$env:CODEX_HOME\skills\rho` when
   `CODEX_HOME` is set.
6. **Connect yourself** as in step 6, with
   `rho.cmd --grant "$HOME\Rho\state\connection.json" --project "PA14 quorum sensing" --agent codex`
   (or `--agent claude-code`), or `rho.cmd connect "$HOME\Rho\projects\PA14 quorum sensing" --as YOUR_AGENT_NAME`.
7. **Check R** as in step 7. Windows PowerShell 5.1 drops the double quotes inside an argument it
   passes to a program, so these use single quotes in R:

   ```powershell
   Rscript -e "cat(requireNamespace('jsonlite', quietly = TRUE), '\n')"
   Rscript -e "p <- c('ggplot2', 'dplyr', 'tidyr', 'patchwork', 'scales', 'car', 'DESeq2'); cat('missing:', p[!vapply(p, requireNamespace, logical(1), quietly = TRUE)], '\n')"
   ```

   Install `jsonlite` with `Rscript -e "install.packages('jsonlite', repos = 'https://cloud.r-project.org')"`.
   A first line `Setting LC_CTYPE=C.UTF-8 failed` is R reading Git Bash's locale; the checks
   still hold, and Rho keeps that locale from its own R.
8. **Tell the person** as in step 8; the log is `~\Rho\state\rho.log`. Stop Rho with
   `rho.cmd --stop --state-dir "$HOME\Rho\state"`: it stops in order and prints `{"stopped":…}`
   once Rho has ended, and a managed Host it started stops with it.
