# Set up Rho

This page is for an Agent. A person asked you to read it and install and configure Rho for
them. If you are reading a summary of this page, get the whole file first:
`curl -fsSL https://yulab-smu.top/Rho/doc/setup.md`.

Rho is a local workspace with a browser interface. The person and their Agent work on the same
R and Python projects there: a live Notebook, files, figures and notes. Rho runs on this machine
and drives the Agent client the person already has (Claude Code or Codex). There is no Rho
account and no Rho server. These steps fit `@rho-workspace/rho` 0.5.3 and later.

Do the steps in order; each one says how to check it. Write to the person in the language they
used. Ask the person only where a step says so, and otherwise go on. If you cannot run commands
on this machine, give the person these steps instead.

## Rules

- Use the person's own permissions. Never run `sudo`. When a step needs it, say why and what
  the person can do, then wait.
- Leave alone anything that already exists or runs. Do not stop, restart, overwrite or delete
  it unless the person says so.
- The `connection.json` and `agent-*.json` files in Rho's state folder are credentials. Name
  their paths, but never print or paste their contents.
- Report what you saw. When a step fails, give the command and what it printed, and stop.

## 1. Check the machine

| Check | Command | What is needed |
| --- | --- | --- |
| System | `uname -s` | `Darwin` (macOS) or `Linux`. Anything else is Windows, such as `MINGW64_NT-…` in Git Bash (`MSYS_NT-…` and `CYGWIN_NT-…` in other shells), and so is a shell with no `uname`: follow [On Windows](#on-windows) |
| Node | `node -v` | 22.22 or later, below 27. Otherwise tell the person to install Node 22, 24 or 26 (from nodejs.org or a version manager), and stop |
| Python 3 | `python3 -c "import fcntl"` | It prints nothing. Rho's file lock needs it on macOS and Linux. On a Mac where it fails, the person installs the Command Line Tools with `xcode-select --install`; wait for that |
| R | `Rscript --version` | Optional: only R work needs R |
| Your client | `claude --version` or `codex --version` | Which Agent you are. Another client works too; steps 5 and 6 say how |

## 2. Look for a Rho that is already here

```sh
npm ls -g @rho-workspace/rho
for s in "$HOME/Rho/state" "$HOME/.rho-service"; do
  [ -f "$s/connection.json" ] || continue
  url=$(node -p "require('$s/connection.json').url")
  echo "$s $url $(curl -s -o /dev/null -w '%{http_code}' "$url")"
done
```

The first command shows the installed version, if there is one. The loop checks the two state
folders that Rho's own instructions use. For each, it prints the address and either `200`
(running) or `000` (nothing answering).

- **Nothing found:** go on with step 3.
- **A state folder answers `200`:** Rho is already set up. Use that state folder and address
  from here on, skip to step 5, and do not start another service.
- **A state folder exists but does not answer:** ask the person whether to start their existing
  Rho again or set up a new one. For `~/.rho-service`, the projects folder is the one they chose
  earlier (`~/rho-projects` by default); ask them if it is not there.

Other running Rho services belong to other work, so leave them alone.
`pgrep -fl "[-]-state-dir"` lists them.

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

Check: `npm ls -g @rho-workspace/rho` shows the version, and `rho --help` prints the usage.

## 4. Start Rho

```sh
mkdir -p "$HOME/Rho/projects" "$HOME/Rho/state"
nohup rho --root "$HOME/Rho/projects" --state-dir "$HOME/Rho/state" --open > "$HOME/Rho/rho.log" 2>&1 &
```

If you are Codex, put `--agent-backend codex-acp` before `--open`, so that Rho's Agent panel
uses Codex. Claude Code is the default. `--open` opens the address in the person's browser.

Wait for the log's first line. It is one JSON object that starts
`{"ready":{"url":"http://127.0.0.1:…`:

```sh
for i in $(seq 30); do head -1 "$HOME/Rho/rho.log" 2>/dev/null | grep -q '"ready"' && break; sleep 1; done
head -1 "$HOME/Rho/rho.log"
```

- **No ready line after 30 seconds:** show the person the log's last lines and stop.
- **Check again in a separate command,** after the start command has returned.
  `curl -s -o /dev/null -w '%{http_code}' <url>` should print `200`. If it prints `000`, your
  client ended the background process. Give the person the start command without `nohup`, `&`
  and the redirection, to run in a terminal they keep open. Go on when the address answers.

The first start copies an example project, `PA14 quorum sensing`, into `~/Rho/projects`.

## 5. Install the Rho skill for yourself

The skill tells you, and your later sessions, how to work with Rho: its tools, the live
Notebook, how to connect, and what to do when something fails.

```sh
dir="$HOME/.claude/skills/rho"        # Codex: dir="${CODEX_HOME:-$HOME/.codex}/skills/rho"
base="https://yulab-smu.top/Rho/skills/rho"
mkdir -p "$dir/references"
for f in SKILL.md references/install.md references/connect.md references/tools.md \
         references/analysis.md references/needs.md references/troubleshooting.md \
         references/screen-check.md; do
  curl -fsSL "$base/$f" -o "$dir/$f" || echo "failed: $f"
done
head -3 "$dir/SKILL.md"
```

- **Another client:** use the folder it loads user skills from. If you do not know it, skip this
  step and say so in your report.
- **A `rho` folder is already there:** it is an earlier copy of this skill, and these files
  replace it. If its `SKILL.md` does not name `rho`, it is something else: ask the person first.
- **The site does not answer:** use
  `base="https://raw.githubusercontent.com/YuLab-SMU/Rho/main/skills/rho"`.

Check: no file failed, and the last command prints `name: rho`. New sessions load the skill.

## 6. Connect yourself to the example project

Use the state folder from step 2 if Rho was already set up. Give this project a
stable session name identifying your own Agent, then request its MCP configuration:

```sh
rho --grant "$HOME/Rho/state/connection.json" --project "PA14 quorum sensing" --session YOUR_AGENT_NAME
```

The reply is one JSON line. Add a stdio MCP server with the returned `mcp.name`,
`mcp.command` and `mcp.args` using your own client's supported configuration
mechanism. Inspect your own help or documentation if needed; preserve unrelated
settings and use private local configuration scoped to this project when available. Do not print connection-file
contents. Rho does not need a built-in configuration form for your client.

If `rho --help` lists `--agent claude-code|codex`, those clients also have a shortcut:
`rho --grant "$HOME/Rho/state/connection.json" --project "PA14 quorum sensing" --agent claude-code`
(or `--agent codex`, without `--session`). Other MCP clients use the generic reply.

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

1. **The address to open,** `http://127.0.0.1:…`. Opening it in a browser on this machine is
   all the access needed: no account, link or code.
2. **Where things are:** projects in `~/Rho/projects`, service state in `~/Rho/state`, the log
   at `~/Rho/rho.log`, and the version installed.
3. **What is missing,** if anything, and what works without it.
4. **How to start working**, in either place:
   - in the browser: open `PA14 quorum sensing` and ask in Rho's Agent panel;
   - in a new session of this client started in `~/Rho/projects/PA14 quorum sensing`, where
     Rho's tools and the skill are available.

   Read the example's `README.md` and suggest three questions they could ask about it.
5. **How to stop and restart Rho:** stop it with `rho --stop --state-dir "$HOME/Rho/state"`,
   which prints `{"stopped":…}` once Rho has ended. If `rho --help` does not list `--stop`, use
   `pkill -TERM -f "[-]-state-dir $HOME/Rho/state"`. Start it again with the command from step 4.

## On Windows

The steps above apply, with the commands below. They were run on Windows 11 x64 with Node 24 in
Windows PowerShell 5.1, started from an Agent's Git Bash. Python is not needed.

Run them in PowerShell, and call `npm.cmd` and `rho.cmd` rather than `npm` and `rho`. In
PowerShell those two are scripts, which Windows' default execution policy refuses to run. In Git
Bash, `npm` fails when `C:\Windows\System32` comes first in `PATH`, because the `bash` there is
WSL's. If your shell is Git Bash, write each block to a `.ps1` file and run it with
`powershell -NoProfile -ExecutionPolicy Bypass -File FILE`.

1. **Check the machine** as in step 1.
2. **Look for a Rho that is already here,** and go on as step 2 says. `0` means nothing answers.

   ```powershell
   npm.cmd ls -g @rho-workspace/rho
   foreach ($s in "$HOME\Rho\state", "$HOME\.rho-service") {
     if (-not (Test-Path "$s\connection.json")) { continue }
     $url = (Get-Content -Raw "$s\connection.json" | ConvertFrom-Json).url
     try { $code = (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 5).StatusCode } catch { $code = 0 }
     "$s $url $code"
   }
   ```

   Other running Rho services belong to other work, so leave them alone. This lists them:
   `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*--state-dir*' | Select-Object ProcessId, CommandLine`.
3. **Install** with `npm.cmd install -g @rho-workspace/rho`; a slow registry is handled as in
   step 3. Check: `npm.cmd ls -g @rho-workspace/rho` shows the version, and `rho.cmd --help`
   prints the usage.
4. **Start Rho** in the background, with its output in a log:

   ```powershell
   New-Item -ItemType Directory -Force "$HOME\Rho\projects", "$HOME\Rho\state" | Out-Null
   $log = "$HOME\Rho\rho.log"; Remove-Item $log -ErrorAction SilentlyContinue
   $rho = (Get-Command rho.cmd).Source
   $line = "`"$rho`" --root `"$HOME\Rho\projects`" --state-dir `"$HOME\Rho\state`" --open > `"$log`" 2>&1"
   Start-Process cmd.exe -ArgumentList "/d /s /c `"$line`"" -WindowStyle Hidden
   for ($i = 0; $i -lt 30; $i++) { if ((Get-Content $log -TotalCount 1 -ErrorAction SilentlyContinue) -match '"ready"') { break }; Start-Sleep 1 }
   Get-Content $log -TotalCount 1
   ```

   If you are Codex, put `--agent-backend codex-acp` before `--open`. Let `cmd.exe` write the log,
   as here: started with `Start-Process -RedirectStandardOutput`, Rho holds your shell's output
   open, and your command does not return while Rho runs. Removing the old log first keeps its
   ready line from being read as this start's.

   Then, in a separate command, `(Invoke-WebRequest <url> -UseBasicParsing).StatusCode` should
   print `200`. With no ready line after 30 seconds, show the person the log and stop. If the
   address does not answer, ask the person to run the start command in a PowerShell window they
   keep open: `rho.cmd --root "$HOME\Rho\projects" --state-dir "$HOME\Rho\state" --open`.
5. **Install the skill,** with the checks and choices of step 5:

   ```powershell
   $dir = "$HOME\.claude\skills\rho"     # Codex: "$(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME\.codex" })\skills\rho"
   $base = "https://yulab-smu.top/Rho/skills/rho"
   New-Item -ItemType Directory -Force "$dir\references" | Out-Null
   foreach ($f in "SKILL.md", "references/install.md", "references/connect.md", "references/tools.md",
                  "references/analysis.md", "references/needs.md", "references/troubleshooting.md",
                  "references/screen-check.md") {
     try { Invoke-WebRequest "$base/$f" -OutFile "$dir\$f" -UseBasicParsing } catch { "failed: $f" }
   }
   Get-Content "$dir\SKILL.md" -TotalCount 3
   ```

6. **Connect yourself** as in step 6, with
   `rho.cmd --grant "$HOME\Rho\state\connection.json" --project "PA14 quorum sensing" --session YOUR_AGENT_NAME`,
   or `--agent claude-code` or `--agent codex` in place of `--session`.
7. **Check R** as in step 7. Windows PowerShell 5.1 drops the double quotes inside an argument it
   passes to a program, so these use single quotes in R:

   ```powershell
   Rscript -e "cat(requireNamespace('jsonlite', quietly = TRUE), '\n')"
   Rscript -e "p <- c('ggplot2', 'dplyr', 'tidyr', 'patchwork', 'scales', 'car', 'DESeq2'); cat('missing:', p[!vapply(p, requireNamespace, logical(1), quietly = TRUE)], '\n')"
   ```

   Install `jsonlite` with `Rscript -e "install.packages('jsonlite', repos = 'https://cloud.r-project.org')"`.
8. **Tell the person** as in step 8; the log is `~\Rho\rho.log`. Stop Rho with
   `rho.cmd --stop --state-dir "$HOME\Rho\state"`: it stops in order and prints `{"stopped":…}`
   once Rho has ended. A version whose `rho.cmd --help` does not list `--stop` stops in order only
   with Ctrl+C or Ctrl+Break in a window it runs in. Started in the background, it can only be
   ended, with `Stop-Process -Id <ProcessId>` and the id the listing in step 2 shows. It then ends
   at once without a `{"shutdown":…}` line, and its Notebook sessions end with it. A managed Core
   Host it started for a project keeps running, and Rho's next start finds it.
