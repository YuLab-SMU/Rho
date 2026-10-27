# Claude ACP episode

The user's 2026-10-27 request was to put ACP in the Agent plugin, connect Claude
first, and exercise real multi-turn conversation, cancellation and recovery using
Westlake HPC. Core stays unchanged. The earlier
[CLI episode](CONVERSATION-EPISODE.md) remains the record for existing CLI sessions.

## Selected boundary

Agent 0.4.8 owns ACP v1, its stdio process, Claude-specific options, streaming
updates, native permission requests, cancellation and session loading. It pins ACP
SDK 2.0.2 and claude-agent-acp 0.97.0, whose Claude Agent SDK is 0.3.310. Rho holds
the user's original message identities, durable record, input and presentation.
No Core API, source or binary changed. The real ACP episode starts no Core Host.

New conversations use ACP. Their ACP session ID is recorded before the first
prompt, and a subsequent turn reuses that connection and its Rho MCP grant.
Loading history does not append replayed updates to Rho's record. Format-1 records
stay on the extracted CLI driver. `--agent-backend claude-cli` explicitly selects
that driver for new sessions; changing the default does not migrate existing ones.

Claude's native Read, Write and Bash tools use Claude's permission policy and OS
authority. The four Rho MCP tools retain Rho's project scope and original operation
conditions, without an added approval. When Claude asks the user to choose, only
the browser on this machine can select one of its offered options. Agent grants,
paired tabs and the operator token cannot make that choice. The scoped choice is
retained before being returned to Claude, and a repeated identical choice returns
the original receipt. Closing or cancelling the turn resolves pending choices as
cancelled. Native file writes retain native conditions; they are not Documents
conditional saves or evidence of an OS sandbox.

| Event | Observed behavior |
| --- | --- |
| Browser loses acknowledgement | Retry keeps the original message identity and returns that message. |
| Browser disconnects or reloads | The Agent continues; the browser reads the original retained message. |
| User presses Stop | Send `session/cancel`; mark stopped only on the original prompt's `cancelled` response. |
| Agent transport disappears | Keep partial output and mark the unfinished message unknown. Never replay its prompt. |
| User deliberately sends a later message | Create a connection if needed and load the exact recorded ACP session. |
| Loading is unsupported or fails | Fail that new turn; do not silently create a replacement session. |
| Rho restarts | Read the existing record without execution; a later explicit send can load its session. |

ACP cancellation is separate from native process-tree termination. The foreground
test command exited after cancellation; this does not establish that every native
background job is stopped. The adapter does not expose a verified native transcript
ID here, so Rho leaves `nativeSessionId` null. Existing Core activity collectors
remain separate; this change does not invent a second Core journal.

## Real setup and observations

The source run used Node 22.22.3, Claude Code 2.1.311, Chrome 155.0.8059.84 and
Westlake HPC model `westlakehpc/deepseek-v4.1-flash`. Credentials came from the
existing local Claude configuration into process memory. No gateway address or
credential is copied to source or the evidence record. Each run uses a disposable
project and isolated Claude settings; production user settings are unchanged.

The project contains `input.txt` (`alpha=7`, `beta=11`), `notes.txt`, and a Python
gate that records one actual entry before waiting for a harness release. The first
two messages call the real Rho MCP index, read the input and save the remembered
phrase `violet river 你好` and sum 18. Later gates make cancellation and connection
loss observable while a real native command is in progress.

The final browser run is `work/acp-episode/2026-10-27T02-12-36-188Z/`; earlier
completed runs are `2026-10-27T02-05-18-434Z` and `2026-10-27T02-07-01-966Z` under
the same directory. Each `report.json` records selected
source commits and explicit dirty overrides, browser asset digests, script hash,
adapter version, session ID, visible conversation record and seven checks:

1. Lost first HTTP acknowledgement followed by Retry retained one message; native
   Read and the Rho MCP call completed.
2. The second turn reused the same ACP process and MCP credential, remembered the
   phrase and sum, and wrote Unicode to the file after a native permission choice.
3. Browser loss did not stop the released command. Reload displayed its original
   completed turn; its entry marker contained exactly one line.
4. Stop received the original ACP `cancelled` result. The measured foreground PID
   exited, with one entry and no completion file.
5. Killing only the owned ACP process group preserved the partial fifth message as
   unknown. Retrying its original request returned that message, with no second entry.
6. A deliberate sixth message loaded the same ACP session and recalled the phrase
   and sum, without rerunning the interrupted command.
7. Rho service restart retained all six messages; the seventh deliberately resumed
   that same session. Screens were captured at 1440 and 390 CSS pixels, without page
   exceptions or horizontal document overflow; no Core Host socket appeared.

The first screenshot pass caught the capture occurring before the final composer
state and before mobile history loaded. The driver now waits for those visible
states. Repeated native command details were removed from permission cards, and a
full-suite style check caught and corrected an undefined border token. The screens
still show raw Markdown in Agent prose; this inherited display limitation is not
ACP protocol failure. No human usability or provider-cost comparison is claimed.

## Checks and rerun

```sh
# Build the selected owner, then the application.
cd ../Rho-plugins && npm run build
cd ../Rho && npm run build
RHO_CORE_BINARY=/absolute/path/to/existing/rho-core \
  node --test --test-concurrency=1 test/*.test.mjs
npm run check:contracts
npm run acceptance:acp
```

`scripts/acp-episode.mjs` requires existing Westlake gateway credentials in
`~/.claude/settings.json`, the selected native Claude CLI (`RHO_CLAUDE` overrides
it), Chrome (`RHO_UI_CHROME` overrides it) and the existing Core capability binary.
It never starts a Host, signs in to a provider or edits user configuration.
`RHO_ACP_EVIDENCE` selects another evidence directory. The test chooses native
allow-once options only for its own disposable write/gate commands.

For an installed run, [assemble the package](HEADLESS.md#budgets-verification-and-assembly)
and install its tarball into a new directory outside all three source checkouts:

```sh
npm install --prefix /absolute/new-install --omit=dev --ignore-scripts \
  --no-audit --no-fund /absolute/rho-workspace-local-0.4.0.tgz
npm run acceptance:acp -- --package-root \
  /absolute/new-install/node_modules/@rho-workspace/local
```

The harness and Playwright remain in the checkout. The selected installed package
supplies the service, clients, WebUI, Agent and ACP dependencies. The driver rejects
checkout paths and dependencies escaping that package, checks the bundled Core
digest, and verifies that the running ACP process uses its installed adapter.
The report records package composition, entry hashes and dependency versions.
`node scripts/install-smoke.mjs /absolute/rho-workspace-local-0.4.0.tgz` separately
checks the installed CLI launcher and homepage in Chrome.

Four Agent owner tests cover real stdio fault fixtures. Three application ACP tests
cover message identity, cached grants, read-only restart, permission scope and
connection eviction; two existing CLI tests cover compatibility. The owner suite
passed 80/80. The initial application suite lacked `RHO_CORE_BINARY` and also found
the border token defect; its failure log is retained rather than counted as a pass.
The configured suite passed 188/188. A subsequent actual storage-failure regression
confirmed that a permission choice is neither acknowledged nor forwarded if its
record cannot be replaced, and can be retried after storage recovers. The focused
ACP/CLI/style checks passed again. Agent installs and imports independently outside
the checkouts, including its conversation entry and pinned adapter.

## Assembly and installation rounds

The first application assembly included both ACP packages but failed its existing
no-project-recipe check on `fixtures/base-r-airquality/analysis.R` (introduced before
ACP). `work/acp-assembly.log` and that unaccepted stage are retained. The package
manifest now lists only the inert `states.json` and its README; the base-R project
and its driver remain available for source-checkout acceptance. The no-recipe
guard is unchanged.

The development assembly in `work/acp-assembly-round2/` passed with an explicit
source override. Its installed CLI used the bundled Core, served the homepage at
1440, 1024, 768 and 390 CSS pixels and left no Host behind
(`work/acp-install-smoke-round2/report.json`). A separate installation outside the
checkouts passed all seven real Westlake messages and the installed-path check
(`work/acp-installed-probe/report.json`). The permission, stopped, unknown and
resumed screens were inspected; the inherited raw-Markdown limitation remains.

The Documents/Files-only assembly in `work/acp-without-agent/` also installed and
ran. Agent, ACP SDK, Claude ACP adapter, Claude SDK and MCP SDK were physically
absent; Unicode editing, export and observations worked without R or a Host.
The acceptance result is retained in `work/acp-without-agent-install.log` and its
reported temporary `report.json`. Focused ACP/CLI regression checks passed 5/5
(`work/acp-install-regression.log`); the earlier full-suite scope above is reused.

The final unsigned macOS arm64 candidate is
`work/acp-delivery/rho-workspace-local-0.4.0.tgz` (132,419,362 bytes, 4,700 entries).
Its SHA-256 is
`7a736d640eff1fbf499f037eeeaa916bdcffd9cc270face4b02fba393227d8b8`.
`work/acp-delivery/composition.json` records the complete source, artifact and
production-lock identities; all selected build inputs have no local override:

- Rho: `84fe1e6801740d2355cc23eca9da85f4c77405cb`.
- Rho-plugins: `261b5d68b55f3dbdba73332ea323e39b9e1c97d8`, Agent 0.4.8.
- Core: `4f5bed8631e15acad44cc86b63ea4779ab8af342`, existing binary SHA-256
  `434a92fced13595d281b1f9e2d6d49cf9fa7c8a451da08aa3c1ba86cec85eab3`.

That exact candidate passed the CLI/homepage check again
(`work/acp-install-smoke-final/report.json`) and a fresh installed Westlake run
(`work/acp-installed-final/report.json`): eight checks, seven turns ending
completed/completed/completed/stopped/unknown/completed/completed, the original
session ID after both recoveries, and no duplicate native dispatch. The permission,
offline, stopped, unknown and mobile recovery screenshots were inspected. All three
owned ACP process IDs had exited after cleanup. `work/acp-delivery/verification.json`
associates both installation results with the same tarball digest and unchanged Core.

In the final resumed reply, Claude described the cancelled command as rejected
before execution even though the gate's entry marker and PID proved it had started.
Rho retained the original prompt's confirmed cancellation and the measured process
exit; model prose is not execution evidence. No Core Host, scientific analysis,
provider sign-in, registry publication or signed release is part of this acceptance.

## Resource limits

`conversationLimits` can be set through Rho's `--limits` configuration. These are
application budgets, not native heap/process quotas.

| Protected resource | Default | Exceeded behavior |
| --- | --- | --- |
| Saved conversations / messages | 64 per project / 200 per conversation | Refuse another; preserve existing records. |
| User message / saved record | 16 KiB / 8 MiB | Refuse another message before dispatch. |
| Active turns / retained connections | 4 / 4 | Refuse extra work; evict an idle connection when possible. |
| Idle connection / session setup | 5 minutes / 60 seconds | Close idle transport; setup timeout fails without sending a prompt. |
| Native steps / turn wall time | 64 / 30 minutes | Native step-limit result, or cancellation followed by confirmed/unknown outcome. |
| Stdout and stderr / NDJSON line | 32 MiB per turn / 4 MiB | Close transport; retain received output and uncertainty. |
| Retained text block / turn content | 64 KiB / 256 KiB | Mark cut text; count omitted updates; do not grow the record. |
| Native permission requests | 32 per turn, within turn byte budget | Decline additional requests; keep prior choices. |
| Cancellation acknowledgement | 5 seconds | Close the owned connection; report unknown unless the prompt confirmed cancellation. |

The real episode increases only cancellation grace to 15 seconds and reduces turn
wall time to three minutes and native steps to 16. No arbitrary Agent server,
remote ACP transport, other native client, Linux installation, session migration,
scientific validity or signed release is accepted by these checks.
