# CRED-REVEAL-1A Connection-Test Credential Redaction Repair

Status: active implementation handoff; implementation, automated verification,
and independent R3 review completed on 2026-08-26; owner checkpoint acceptance
remains separate. Explicitly authorized by the owner's `开始施工` instruction.
This package stops here. CRED-REVEAL-1B is not active.

Date: 2026-08-26

Change class: D1 because this is an isolated repair of an existing secret-
egress defect and adds no command, schema, source, UI, network, or runtime
authority

Risk: R3 because an Agent Provider credential can currently cross a Rust/Tauri
error boundary in plaintext

Parent direction:
`proposed-2026-08-26-plugin-native-settings-experience-design-spec.md`

## 1. Reproduction And Defect Boundary

The selected Provider's credential is injected into the connection-test R
child as one environment variable. When that child exits unsuccessfully,
`desktop/src-tauri/src/agent_llm.rs::run_r_json` currently interpolates the
entire captured stderr into an `anyhow` error. The
`agent_llm_test_model` command then maps that error through `display_error`,
which is a plain `to_string()`, into the Tauri rejection returned to its caller.

Therefore an R failure that writes the injected credential to stderr can return
that credential across the command boundary. A future Settings caller would
only truncate the text; truncation is not redaction.

A second trust boundary exists after a successful child exit: the structured
`AgentConnectionTestResponse.message` originates in the R probe. R currently
redacts known values, but Rust must not persist or return an unbounded provider
error message on the assumption that the upstream implementation always did so.

## 2. Invariants

1. A connection-test child diagnostic never crosses into a service error,
   Tauri rejection, settings view, `last_test`, frontend feedback, log, audit,
   mock, or screenshot in raw form.
2. The Rust boundary emits stable, bounded, non-secret connection-test error
   copy. It does not expose a credential prefix, suffix, length, recognizable
   fragment, encoded variant, or surrounding raw diagnostic.
3. A parsed connection-test failure is projected from its bounded error class,
   not from arbitrary provider message text. Success copy remains fixed.
4. stdout and stderr capture are bounded in memory while the child pipes are
   still drained to completion, preventing deadlock and unbounded diagnostic
   allocation. Captured buffers that may contain a secret are cleared when
   released.
5. Before launch, every R probe removes inherited environment variables matched
   by the existing `rho_kernel::is_sensitive_environment_name` predicate. A
   connection test additionally removes the deduplicated `api_key_env` and
   `base_url_env` names from every Provider in the same validated settings
   snapshot, including custom names, and only then re-adds the selected
   Provider's required endpoint value and credential already resolved through
   its exact configured source. A keyless/catalog probe injects no credential.
6. Pre-launch credential/source rejection and process, protocol, setup, pipe,
   wait, or cleanup failure do not write a new `last_test`, advance settings
   revision, mutate settings bytes, scan another Provider, or fall back to
   another credential source. A syntactically and semantically valid normalized
   Provider failure response retains the existing fixed-copy `last_test`
   behavior required by verification item 4.
7. Success, cancellation, timeout, stale-settings rejection, selected-Provider
   resolution, and credential-free catalog behavior retain their existing
   authority.
8. After spawn, every early-return path terminates and reaps the child and
   clears its test-control PID/cancellation state. A credential-bearing child
   never survives a setup, pipe, lock, wait, or reader failure.

## 3. Authorized Implementation

The package may change only the Agent LLM service boundary, its existing Tauri
command adapter, and their tests. The adapter may pass the existing runtime
`data_dir` into the existing catalog service call solely so that the validated
Settings snapshot can supply the complete custom Provider environment-name
scrub list; this does not change the command name, arguments, result, binding,
network behavior, or authority.

Within that boundary, the package may:

- give R JSON probes an explicit diagnostic-disclosure policy;
- use a connection-test policy that discards raw child stderr and returns one
  stable generic process-failure message;
- retain at most 1,048,576 stdout bytes and 65,536 stderr bytes while continuing
  to drain both pipes; stdout byte 1,048,577 rejects the response, while stderr
  byte 65,537 sets an internal truncation flag that is never returned across
  IPC; no retained or truncated diagnostic body is serialized;
- mirror the Agent execution environment boundary by removing all inherited
  sensitive names and all configured Provider credential/endpoint environment
  names before adding back only the selected Provider values required by the
  probe;
- normalize a parsed connection-test message to reviewed fixed copy selected
  from the existing bounded error-class vocabulary;
- when a normalized probe capability remains `unknown`, persist that unchanged
  value with the existing validator-required `unknown` provenance rather than
  the invalid `provider_response` provenance; this only makes the existing
  failure/recovery write valid and does not alter a capability value, route,
  model choice, or fallback;
- preallocate each bounded capture buffer once inside a zeroizing owner so Vec
  growth cannot release uncleared prior allocations; deserialize the arbitrary
  upstream `message` as `IgnoredAny` so it is never materialized, while keeping
  the bounded vocabulary fields in redacted, zeroizing string owners; and
- isolate the child and its descendants in a Unix process group or Windows Job
  Object; Windows creates the root suspended, assigns it to the configured Job,
  and only then resumes its primary thread so no credential-bearing descendant
  can escape before assignment; bound pipe-thread joins, and guard the process
  tree plus test-control state with fail-safe cleanup until normal exit or
  explicit cancellation has been reaped; and
- add deterministic process, structured-response, bounds, and state-preservation
  regressions.

Connection-test process/protocol failures use these exact messages:

| Failure | Fixed message |
| --- | --- |
| spawn/setup/pipe/read/wait/cleanup failure or child non-zero exit | `Rho could not complete the Provider connection test.` |
| oversized/invalid structured response | `Rho received an invalid Provider connection-test response.` |

For a valid structured response, `error_class` is allowlisted to
`credential | timeout | endpoint | network | provider`; blank or unknown maps
to `provider`. Arbitrary R/provider `message` is discarded and replaced exactly
as follows:

| `error_class` | Fixed message |
| --- | --- |
| `credential` | `The Provider rejected the configured credential.` |
| `timeout` | `The Provider connection test timed out.` |
| `endpoint` | `The Provider endpoint or model configuration was rejected.` |
| `network` | `Rho could not reach the Provider.` |
| `provider`, blank, or unknown | `The Provider connection test failed.` |

A ready response always uses `Connection succeeded.`. Unknown status,
credential-status, or capability vocabulary fails with the fixed invalid-
response message and never includes the rejected value.

The package does not add or change a Provider request, API-key source, store
read, audit event, generated binding, browser mock, Settings screen, model
selection policy, or route authority.

## 4. Explicitly Forbidden In 1A

- `View API key` UI, including hidden, disabled, or feature-flagged forms;
- a secret-returning Tauri command, generated binding, mock, or frontend field;
- a keyring getter for presentation, OS user verification, native presenter,
  reveal authorization grant, credential-generation lock, or reveal audit;
- changing the current no-redisplay rule;
- automatic Provider/model selection, route migration, or the Providers-first
  Settings successor; and
- version, candidate, installer, signing, publication, or release work.

## 5. Deterministic Verification

Focused Rust regression evidence must include:

1. an injected fake child that receives a known sentinel credential, writes it
   and identifying surrounding text to stderr, exits non-zero, and proves the
   service/Tauri-facing error contains neither the sentinel, its fragments, nor
   the raw diagnostic;
2. empty, multiline, invalid-UTF-8, boundary-size, and oversized stderr cases
   returning the same bounded non-secret result;
3. bounded pipe capture that keeps draining after the retained byte limit and
   rejects oversized stdout without including its content;
4. structured failure messages containing the sentinel and arbitrary long text
   projecting only reviewed fixed copy; serialized settings/test results contain
   no sentinel;
5. failure preserving the exact settings bytes, revision, and previous test
   truth;
6. unknown/missing/source-failure rejection before child launch, selected-
   Provider exactly-one credential read, two-Provider isolation, and no source
   fallback; an A/B Provider fixture proves the child sees only the selected
   credential/endpoint sentinels while the other Provider and unrelated
   inherited sensitive names are absent;
7. a real catalog child loads the same validated runtime Settings snapshot,
   receives no credential override, removes both custom Provider credential and
   endpoint environment names plus common sensitive names, preserves an
   ordinary non-sensitive environment value, and receives exactly the normal
   two R arguments (`--vanilla` and the generated script path); and
8. injected post-spawn setup/reader/wait failures terminate and reap the child,
   clear test-control state, permit an immediate retry, and assert against the
   observed OS process identity that the root no longer survives; the
   descendant fixture likewise records its PID and proves it is no longer
   alive before the bounded assertion deadline; and
9. adjacent success JSON decoding, cancellation, timeout, and credential-free
   catalog probe regressions remaining green.

After focused tests pass, freeze the source snapshot and run the complete
affected Rust and RSR validation matrix required by development governance,
plus `git diff --check`. An R3 reviewer independent of implementation must
confirm there is no raw child diagnostic egress and no 1B code.

## 6. Version, Documentation, And Stop

This checkpoint fixes an internal secret-redaction boundary and introduces no
new user-facing surface or development candidate. The package records a
no-version/no-`NEWS.md` decision. Any later candidate or visible Settings
implementation makes its own synchronized version and changelog decision.

When verification and post-test review pass, update this handoff with exact
evidence and stop. CRED-REVEAL-1B requires separate owner acceptance, active
CRED-UX/CRED-SEC amendments that authorize native reveal, and a new active
implementation boundary.

## 7. Implementation And Verification Evidence

Implemented facts:

- the connection-test boundary now suppresses raw child diagnostics, bounds and
  drains both pipes, projects structured results through fixed copy, removes
  every configured Provider credential/endpoint environment name, and only
  restores the selected Provider values;
- pre-launch credential/source failures do not mutate Settings, and the
  configured source has no fallback;
- post-spawn failures terminate and reap the root and descendants, recover the
  test-control state, and permit a proven successful retry;
- Unix uses a dedicated process group; Windows uses suspended creation followed
  by Job assignment and primary-thread resume; and
- no reveal getter, IPC command, generated binding, mock, Settings UI, schema,
  model-selection authority, version metadata, or `NEWS.md` change was added.

Verification completed on 2026-08-26:

- `cargo test -p rho-desktop agent_llm::tests:: -- --nocapture`: 77 passed,
  2 explicitly ignored fixture/smoke tests, 0 failed;
- `cargo test -p rho-desktop`: 411 passed, 23 explicitly ignored generated or
  opt-in tests, 0 failed;
- `cargo check --locked --target x86_64-pc-windows-gnu -p rho-desktop --tests`:
  passed; and
- `cargo test --locked --target x86_64-pc-windows-gnu -p rho-desktop --no-run`:
  passed and linked the Windows test executable;
- `npm --prefix desktop run rsr:check:resume:stable`: passed the full final
  matrix, including 51 UI test files / 329 tests, production build, generated
  contracts, browser smoke, real interactions, checkpoint/lane tests, visual
  acceptance harness tests, and `git diff --check`;
- two independent R3 reviews found no remaining blocker and confirmed that the
  diff contains no CRED-REVEAL-1B implementation.

Residual evidence boundaries are explicit: the Windows code was cross-checked
and linked on macOS but the process-tree fixtures were not executed on a real
Windows host; the catalog end-to-end scrub/argument fixture is Unix-only. The
existing Windows cancellation path still asks `taskkill` to stop the recorded
PID before the worker-owned Job guard performs final cleanup, leaving a
theoretical PID-reuse race. These do not broaden authority or expose a secret
in this checkpoint, but remain bounded follow-up verification/hardening items.

Version decision: no application version or `NEWS.md` update. This is an
internal security prerequisite with no newly available user-facing behavior.
