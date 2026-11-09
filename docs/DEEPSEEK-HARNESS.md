# DeepSeek Harness plugin

Use DeepSeek Harness as the Agent for a Rho project. The **dsh-rho** plugin adds a
**Rho** conversation tab and sidebar entry. **Open Rho workspace** opens the full
Rho interface in Harness Desktop's Browser pane beside your conversation. Harness
keeps its model and permissions; Rho keeps the shared Notebook, files, tables,
figures and selected-result questions.

The 0.1.7 adapter observes existing and new Harness conversations in the matching
project. Rho source after 0.5.6 reads that native record in **Agent → Conversations**,
**Graph**, **Console**, the answer board and the session's **Studio**, including its
original Notebook cells. The [external work episode](EXTERNAL-WORK-EPISODE.md)
records that Desktop check. The npm 0.5.6 WebUI predates these process-view
changes; installing the adapter alone does not replace that application build.
**Connections** is for project access setup; it does not count conversations.
Only exact matching project folders are observed. Missing or ambiguous matches
show **Connect this project**, with the open button disabled and no Rho tool access.

The last Desktop check used **Harness 0.2.2-rc.1** and its version-4 session log
on macOS with the 0.1.6 source. The 0.1.7 settings page has been built, packed and
loaded in a disposable profile, but its rendered card has not yet been observed in
a running Desktop. The earlier [external conversation episode](EXTERNAL-CONVERSATIONS-EPISODE.md)
checked 0.1.5 with **Harness 0.2.1-rc.5**, retaining its own failures and scope. The earlier
[project matching check](DSH-RHO-EPISODE.md#conversation-project-matching) and
[real model loop](DSH-RHO-EPISODE.md#reuse-the-whole-rho-application) retain their
own scope. TUI and other systems remain unverified for this adapter.

## Public package and index

The checked **0.1.7 source candidate** is available directly from source commit
[`a2ceabc0`](https://github.com/YuLab-SMU/Rho/commit/a2ceabc0f4c481178cd843936357a9b6b413c6ef),
package directory `adapters/dsh-rho`. Its twelve distribution files include the
prebuilt launcher and observation bundle, Host, connection resolver, licenses,
original icon and display locale.
Installation needs no build allowance or local source checkout. The exact target is:

```text
git+https://github.com/YuLab-SMU/Rho.git#a2ceabc0f4c481178cd843936357a9b6b413c6ef&path:/adapters/dsh-rho
```

The [public index](https://yulab-smu.top/Rho/market/index.json) selects
**0.1.7** from the same immutable commit, compatible with **Harness 0.2.1-rc.5 or
0.2.2-rc.1**. The checked `site/market/index.json` in this source is the file to
publish; publishing it to the site is a separate step from this source commit.
Use the exact Git target above until that publication is live. Enable **Plugins → More → Custom plugin markets** if
Discover is absent. In **Discover**, add this address to the index sources, then
search for `Rho`:

```text
https://yulab-smu.top/Rho/market/index.json
```

This is **Rho's own index**, not an official default Harness source. It must be
added explicitly. There is no npm release. A bundle installed from a Git target,
a tarball or this index has no **Versions** section in Harness: the update control
is limited to packages installed from a registry spec under their own name.
Upgrading this plugin is therefore the off/uninstall/install sequence below. The
[public verification record](EXTERNAL-CONVERSATIONS-EPISODE.md#verification-and-delivery) records
fresh installation and index validation separately from the workspace check.

## Prepare Rho and its project grant

Use your existing Rho service. If you have not installed Rho, follow the
[installation guide](https://yulab-smu.top/Rho/docs/start/). Keep its service state
outside the projects folder and keep the service running while using Harness.
Do not start another service on the same state folder.

Choose the project to share. In this example, `analysis` is its folder relative
to the running service's projects root:

```sh
rho --grant /absolute/path/to/rho-state/connection.json \
  --project analysis --session dsh
```

The command prints an **agent connection file** path. Configure that path once
under `dsh-rho`. Keep the file outside the project; its contents are credentials
and must stay out of chats, packages and Git.

Select the same project folder as the Harness workspace. One profile can hold
several existing project grants: each conversation selects the single grant that
matches its canonical folder exactly. Subfolders do not match the parent project;
symlinks to the same folder do. The plugin neither creates grants nor searches
the disk for credentials, and it never falls back to another project.

## Install in Harness Desktop

A Desktop app opened from Finder may not inherit terminal environment variables.
Set explicit paths in its profile's `cordis.patch.yml` (by default,
`~/.dsh/profiles/desktop/cordis.patch.yml`). Preserve the profile's other entries.
**When upgrading from 0.1.3 or earlier, remove the old `rho-mcp` override.**
Version 0.1.7 has one `dsh-rho` configuration for both tools and workspace:

```yaml
- id: dsh-rho
  config:
    command: /absolute/path/to/node_modules/.bin/rho
    connectionFiles:
      - /absolute/path/to/project-a-agent-connection.json
      - /absolute/path/to/project-b-agent-connection.json
```

For one project, `connectionFile` is also supported. Use one existing grant per
canonical project folder; two configured services for the same folder are
ambiguous. If calling Node directly, set `command` to its absolute executable and
`args: [/absolute/path/to/rho/dist/cli.js]`. The plugin appends `--mcp` and the
matched connection file itself.

1. Open **Plugins → Add plugin**, enter the exact Git target above, and choose
   **Enable now** after installation. The tarball below is another install source.
2. Check that the single **Rho** component says **Running**. Desktop owns its
   profile; the separate `dsh plugin --profile desktop` CLI is refused.
3. Open a conversation in the project folder, then select its **Rho** tab or the
   left **Rho** sidebar entry. Check the displayed path and choose **Open Rho
   workspace**. The complete Rho opens in the right Browser pane.

After changing the configuration, turn the bundle off and on in Plugins. To
upgrade an installed bundle, turn it off, uninstall it and install the new source
through the same page. Existing Rho services, Notebook sessions and project data
remain in place. The original conversation can be retained.

## Plugin settings and updates

Version 0.1.7 declares a `Config` schema for `connectionFile`, `connectionFiles`,
`command`, `args`, `maxBridges` and `toolCallTimeoutMs`, and registers a
`plugins.bundle.config` card. Harness therefore shows **Plugin settings** for the
Rho bundle and renders its configuration section on the bundle page. The card
edits the same values as the profile patch: connection file paths, the Rho command
and its arguments, the eight-bridge limit and the five-minute tool reply wait.
Save the card, then turn the bundle off and on for tool and connection changes to
take effect. A higher profile patch can override a value written here; read-only
and unavailable configuration are shown as such. Path strings are not credentials,
but the files they name are: keep those files outside the project and out of Git.

The **new version** control some other bundles show is a different mechanism.
Harness offers it only to a third-party bundle installed from a registry spec such
as `dsh-rho@0.1.7`, whose manifest declares a semver version; Git, tarball, link
and local-path installs are deliberately excluded, as are official bundles. This
release keeps the immutable Git source and Rho's own index, so its upgrade path
remains off → uninstall → install. Publishing `dsh-rho` to a registry and
installing it by name is a separate delivery decision that has not been made or
verified here.

## Use Web Harness

For a separate trial home, set the connection before launching Harness:

```sh
export DSH_HOME="$HOME/.dsh-rho"
export RHO_DSH_CONNECTION="/absolute/path/to/agent-connection.json"
# Only if rho is outside PATH:
# export RHO_DSH_COMMAND="/absolute/path/to/node_modules/.bin/rho"
dsh plugin --profile web add \
  'git+https://github.com/YuLab-SMU/Rho.git#a2ceabc0f4c481178cd843936357a9b6b413c6ef&path:/adapters/dsh-rho' \
  --ignore-scripts
dsh --profile web --no-open
```

Keep these environment variables on later starts, or use the explicit profile
configuration above. Open Harness's printed address, choose the same project
folder and configure your model in Harness as usual. Use **Open in system
browser** on Web Harness, where Rho's iframe policy prevents embedding. Desktop
can use that link too.

Harness discovers the existing Rho Agent Skill in `~/.agents/skills/rho`. If it is
not installed there, link this checkout's unchanged `skills/rho` directory into
`$DSH_HOME/skills/rho`. The MCP tools also expose Rho's live contracts and project
skills; the plugin does not copy or replace them.

## Optional: build a local tarball

This selects the same fixed public source and its Agent component. Work in a
fresh directory; these builds do not replace your running Rho service:

```sh
git clone https://github.com/YuLab-SMU/Rho.git rho-harness
cd rho-harness
git checkout a2ceabc0f4c481178cd843936357a9b6b413c6ef
git clone https://github.com/YuLab-SMU/Rho-plugins.git ../Rho-plugins
git -C ../Rho-plugins checkout "$(node -p 'JSON.parse(require("node:fs").readFileSync("components.json")).plugins.commit')"
npm --prefix ../Rho-plugins ci
npm --prefix ../Rho-plugins run build
npm ci
npm --prefix adapters/dsh-rho ci --ignore-scripts
npm --prefix adapters/dsh-rho run build
npm --prefix adapters/dsh-rho test
mkdir -p work/dsh-rho/package
npm pack ./adapters/dsh-rho --ignore-scripts \
  --pack-destination "$PWD/work/dsh-rho/package"
```

The resulting file is `work/dsh-rho/package/dsh-rho-0.1.7.tgz`. Use it in
**Plugins → Add plugin** in place of the Git target.

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
Version 0.1.7 does not insert a draft automatically. Opening or closing a Rho view
does not start, rerun or cancel analysis.

## Connection problems

| What you see | What to check |
| --- | --- |
| No Rho tab or sidebar entry | Install and enable **dsh-rho 0.1.7**. Check that its single Rho component is Running. |
| Tools work but Conversations or process views stay empty | A tools-only MCP entry does not observe native conversations. Configure the exact project grant under `dsh-rho`, reload it, and use the WebUI build containing the external-work changes. |
| **Connect this project**, with a disabled open button | Compare the displayed conversation folder with the configured projects. Add its existing grant, or remove duplicate matches, then reload the bundle. |
| **Try again** after a connection failure | Check the agent file and that its Rho service is running. Retry an initially unavailable connection for a live conversation. A dormant conversation connects when Harness resumes it. |
| An old `rho-mcp` entry or changed connection is reported | Remove the old override, keep one `dsh-rho` configuration and reload the bundle. An existing bridge keeps its original connection until unloaded. |
| Harness Browser is unavailable | Choose **Open in system browser**. The launcher stays available. |
| The bridge limit is reached | Release an unused conversation bridge or increase `maxBridges` (default 8), then retry. Existing bridges are retained. |
| A tool call times out | Read the original cell and recover its outcome with the same `changeId`. A timed-out reply does not establish that execution stopped. Do not submit another run just to reconnect. |

The MCP reply wait is five minutes (`toolCallTimeoutMs: 300000`), configurable in
the profile. It does not limit a Notebook cell's lifetime. Use shorter Notebook
waits and observe the original cell while it runs. Long jobs were not exercised.
Reconnect Harness without restarting another person's Rho or Notebook.

See the [package README](https://github.com/YuLab-SMU/Rho/blob/a2ceabc0f4c481178cd843936357a9b6b413c6ef/adapters/dsh-rho/README.md)
for the connection and resource bounds, and the
[public distribution record](EXTERNAL-CONVERSATIONS-EPISODE.md#verification-and-delivery) for the
fixed source and installation evidence.
