# dsh-rho

Use DeepSeek Harness as the Agent for an existing Rho project. This bundle connects
Harness's own MCP client to Rho's four existing tools. Open the full Rho WebUI to
follow the shared Notebook, inspect files, tables and figures, and ask about a
selected result. Copy that question back to the original Harness conversation;
the Agent reads its frozen context and writes its reply into Rho.

Version **0.1.2** adds a **Rho conversation tab** and **Rho sidebar entry**. Both
show **Open Rho workspace**, which opens the existing application in Harness's
Browser beside the conversation. **Open in system browser** is also available;
use it in Web Harness, where Rho's iframe policy prevents embedding. The small
launcher reads only the service address and project ID from the configured agent
connection file. Credentials stay on the Host. No Rho views or result store are
bundled, and opening the interface starts no service or analysis.

The [episode](../../docs/DSH-RHO-EPISODE.md) records the observed integration and
its limits. This is a local prototype, not an npm release or a market listing.

## Install into Harness

Use an already running Rho service and the project you intend to share. If Rho is
not set up yet, follow its [setup guide](https://yulab-smu.top/Rho/doc/setup.md).
Do not start another service on an existing state folder.

From a Rho source checkout, build only this small browser launcher and package it:

```sh
npm --prefix adapters/dsh-rho ci --ignore-scripts
npm --prefix adapters/dsh-rho run build
npm --prefix adapters/dsh-rho test
mkdir -p work/dsh-rho/package
npm pack ./adapters/dsh-rho --ignore-scripts --pack-destination "$PWD/work/dsh-rho/package"
```

Grant access through Rho's existing CLI. `analysis` below is the project folder
relative to that service's projects root. The command prints an agent connection
file path, not its credential contents:

```sh
rho --grant /absolute/path/to/rho-state/connection.json --project analysis --session dsh
```

Use the returned **agent** `connectionFile`, not the operator's connection file.
For a separate trial profile:

```sh
export DSH_HOME="$HOME/.dsh-rho"
export RHO_DSH_CONNECTION="/absolute/path/to/the/agent-connection.json"
# Only when rho is outside PATH:
# export RHO_DSH_COMMAND="/absolute/path/to/node_modules/.bin/rho"
dsh plugin --profile web add /absolute/path/to/dsh-rho-0.1.2.tgz --ignore-scripts
dsh --profile web --no-open
```

Keep these environment variables when launching Harness again. Open its printed
local address and select the **same project folder** as the Harness workspace.
Configure the model in Harness as usual. Open the new **Rho** conversation tab or sidebar entry and choose **Open Rho
workspace**. On Desktop, the complete Rho interface opens in the right Browser
pane. On Web, use **Open in system browser**.

The grant is fixed to one Rho project. Changing Harness's workspace does **not**
switch or revoke it. Use a separate Harness home for each project grant. Do not
put connection files or their contents into a project, package or chat.

Reuse the existing Rho Agent Skill if it is installed in `~/.agents/skills/rho`,
which Harness already discovers. Otherwise its unchanged source directory
`skills/rho` can be linked into `$DSH_HOME/skills/rho`. It is not copied into this
bundle. The MCP tools also expose Rho's live operation contracts and owner skills.

## Harness Desktop

Use **Plugins → Add plugin** to install the tarball, then **Enable now**. Desktop
owns its profile; the separate `dsh plugin --profile desktop` CLI is refused.
To upgrade an installed local version, turn it off, uninstall it and install the
new tarball through the same page. This releases the MCP bridge and UI, leaving
the existing Rho service and Notebook running.

A Desktop app opened from Finder may not inherit shell exports. Its profile
`cordis.patch.yml` can instead hold explicit overrides for both entries. Keep the
same **agent** connection file in both. A `config` override replaces the whole
configuration, so include the full MCP configuration:

```yaml
- id: rho-mcp
  config:
    serverName: rho
    transport: stdio
    command: /absolute/path/to/node_modules/.bin/rho
    args: [--mcp, /absolute/path/to/agent-connection.json]
    failOnStartupError: true
    toolCallTimeoutMs: 300000
- id: dsh-rho
  config:
    connectionFile: /absolute/path/to/agent-connection.json
```

If using Node directly, set `command` to that Node executable and put the absolute
Rho `dist/cli.js` path first in `args`, before `--mcp`. After editing, turn the
bundle off and on in Plugins to apply it. Verify its components say **Running**;
being installed or selected does not establish a live connection.

## Try the flow

1. Ask Harness to analyse a project file through the **shared Rho Notebook**, save
   its script and results, and register a result table with an explicit string key.
   The tools are `rho_index`, `rho_resolve`, `rho_call` and `rho_read`, each prefixed
   with `mcp__rho__` in Harness.
2. Open **Rho → Open Rho workspace**. In Rho, inspect **Notebook**, then the result under **Results & figures**.
   Choose **Open in Studio**, select a row, and **Ask about selected rows**.
3. Enter the question and choose **Send question**. Open **Review**, select
   **External Agent · copy request**, then **Copy request**. Wait for the copied
   confirmation, paste into the original Harness conversation and send.
4. Harness reads that exact context with `context.read` and responds with
   `annotation.reply`. Rho shows the reply against the retained table version.

Copying prepares a handoff; it does not send a message. The person chooses the
Harness conversation. This version does not insert a draft automatically.

## Ownership and limits

Harness keeps its model, permissions, native tools and conversation. Rho keeps its
project grant, Notebook, resources, versions, selections, review and full WebUI.
The MCP entry starts only `rho --mcp`, a bridge to the existing service. The launcher
reads at most 64 KiB from its connection file and refuses larger files, remote
addresses, credential-bearing addresses and connections without a project scope. It neither
starts Rho nor starts another Agent. Closing Harness does not stop the Rho service
or its live Notebook; closing a browser view does not rerun analysis.

The `rho-mcp` entry sets `toolCallTimeoutMs` to **300000** (five minutes), configurable
through a Harness profile patch. This bounds a tool reply wait, not the lifetime
of a Rho cell. Use shorter Notebook waits and read the original cell when it is
still running. After a transport error, preserve the original `changeId` and
recover its outcome; never assume a timeout stopped the work or submit a new run.
Rho 0.5.3 has its own bridge deadlines too; long jobs were not exercised here.

Missing or inaccessible connection files keep the launcher visible with **Try
again** and fail MCP activation; Harness may still
open without Rho tools. Correct the path or start the selected Rho service, then
reload the entry or restart Harness. Its native MCP client owns reconnection and
does not replay analysis. Do not restart a person's Rho just to reconnect Harness.

Version 0.0.1's embedded table/figure view and separate archive are retired. Its
source and evidence remain in Git and the episode record. Existing archive bytes
are not deleted or migrated by later versions. Do not replace a running 0.0.1 session in place;
use the separate trial home above to evaluate this connection.

## Distribution route

The tested entry route is Harness's ordinary bundle installer. It also supports
Git packages in a subdirectory, so a future published source commit can be
installed with a quoted target of this form:

```text
git+https://github.com/YuLab-SMU/Rho.git#<full-commit>&path:/adapters/dsh-rho
```

The [Harness market](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-market/README.md)
reads indexes configured by the user; this tested release ships with no default
index. Listing this bundle would add an index entry pointing at an available
commit or npm version. It does not require a second Rho implementation. Git
installation, public npm publication, market inclusion and TUI remain
unverified; this bundle stays private until a publication is selected.
