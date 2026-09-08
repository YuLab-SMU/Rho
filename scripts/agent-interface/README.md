# Real external Agent acceptance

This is test tooling. Rho owns no Agent harness, prompts, grading logic or behavior loop.
The executable starts disposable real Rho Workbenches, native Ark/R sessions and isolated
Chrome contexts, then invokes an independent real Codex session for each task. Scientific
fixtures, private answers, transcripts and the Agent working directory are separate.

Prerequisites are supplied, never installed or built by this test:

- Current committed Rho binary and embedded client assets; compatible Ark and R.
- Chrome and the repository's existing `ui/node_modules/@playwright/test`.
- Authenticated `/Users/xiayh/.npm-global/bin/codex`, exactly `codex-cli 0.153.4`.
- Model `gpt-6-astra`, reasoning `high`. There is no fallback model or fake Agent.

```sh
node scripts/test-agent-interface.mjs --self-test
node scripts/test-agent-interface.mjs --binary /absolute/rho --ark /absolute/ark --r-home /absolute/R --filter discovery --runs 1
node scripts/test-agent-interface.mjs --binary /absolute/rho --ark /absolute/ark --r-home /absolute/R --final
```

`--final` requires a clean committed tree. It runs all ten core categories three times
(30 fresh sessions), a native/Rho standard Skill pair, and two adaptive method tasks
(34 sessions total). A failure is retained and never replaced with a selected retry.
Filters and smaller repetition counts are debug results, not final acceptance. Each
invocation creates a new artifact directory under `target/agent-interface/acceptance`.

| Category | Independent evidence and assertions |
| --- | --- |
| Discovery | Real project/session/module/window observations and project note |
| Large objects | 1,215 bindings; actual page beyond object 1,001; table row 1,307 and column 63 |
| Deep values | Deep list, long Unicode tail, NA/NaN/infinities, unforced active binding/promise, unsupported methods stay uncalled |
| File search/change | Unicode and CRLF byte positions, long line, real concurrent file replacement and stale-read rejection |
| Package copies | Temporary copies of installed stats with distinct DESCRIPTION provenance; static NAMESPACE evidence and explicit help, no install |
| Selected draft | Two live windows; exact selected window, unsaved content, selection and disk distinguished |
| Concurrent edit/save | Real user edit invalidates Agent capture, plus user text during native save response; disk and dirty draft verified separately |
| Analysis/queue/input/cancel | Real pending stdin, ordinary queued work once, slow task cancellation, native mean calculation and terminal verification |
| Image/crop | Real R two-panel figure, native MCP ImageContent, actual crop, exact small visual label and producing operation |
| Recovery/disconnect | Original failed and unacknowledged operations, actually expired object reference, browser closed after Host save before response; run remains unsubmitted |
| Native/Rho Skill equivalence | Byte-identical standard SKILL.md and referenced method, actual Codex discovery and Rho reads, matching native analysis results |
| Adaptive methods | New standard Skill plus unseen data; actual disabled original method with an available alternative, without Rho core changes |

The Agent receives a natural task and an output shape, never answers or a tool sequence.
A transparent HTTP proxy records actual Rho MCP traffic, preserves native images as
separate binary artifacts, and counts tool/resource calls and UTF-8 textual replies.
The proxy does not implement capabilities or synthesize scientific responses. Fixture
faults modify real files/browser state or drop a real response after execution.

Each task is limited to 80 calls, 1 MiB textual tool returns and ten minutes. The raw
Codex JSONL and MCP transcript survive failure, timeout and budget exhaustion. Actual
input, cached input, cache-write input, output and reasoning token fields come from
Codex usage events; missing required usage fails the run. Images have separate byte and
SHA-256 accounting. Scientific records are reread from the real owner to assert actor,
principal and idempotency identities, including browser-mediated saves.

The Agent cannot use shell, web, other MCP providers or filesystem scientific-data
reads. Read-only tasks cannot execute R. Native Skill equivalence permits only exact
literal reads of the supplied standard Skill resources; scientific data/actions still
use Rho. All other discovered Skills are disabled with process-local config overrides.
The native manifest is built from actual `codex app-server` `skills/list` output,
including its actual enablement state. No product directories are scanned for methods.

Launch and bridge tokens are never put in tracked files. Temporary launch URL files
have private permissions; browser traces scrub bridge credentials, and MCP recordings
omit authorization headers. User Hosts, user configuration and standard Skills are not
modified. Only disposable fixture Hosts are stopped. `--keep-fixtures` preserves their
private directories for debugging; otherwise they are removed after evidence capture.

CLI behavior/configuration was verified against installed help and official documents:
[non-interactive mode](https://developers.openai.com/codex/noninteractive),
[configuration reference](https://developers.openai.com/codex/config-reference), and
[Codex native Skill protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs).
