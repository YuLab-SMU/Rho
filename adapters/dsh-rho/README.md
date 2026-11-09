# dsh-rho

Use DeepSeek Harness as the Agent for an existing Rho project. This bundle connects
Harness's own MCP client to Rho's four existing tools. Open the full Rho WebUI to
follow the shared Notebook, inspect files, tables and figures, and ask about a
selected result. Copy that question back to the original Harness conversation;
the Agent reads its frozen context and writes its reply into Rho.

Version **0.1.7** ships the **Rho conversation tab** and **Rho sidebar entry** with
its prebuilt launcher, display metadata and original Rho icon. Both entries
show **Open Rho workspace**, which opens the existing application in Harness's
Browser beside the conversation. **Open in system browser** is also available;
use it in Web Harness, where Rho's iframe policy prevents embedding. The small
launcher verifies the current conversation’s folder against the project returned by
Rho. The same selected connection supplies that conversation’s MCP tools and
workspace button. It shows the project name, full folder and service address.
Credentials and the rest of Rho’s snapshot stay on the Host. No Rho views or result store are
bundled, and opening the interface starts no service or analysis.

The [episode](../../docs/DSH-RHO-EPISODE.md) records the observed integration and
its limits. Version 0.1.7 declares Harness 0.2.1-rc.5 and 0.2.2-rc.1
compatibility; the previous installation was checked in Desktop 0.2.2-rc.1.
It reads cold sessions through the public session-query lease. The
[external work episode](../../docs/EXTERNAL-WORK-EPISODE.md) records the latter
Desktop installation and the shared Graph, Console and Studio presentation. The
[market index](https://yulab-smu.top/Rho/market/index.json) selects
the prebuilt 0.1.7 package from an immutable public Git commit, with its icon and
checked Harness compatibility. This is Rho's own index; add it to Harness's
Discover sources to search for Rho. It is not in Harness's official default
source.

Harness renders a plugin settings entry when a bundle declares a `Config` schema
and registers a `plugins.bundle.config` card. Version 0.1.7 does both, so
**Plugins → Rho** has its own configuration section. Harness renders a new-version
control only for a third-party bundle installed from a registry spec such as
`dsh-rho@0.1.7`; a bundle installed from a Git source, tarball, link or local path
has no version section by design. The Git market index remains the delivery route
for this release, so installing from Discover does not produce that control.
See [Distribution route](#distribution-route).

## Install into Harness

Use an already running Rho service and the project you intend to share. If Rho is
not set up yet, follow its [setup guide](https://yulab-smu.top/Rho/doc/setup.md).
Do not start another service on an existing state folder.

From a prepared Rho source checkout, with the selected sibling Rho-plugins built
and Rho's dependencies installed, build the launcher and observation bundle:

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
dsh plugin --profile web add /absolute/path/to/dsh-rho-0.1.7.tgz --ignore-scripts
dsh --profile web --no-open
```

Keep these environment variables when launching Harness again. Open its printed
local address and select the **same project folder** as the Harness workspace.
Configure the model in Harness as usual. Open the new **Rho** conversation tab or sidebar entry and choose **Open Rho
workspace**. On Desktop, the complete Rho interface opens in the right Browser
pane. On Web, use **Open in system browser**.

Each grant is fixed to one Rho project. The plugin matches the current conversation’s
canonical folder to the configured grants; switching conversations selects that
conversation’s own tools and workspace. Matching is exact, including for subfolders;
symlinks to the same folder match. Missing or ambiguous matches show **Connect this
project**, with no open link and no Rho tools. The plugin never creates a grant,
searches the disk for credentials, or falls back to another project. Do not put
connection files or their contents into a project, package or chat.

Reuse the existing Rho Agent Skill if it is installed in `~/.agents/skills/rho`,
which Harness already discovers. Otherwise its unchanged source directory
`skills/rho` can be linked into `$DSH_HOME/skills/rho`. It is not copied into this
bundle. The MCP tools also expose Rho's live operation contracts and owner skills.

## Plugin settings

Version 0.1.7 exports a `Config` schema for `connectionFile`, `connectionFiles`,
`command`, `args`, `maxBridges` and `toolCallTimeoutMs`, and its browser half
registers a `plugins.bundle.config` card under the package name. Harness therefore
lists Rho as a configurable bundle and renders the card on **Plugins → Rho**,
between the description and the component rows.

The card reads and writes the same configuration the profile patch holds. It
shows the agent connection file paths, the Rho command, extra arguments, the
bridge limit and the tool reply wait. Save writes the changed fields; turn the
bundle off and on for connection and command changes to take effect. A profile
patch of a higher layer can override a value written here, and a read-only or
unavailable configuration is shown without pretending to be editable. Entering
paths in the card does not copy the credential files themselves anywhere.

Editing `cordis.patch.yml` by hand remains supported. Both routes lead to the
same `resolveWorkspace` check: one existing project grant per canonical folder,
no grant creation and no fallback to another project.

## Harness Desktop

Use **Plugins → Add plugin** to install the tarball, then **Enable now**. Desktop
owns its profile; the separate `dsh plugin --profile desktop` CLI is refused.
To upgrade an installed local version, turn it off, uninstall it and install the
new tarball through the same page. This releases the MCP bridge and UI, leaving
the existing Rho service and Notebook running.

A Desktop app opened from Finder may not inherit shell exports. Its profile
`cordis.patch.yml` can hold one explicit configuration. The 0.1.5 release removed the
separate `rho-mcp` entry: remove that old override when upgrading. There is one
connection selection for both the launcher and tools.

```yaml
- id: dsh-rho
  config:
    command: /absolute/path/to/node_modules/.bin/rho
    connectionFiles:
      - /absolute/path/to/project-a-agent-connection.json
      - /absolute/path/to/project-b-agent-connection.json
```

For one project, `connectionFile` is also supported. Each path must be an existing
project-scoped agent grant. Use one grant per canonical project folder; two
services pointing at the same folder are ambiguous and refused.

If using Node directly, set `command` to its absolute executable and set
`args: [/absolute/path/to/rho/dist/cli.js]`. The plugin appends `--mcp` and the
matched connection file itself. `toolCallTimeoutMs` defaults to 300000 and
`maxBridges` to 8 active conversation bridges. Exceeding that limit refuses a new
bridge and leaves the existing work intact.

After changing the configuration, reload the bundle. Existing transports keep
their original connection until unloaded; replacing their connection file causes
new tool calls and the launcher to refuse the mismatch. Reconnection does not
replay analysis. **Try again** can retry an initially unavailable bridge for an
already live conversation. Opening the panel only reads the connection; it does
not resume an Agent. A dormant conversation connects when Harness resumes it.

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
Each conversation’s MCP entry starts only `rho --mcp`, a bridge to the existing
service. The launcher reads at most 64 KiB per connection file and refuses larger
files, remote addresses, credential-bearing addresses and connections without a
project scope. It checks at most 16 configured grants, with a five-second deadline
and 4 MiB response cap per project snapshot; a failed or over-limit check leaves
that connection unavailable. Only project identity leaves the Host. It neither
starts Rho nor starts another Agent. Closing Harness does not stop the Rho service
or its live Notebook; closing a browser view does not rerun analysis.

The `dsh-rho` configuration sets `toolCallTimeoutMs` to **300000** (five minutes), configurable
through a Harness profile patch. This bounds a tool reply wait, not the lifetime
of a Rho cell. Use shorter Notebook waits and read the original cell when it is
still running. After a transport error, preserve the original `changeId` and
recover its outcome; never assume a timeout stopped the work or submit a new run.
Rho 0.5.3 has its own bridge deadlines too; long jobs were not exercised here.

Missing or inaccessible connection files keep the launcher visible with **Try
again** and leave that conversation without Rho tools. Correct the path or start the selected Rho service, then
reload the entry or restart Harness. Its native MCP client owns reconnection and
does not replay analysis. Do not restart a person's Rho just to reconnect Harness.

Version 0.0.1's embedded table/figure view and separate archive are retired. Its
source and evidence remain in Git and the episode record. Existing archive bytes
are not deleted or migrated by later versions. Do not replace a running 0.0.1 session in place;
use the separate trial home above to evaluate this connection.

## Distribution route

The public source includes `lib/client.js`; a Git install needs no build or
`prepare` script. Harness's ordinary bundle installer accepts the package from
the immutable commit in the [market index](https://yulab-smu.top/Rho/market/index.json),
using a quoted target of this form:

```text
git+https://github.com/YuLab-SMU/Rho.git#<full-commit>&path:/adapters/dsh-rho
```

The [Harness market](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-market/README.md)
reads configured indexes. The Rho index names this package, its exact Git source,
display metadata and `engines.dsh`; publishing an index does not add it to anyone's
Harness configuration. No second Rho implementation is distributed.

For a subsequent release, build and test the launcher, inspect the packed files,
commit the prebuilt client with its source, and publish that source commit first.
Then generate the index from that full commit ID:

```sh
node adapters/dsh-rho/market.mjs --commit <full-published-source-commit>
```

Validate the output with Harness's `parseMarketIndex`, and verify a fresh install
of its `marketInstallTarget` before publishing `site/market/index.json` to
`gh-pages`. The generator copies metadata and the commit's timestamp from the
selected commit, rather than following a branch at install time.

Harness's own version section and update control require the installed profile
dependency to be a registry spec under its own name (`dsh-rho@0.1.7`), with a
semver version in the manifest. A Git commit, tarball, link or path spec is
deliberately excluded, so the Git index above never produces that control.
Publishing the package to a registry and installing it by name is a separate
delivery decision with its own evidence; it is not part of this release. TUI and
other operating systems remain outside the observed integration.


## Read-only conversation observation

With Rho 0.5.5, **Agent → Conversations** shows this client's existing and new
conversations in the verified project. Input remains in Harness. Startup reads
native session headers and backfills at most 64 sessions per configured project;
it does not resume cold Agents. A committed event schedules an observation after
500 ms; unfinished sessions refresh every 3 seconds. **Open Rho workspace** retries
observation, including a cold session. A failure leaves earlier records in place.

The adapter bundles Agent 0.4.33's public `dsh-session` entry, its input digests and
licenses. It adds no execution journal or managed guarantees. System/injected
messages and reasoning are excluded. Tool returns, exit codes and turn outcomes
are separate; a missing result stays unknown. Native result paths open current
files, while successful resource replies can open the exact registered version.
The [owner's limits](https://github.com/YuLab-SMU/Rho-plugins/blob/main/plugins/agent/README.md#external-conversations)
and [real application episode](../../docs/EXTERNAL-CONVERSATIONS-EPISODE.md)
name retention limits, refusal behavior and what was checked.
