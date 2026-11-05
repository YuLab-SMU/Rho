# DeepSeek Harness plugin

Use DeepSeek Harness as the Agent for a Rho project. The **dsh-rho** plugin adds a
**Rho** conversation tab and sidebar entry. **Open Rho workspace** opens the full
Rho interface in Harness Desktop's Browser pane beside your conversation. Harness
keeps its model and permissions; Rho keeps the shared Notebook, files, tables,
figures and selected-result questions.

The available version is **dsh-rho 0.1.3**, a prebuilt prototype distributed from
a fixed public Git commit. Rho publishes its own
[Harness market index](https://yulab-smu.top/Rho/market/index.json), with the exact
install source, version, icon and compatibility. There is no npm release.

The full workspace flow was observed with 0.1.2 in **Harness Desktop 0.2.1-rc.5**
on macOS, with **Rho 0.5.3** and **Node 22.22.x**. Version 0.1.3 keeps its Host,
client and MCP configuration byte-identical, and adds the distribution files and
display metadata. Its public Git package was installed in fresh Harness profiles
with and without install scripts enabled. Newer combinations, TUI and other
systems have not been checked for this plugin.

## Public package and index

The index points to source commit
[`f3248a8a`](https://github.com/YuLab-SMU/Rho/commit/f3248a8ad5e1b3a5744dd04f899d0f4373995851),
package directory `adapters/dsh-rho`. The package already includes its built
launcher; installation needs no build allowance or local source checkout. The
exact install target is:

```text
git+https://github.com/YuLab-SMU/Rho.git#f3248a8ad5e1b3a5744dd04f899d0f4373995851&path:/adapters/dsh-rho
```

The index declares the checked **Harness 0.2.1-rc.5** range, the same as the
package manifest. It lists a prototype and does not claim a default or official
Harness listing. Publishing it does not change anyone's Harness configuration.

## Prepare Rho and its project grant

Use your existing Rho service. If you have not installed Rho, follow the
[installation guide](https://yulab-smu.top/Rho/docs/start/). Keep its service state
outside the projects folder, and keep the service running while using Harness.
Do not start another service on the same state folder.

Choose the project to share. In this example, `analysis` is its folder relative
to the running service's projects root:

```sh
rho --grant /absolute/path/to/rho-state/connection.json \
  --project analysis --session dsh
```

The command prints an **agent connection file** path. Use that path for both the
MCP connection and launcher below. Keep the file outside the project; its contents
are credentials and must stay out of chats, packages and Git.

The grant stays fixed to this Rho project. Choosing another Harness workspace does
not switch or revoke it. Use the same project folder as your Harness workspace,
and keep separate Harness profiles or homes for different project grants.

## Optional: build a local tarball

Use a separate source checkout. This selects the commit used for the installed
0.1.3 package; building the launcher does not build or replace your Rho service.

```sh
git clone https://github.com/YuLab-SMU/Rho.git rho-harness
cd rho-harness
git checkout f3248a8ad5e1b3a5744dd04f899d0f4373995851
npm --prefix adapters/dsh-rho ci --ignore-scripts
npm --prefix adapters/dsh-rho run build
npm --prefix adapters/dsh-rho test
mkdir -p work/dsh-rho/package
npm pack ./adapters/dsh-rho --ignore-scripts \
  --pack-destination "$PWD/work/dsh-rho/package"
```

The resulting file is `work/dsh-rho/package/dsh-rho-0.1.3.tgz`. The checked package
has eight files and is 19,642 bytes compressed; it reuses Rho's MCP tools and WebUI.

## Install in Harness Desktop

A Desktop app opened from Finder may not inherit terminal environment variables.
Set explicit paths in its profile's `cordis.patch.yml` (by default,
`~/.dsh/profiles/desktop/cordis.patch.yml`). Preserve the profile's other entries
and replace only existing entries with these IDs when upgrading. A `config`
override replaces the whole configuration, so include every MCP field shown:

```yaml
- id: rho-mcp
  config:
    serverName: rho
    transport: stdio
    command: /absolute/path/to/node_modules/.bin/rho
    args:
      - --mcp
      - /absolute/path/to/agent-connection.json
    failOnStartupError: true
    toolCallTimeoutMs: 300000
- id: dsh-rho
  config:
    connectionFile: /absolute/path/to/agent-connection.json
```

Use the same **agent connection file** in both entries. If calling Node directly,
set `command` to its executable and put the absolute Rho `dist/cli.js` path first
in `args`, before `--mcp`.

1. Open **Plugins → Add plugin**, select the tarball, and choose **Enable now**.
2. Check that the `rho-mcp` and `dsh-rho` components say **Running**. Desktop owns
   its profile; the separate `dsh plugin --profile desktop` CLI is refused.
3. Select the **Rho** conversation tab or the left **Rho** sidebar entry, then
   **Open Rho workspace**. The complete Rho opens in the right Browser pane.

After changing the paths, turn the bundle off and on in Plugins. To upgrade a
local package, turn it off, uninstall it, and install the new tarball from the
same page. This releases the bridge and launcher; your Rho service and live
Notebook stay running.

## Use Web Harness

For a separate trial home, set the connection before launching Harness:

```sh
export DSH_HOME="$HOME/.dsh-rho"
export RHO_DSH_CONNECTION="/absolute/path/to/agent-connection.json"
# Only if rho is outside PATH:
# export RHO_DSH_COMMAND="/absolute/path/to/node_modules/.bin/rho"
dsh plugin --profile web add \
  'git+https://github.com/YuLab-SMU/Rho.git#f3248a8ad5e1b3a5744dd04f899d0f4373995851&path:/adapters/dsh-rho' \
  --ignore-scripts
dsh --profile web --no-open
```

Keep these environment variables on later starts. Open Harness's printed address,
choose the same project folder, and configure your model in Harness as usual.
The **Rho** launcher offers **Open in system browser**: use it for Web Harness,
where Rho's iframe policy prevents embedding. Desktop can use that link too.

Harness discovers the existing Rho Agent Skill in `~/.agents/skills/rho`. If it is
not installed there, link this checkout's unchanged `skills/rho` directory into
`$DSH_HOME/skills/rho`. The MCP tools also expose Rho's live contracts and project
skills; the plugin does not copy or replace them.

## Analyse, inspect and ask about a selection

1. Ask Harness to analyse a project file through the **shared Rho Notebook**,
   save its script and results, and register a result table with an explicit
   string key. Harness exposes the existing tools as `mcp__rho__rho_index`,
   `mcp__rho__rho_resolve`, `mcp__rho__rho_call` and `mcp__rho__rho_read`.
2. Open **Rho → Open Rho workspace**. Inspect **Notebook** and the result under
   **Results & figures**. Choose **Open in Studio**, select a row, and choose
   **Ask about selected rows**.
3. Enter the question and choose **Send question**. Open **Review**, select
   **External Agent · copy request**, and choose **Copy request**. Wait for the
   copied confirmation, then paste and send it in the original Harness conversation.
4. Harness reads the frozen selection with `context.read` and writes its answer
   with `annotation.reply`. Rho shows the reply against that retained table version.

Copying prepares the request; you choose the Harness conversation and send it.
Version 0.1.3 does not insert a draft automatically. Opening or closing a Rho view
does not start, rerun or cancel analysis.

## Connection problems

| What you see | What to check |
| --- | --- |
| No Rho tab or sidebar entry | Install and enable **dsh-rho 0.1.3**; the earlier 0.1.0 bundle had no launcher. Check both components in Plugins. |
| Launcher shows **Try again** | Check the agent file path and that the selected Rho service is running. Correct the path, then retry. The launcher opens no service itself. |
| Launcher opens but Rho tools are missing | Check `rho-mcp`, its executable path, the complete override and its agent file. Harness can open while MCP activation has failed. |
| Harness Browser is unavailable | Choose **Open in system browser**. The launcher stays available. |
| A tool call times out | Read the original cell and recover its outcome with the same `changeId`. A timed-out reply does not establish that execution stopped. Do not submit another run just to reconnect. |

The MCP reply wait is five minutes (`toolCallTimeoutMs: 300000`), configurable in
the profile. It does not limit a Notebook cell's lifetime. Use shorter Notebook
waits and observe the original cell while it runs. Long jobs were not exercised.
Reconnect Harness without restarting another person's Rho or Notebook.

See the [integration record](DSH-RHO-EPISODE.md#desktop-installation-and-visible-entry-points)
for the installed checks and their limits, and the
[package README](https://github.com/YuLab-SMU/Rho/blob/main/adapters/dsh-rho/README.md) for the adapter's configuration
and distribution details. The [public distribution record](DSH-RHO-EPISODE.md#public-git-distribution)
keeps the fixed source, package inventory and installation evidence.
