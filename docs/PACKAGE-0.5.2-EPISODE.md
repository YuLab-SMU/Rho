# Packing 0.5.2 without the Agent clients

Updated 2026-11-01. The user compared the 275 MB 0.5.1 tarball with two projects that
distribute simply: servers-connect publishes a wheel of only its own code from a GitHub
Release, and magpie drives about 70 Agents that the person installs. Their conclusion was
that Rho should not bundle Agent clients, and they asked to optimize how the current source
is packed and distributed.

## What the 0.5.1 tarball carried

The accepted 0.5.1 stage held 676 MB of production dependencies. Two were each one
platform's native Agent client, measured at the same versions in the Plugins workspace:

| Package | Size | Reached by |
| --- | --- | --- |
| `@openai/codex-darwin-arm64` 0.164.0 | 338 MB | Codex conversations, which named no executable; the external relay |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` 0.3.310 | 261 MB | Only the external relay; in-app Claude conversations already ran `claude` from `PATH` |
| Core, Rho `dist`, all Plugins code | about 16 MB | — |

Both are optional platform dependencies of the ACP adapters
(`@agentclientprotocol/codex-acp` 2.3.0 and `claude-agent-acp` 0.97.0). They were packed
because the stage installed optional dependencies, and they also tied the tarball to
darwin-arm64. These two families were the only optional packages in the production tree.
Both adapters already accept an executable: `CODEX_PATH` and `CLAUDE_CODE_EXECUTABLE`.

## Changes by owner

**Plugins.** Agent 0.4.24 gives both adapters the selected executable, else the one named
in the environment, else `claude` or `codex` on `PATH`. This applies to conversations in Rho
and to the external relay (`rho --acp`, `rho-agent-acp`). Before the adapter starts, the
executable is looked up. A missing client fails the message with "Codex was not found on
PATH (codex). Install it, or select its executable." The relay writes the same line and exits 1.
The pack script adds Notebook and Skills; Notebook's `runner.R` and `runner.py` are its
only files outside `dist` and are scanned like `dist`. Annotations now accepts Documents
0.4.8 and 0.4.9 as its optional peer.

**Rho.** `--codex`, `RHO_CODEX` or `codex` on `PATH` selects Codex, as `--claude`, `RHO_CLAUDE`
or `claude` already selected Claude Code. The packer installs with `--omit=optional` and
refuses a package that still contains a native Agent client. It writes `SHA256SUMS` and
records `agentClients: { bundled: false }` in the composition. Its plugin list must equal
the runtime selection after the build. The installed smoke check fails if npm fetched a
native client and records the installed size. `project.doctor` adds an `agents` check that
warns when the default backend's client is missing and names the other client's state.
The version is 0.5.2.

## What packing the current source found

The packer's plugin list stopped at ten owners, while the runtime imports twelve. From the
code, a packed application would have reported Notebook and Skills as not installed and
built its WebUI without the Notebook views. This was not packed and observed.

Packing did fail on Annotations. It declared Documents `0.4.1 || … || 0.4.7` as an optional
peer, but the workspace had run it beside Documents 0.4.9, with both suites passing. The
stage bundles Documents 0.4.9, so npm looked for a matching Documents in the registry and
failed with E404.

## Missing client, before and after

The first candidate was installed and run with `PATH=/usr/bin:/bin`, and a Codex
conversation was started as the local person. The turn failed after one second with the
problem "ACP connection closed". The Overview showed "Failed · took 1 s" with no reason, and
`project.doctor` had no Agent check. The relay's stderr held `spawn codex ENOENT`. Before
0.5.2 this could not happen for Codex, because its client was bundled. Without a bundled
client, a missing client is now the likeliest failure, and it was the least explained one.

In candidate 2 the turn fails before any adapter process starts (`pid` null). Opening the
conversation shows "Not answered. Codex was not found on PATH (codex). Install it, or select
its executable." with Ask again. The doctor reports `agents: warn`. Claude Code behaves the
same way. The Overview still shows a failed answer without its reason; see the open items.

## Candidate

| Field | Value |
| --- | --- |
| Artifact | `rho-workspace-local-0.5.2.tgz`, 12,753,572 bytes, 5,095 files (0.5.1: 274,921,791) |
| SHA-256 | `37d95a2d42041e402c7ceac14db7d6e7ccbee25f7e37d3570f9176149dc639f3` |
| Application | `e55a7028`, clean |
| Plugins | `b138a27`, clean |
| Core | `4f5bed8`, the accepted 0.5.1 binary `434a92fc…`, digest-checked and not rebuilt |
| Runtime plugins | contracts 0.4.0, documents 0.4.9, files 0.5.0, r 0.4.1, requirements 0.4.0, tables 0.5.0, media 0.4.0, charts 0.4.0, agent 0.4.24, annotations 0.5.2, console 0.3.0, kernel 0.5.0, skills 0.1.0 |

The candidate, `SHA256SUMS`, `composition.json` and evidence are under `work/dist-0.5.2/`.
Candidate 1 (`cd4dea5f…`, built from `068fbc76`/`b7b69fb`) is superseded because it did not
name a missing client. It is kept in `candidate-1-superseded/`.

## Checks

| Check | Result |
| --- | --- |
| Rho suite | 269/270; the MCP v2 stdio test was cancelled at its 30 s limit and passes alone in 23 s |
| Plugins suite | 165/165; contract checks pass |
| Offline install, empty npm cache, outside all checkouts | Passed in 3 s; the cache held only the tarball; no native client; 68 MiB installed |
| Install smoke | Passed: ready 0.75 s, first render 1.6 s, home at 1440/1024/768/390 px, no Host left |
| Installed service | Twelve plugins available, Notebook with its views; doctor `plugins: ok` |
| Real Claude conversation, installed | 8/8: two turns, native permission, browser loss, cancel, transport loss, same-session recovery, restart |
| Real Codex conversation, installed | 8/8, the same checks |
| Relay `rho --acp`, installed | Claude and Codex each answered READY; the process tree ran the person's `claude` and `~/.npm-global/…/codex` |

On the first candidate, the first smoke run after a reboot took 5.1 s to first render;
two reruns took 1.0 s and 0.9 s. The client checks used Claude Code 2.1.316 and Codex
0.165.0 from `PATH`, with Westlake HPC `deepseek-v4.1-flash`. The Codex adapter was written
against Codex 0.164.0. Codex printed its own warning that it had no metadata for that model.
In the relay probe, the person's Codex also started `git-remote-https`. Installing Rho
downloads nothing, but the person's clients make their own requests.

Not rerun for 0.5.2: `install-acceptance.mjs` with explicit projects, the frontend,
sources and review acceptances, the offline reader, R/Python episodes, and the wrong
platform/digest fault cases. 0.5.1 remains the accepted preview. This candidate
establishes the packaging change, not that acceptance.

## Open items

- Agent's `rho.agent-note` view is not renderable in the installed application. Its UI
  entry carries the package version 0.4.24, but the plugin descriptor still says 0.4.19.
  The two have differed since 0.4.20. Documents differs too (0.4.9 and 0.4.7); its views
  render through their extensions.
- The Overview gives a failed answer no reason, still offers "Use this answer", and counts
  it as Answered.
- `dist/plugin-inventory.json` describes ten owners, not Notebook and Skills.
- The tarball is platform-neutral JavaScript except the bundled darwin-arm64 Core. Addressed
  by the [platforms episode](PLATFORMS-0.5.2-EPISODE.md): one Core per platform.
- No distribution step was taken. At 12 MB, the tarball and `SHA256SUMS` fit a GitHub
  Release, installed with `npm install --prefix DIR URL` and no registry rights. Registry
  publication with trusted publishing would also need `private` removed, the
  `@rho-workspace` scope, and a choice for Core: per-platform optional packages, as the
  adapters do, or a separate download.
