# A WorkBuddy connector for Rho

Updated 2026-11-10. After the [outside-Agent episode](OUTSIDE-AGENT-EPISODE.md) the user asked
whether WorkBuddy can set up Rho's experts, skills and connectors by itself, and then asked for
one package made for WorkBuddy, to submit at <https://open.workbuddy.cn/>. This episode reads what
WorkBuddy had done with Rho, how WorkBuddy 5.9.3 loads each of the three, runs WorkBuddy's own
agent core on the user's requests, and builds the package: a CLI connector,
[adapters/workbuddy-rho](../adapters/workbuddy-rho/README.md).

## What WorkBuddy had done

From WorkBuddy's own session files and its folder `~/.workbuddy` on this Mac:

| Kind | What happened | Result |
| --- | --- | --- |
| Connector | Its Agent added Rho's MCP server to `~/.workbuddy/mcp.json` three times (2026-11-06 and 11-07): `rho-project` for the airway project, `rho-ggtree`, `rho-pa14-quorum-sensing` | None ran. WorkBuddy runs a server in that file only after the person approves it under its connectors: `mcp-approvals.json`, keyed by a hash of the command, arguments, environment names and folder, was empty. A server an Agent writes there is shown as disabled, and a new grant changes the arguments, so the hash. In the 11-07 session the Agent found no `rho_*` tools, and its connection request returned "skipped" |
| Expert | Asked with `@skill:expert-manager 帮我创建一个 Rho使用专家…` (11-09), WorkBuddy's built-in expert skill made `rho-data-analyst` in 494 s: persona, a copied Rho Skill, an avatar; validated, registered, packaged | Its Skill is the one before `rho open` and `rho tool`, and teaches `rho connect` and an MCP server. On 11-10 the user's CSV request to that expert again had no Rho tools; the Agent wrote its own MCP client script and was interrupted at 289 s |
| Skill | WorkBuddy installs skills from its market (`marketplace-skill-installer`), which has no Rho | `~/.workbuddy/skills/rho` was imported by the user, at 10:42 UTC on 11-09: seven minutes after the airway conversation began, so that conversation could not list it |

Two statements of the outside-Agent episode change with this: `rho-project` is the airway
project's server, not another project's, and the Skill was not ignored but not yet installed.

## WorkBuddy's agent on the request

WorkBuddy's agent core is a CodeBuddy CLI inside the app
(`app.asar.unpacked/cli/bin/codebuddy`). Run with `ELECTRON_RUN_AS_NODE` and a throwaway config
folder it has WorkBuddy's built-in skills. Its own models need the desktop app's login, so a custom
model pointing at the local gateway carried `westlakehpc/glm-5.3-flash`; the tools the desktop app
adds (market search, connector requests, image generation) are absent there.

Asked "帮我在 WorkBuddy 里配置好 Rho 相关的专家、技能和连接器，之后我要在这个项目里用 Rho 做数据分析。" on a
copy of the airway project, three runs (83–169 s) went to the market skills, `recommend-experts`,
`recommend-connectors` and `marketplace-skill-installer`, found no market tools and stopped. None
made an expert locally or ran `rho`; one asked whether "Rho" meant RhoA/ROCK or Spearman's rho.
Those runs could not write files or run commands (an allow-list problem of the harness, fixed
below), so they show where WorkBuddy looks, not what it does next.

So WorkBuddy does not reach Rho by itself: an expert is made only when named, a connector it writes
does not run, and a skill comes from the market. A market connector is what WorkBuddy offers a
person and installs itself.

## The package

WorkBuddy's open platform takes a connector as a folder with `connector-meta.json`, either
`mcp.json` or `cli.json`, an icon and optional `skills/`. Its `mcp.json` must hold one server whose
arguments cannot carry a placeholder or a per-machine path, and Rho's MCP server needs the path of
a project's grant file. `rho tool` reaches the same four tools from a shell, in the conversation,
with no approval and no new conversation. Of the 312 connectors in WorkBuddy's local market cache, 46
are listed as CLI connectors, most installed by `npm install -g` with a Node WorkBuddy provides.

| File | Content |
| --- | --- |
| `connector-meta.json` | `source` `rho-workspace`, `type` `cli`, version 1.0.0, Chinese and English names, descriptions and three examples each, WorkBuddy 4.24.0 or later |
| `cli.json` | `init`: `npm install -g @rho-workspace/rho@latest` with Node `>=22.22.0 <27` (Rho's `engines`); `versionCheck`: `rho --version` at least 0.5.8; `status`: `rho --version` matching a version, since Rho has no sign-in; `unAuth`: the same harmless command; no `auth` |
| `icon.svg` | Rho's ρ icon, as in the Harness plugin |
| `skills/rho/SKILL.md` | Open with `rho open`, tell the person Rho is a page in their browser, work through `rho tool … --as workbuddy`, leave `mcp.json` alone, run R and Python as Notebook cells, report the page's address. The build adds Rho's seven references beside it |

`node adapters/workbuddy-rho/build.mjs` checks the fields WorkBuddy's page requires, that the
runtime range is Rho's `engines.node`, that this Rho is at least `minVersion`, that `statusMatch`
matches `rho --version`, that each link reaches a packaged file and that no file names the
building machine's home or holds a credential, and writes `work/workbuddy-rho/rho-workspace/` and
`rho-workspace-1.0.0.zip`. `test/workbuddy-connector.test.mjs` runs the build and the three
`cli.json` commands against this build. Rho's own `connect` reference now also tells an Agent in
WorkBuddy to use `rho tool` and leave `mcp.json` alone.

## Trials with WorkBuddy's agent

`scripts/outside-agent-trials.mjs --client workbuddy` runs the outside-Agent cases with WorkBuddy's
agent core instead of Claude Code: a throwaway home and WorkBuddy config folder, its built-in
skills, the tools allowed in its settings, the gateway route as a custom model. `bare` has `rho` on
PATH (as after the connector's `init`, without its Skill); `skill` also has the connector's Skill
in the config folder's `skills/`. Three runs each, in parallel.

**"使用rho 启动该项目"**:

| | Seconds | Calls | Folder a project | Told it is a browser page, with the address |
| --- | --- | --- | --- | --- |
| bare | 35, 35, 34 | 6, 5, 5: `ls`, `.rho`, `rho --help`, `rho open` | 3 of 3 | 3 of 3 |
| skill | 26, 25, 26 | 2: the Skill, `rho open` | 3 of 3 | 3 of 3 |

WorkBuddy's shell rebuilds `PATH` with `/usr/bin` first, so the harness's recorder for `open` was
passed over and these six runs opened up to twelve real tabs, to their own temporary services,
on the user's screen. The `rho` wrapper of the harness now puts the recorder first itself.

**"Draw the volcano plot in the notebook; I will select the genes I care about."**, with the
folder opened first:

| | Seconds | Result | Address in the answer |
| --- | --- | --- | --- |
| bare | 168, 171 | A Notebook cell through `rho tool`; points of 17,173 marks bound to rows | 1 of 2 |
| bare | 235 | No Rho command: "项目里没有 Jupyter notebook", a separate plotly HTML through `Rscript` | — |
| skill | 97, 94, 168 | A Notebook cell through `rho tool` in each; 17,173, 17,173 and 17,165 bound marks | 3 of 3 |

The second `skill` run did not load the Skill and went to `rho tool` from `.rho/README.md`. With
the Skill no run read Rho's state files more than once or edited an MCP configuration; the slow
one spent 40 s finding `rho tool index`'s paging and input forms.

## Not done

- **Submitted:** nothing. The platform has no upload API; the user submits the zip, and the
  connector works only once Rho 0.5.8 (with `rho open` and `rho tool`) is on npm.
- **WorkBuddy's own model and desktop app:** the trials used WorkBuddy's agent core with
  GLM-5.3-flash, without the app's host tools or its model. Installing through the connector, its
  `versionCheck` and `status`, and how the app shows a CLI connector without sign-in are unobserved
  until the connector is installed from the market.
- **Platform rules:** whether review accepts a CLI connector with no `auth`, and the zip's
  expected root, are unknown; the README gives what to tell the reviewer.
- **Windows** through WorkBuddy is unobserved (`rho.cmd` runs in CI).
- The user's own `rho-data-analyst` expert and `~/.workbuddy/skills/rho` keep the older Skill;
  the user's `mcp.json` keeps three servers that never ran. Nothing in the user's WorkBuddy folder
  was changed.
