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

The application assembly included both ACP packages but failed its existing
no-project-recipe check on `fixtures/base-r-airquality/analysis.R` (introduced before
this change). `work/acp-assembly.log` and the unaccepted stage are retained. No
installed full-application or binary delivery acceptance is claimed; repairing that
earlier fixture/packaging mismatch remains separate from ACP source acceptance.

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
