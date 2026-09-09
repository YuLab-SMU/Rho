# Rho: current state and focus

Updated: 2026-09-09. This is the single current status summary. Git retains history.

## Current work: direct native Agent use

The user approved the revised [Paper settings design](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/5-0)
on 2026-09-09, then reported that manual configuration and two clipboard steps
made actual Kimi setup too slow. Studio now offers direct Codex app-server and
Kimi ACP connections in that settings surface. It reads native model/reasoning
choices, supplies the current project/window and Rho MCP connection, and accepts
user tasks with streamed responses and native permission choices. **Test** connects
and requests a minimal response. **Advanced: manual MCP setup** remains available
for other clients. No CLI user configuration is edited.

Rho is a native protocol client, not an Agent behavior loop. The CLI owns login,
provider execution, conversation history and permission semantics. Model discovery
does not submit a model task, and a listed model is not evidence that its account
or quota is usable. The live conversation display is bounded; scientific actions
still return through the shared MCP/Host owners. Window/project fencing and request
identities protect against stale views and duplicate submissions after lost HTTP
acknowledgements. Native uncertainty remains explicit.

The rescue review found an automatic model-discovery retry after every failed
poll, historical connections exhausting the active-session budget, and native
setup depending on the lifetime of one HTTP request. These are fixed with
bounded discovery, explicit rescan, active-session accounting and owned setup
completion. Closed native transports retain their diagnostic and session identity
without being reused. The frozen scientific acceptance below is unchanged.

The original local experience project at `target/experience/agent-playground`
contains the fixed 1,704-row Gapminder CSV, attribution and `01_explore.R`. Its
base-R analysis produced a 142-country view, continent summary and scatter plot.
The original live Host and R memory have been preserved. Inspect live ownership
before starting or replacing a Host for this project; private runtime files stay
in the ignored experience runtime directory.

Current verification:

- Native Agent client: 7 Rust tests; Workbench: 10 Rust tests. Protocol fixtures
  cover permission decisions, reply streaming, credential redaction, output bounds,
  repeated model cursors, timeout uncertainty, closed transports, active capacity
  and setup surviving a lost HTTP waiter.
- Frontend: 284 unit tests, typecheck and 24 boundary fixtures passed. The complete
  Chrome run passed 27 existing cases; the new native case initially exposed a
  macOS canonical-path mismatch in its fixture. After using the Host's real root,
  that case passed separately, covering all 28 cases. It verifies native model and
  reasoning selection, Test, direct tasks, streaming, permission choices,
  disconnection and zero clipboard steps. Normal and 600 px constrained screenshots
  under `target/studio-browser/native-agents-*` were inspected.
- Generated contracts, embedded assets, `cargo build --locked`, affected strict
  Clippy/format, architecture, governance and Agent harness self-tests passed.
  Real Workbench and MCP scripts with `--real-r` passed. An initial non-escalated
  MCP invocation could not bind loopback (`EPERM`); the authorized run passed.
- Explicitly authorized live tests used Codex `gpt-6-astra` and Kimi's configured
  `115-newapi/deepseek-v4-flash`, only in disposable projects. Codex advertised six
  native models, connected in 1.49 s and replied `ok` in 4.61 s. Kimi advertised
  85 native choices, connected in 2.64–2.66 s and replied `ok` in 31–44 s in the
  final runs. This provider latency is separate from local setup. Duplicate test
  request identities did not replay the model task; user configuration hashes
  remained unchanged in both completed runs.

The first exact long-path answer assertion failed. Native Kimi history contains
that same shortened answer even though its MCP tool result contains the full
correct path and the provider reports `end_turn`. Rho did not lose reply chunks.
This remains a model-answer failure, not a successful scientific conclusion; no
adapter reconstructs the missing text. Its log remains in
`target/agent-integration/native-acceptance.log`. The reproducible native transport
smoke script now requests the short directory name while still requiring a new
observed MCP overview read. That Kimi rerun returned `ok`, then reached the
120-second MCP-task deadline after the native permission response; it stopped
without retry and cleaned up its temporary processes. The result is retained in
`target/agent-integration/native-acceptance-kimi-short.log`. Full Kimi model-based
acceptance is therefore **not passed**. Native connection and real MCP delivery
are established, but this configured model's complete response remains unreliable.
No further provider retries are scheduled. Scientific reasoning acceptance remains
separate from these connection checks.

A new independent project, `target/experience/agent-direct-playground`, is open
with the native connection UI. Its sample script was run through Studio, producing
Gapminder objects and a plot. Kimi is connected to that window with the user's
selected DeepSeek model, ready for a task. Runtime ownership and private launch
material stay in `target/experience/agent-direct-playground-runtime`; inspect it
before any replacement. The original experience Host and R memory were not restarted.

## Agent interface acceptance baseline

The Agent interface and standard Skills delivery is implemented and verified.
The frozen runtime/harness acceptance version is
`4bcd30903b55568844b20fb93589294b1a8c5f9d`. Evidence-packaging changes through
`a3f08a6` did not change that verified scientific runtime, client assets or
acceptance harness. The connection work above extends the current transport;
the frozen acceptance remains evidence for its recorded baseline only.

Shared Host discovery, concrete capability/result/recovery contracts, diagnostics
and read navigation cover the existing scientific owners. Objects and text use
bounded version-bound reads; package indexes bind exact installed copies; help
renders once from the selected database into retained text. Output reads share
verified originals, bounded native image previews, crops and resource chunks.

Application owns window identities, synchronized drafts/context, CAS receipts and
immutable scientific captures. The resident Studio bridge preserves concurrent
input and startup view choices. Saving/running retains the original caller through
the existing OperationGateway. Standalone CLI queries do not start R, acquire a
writer lease or recover operations; connected CLI requests use the existing Host.

Standard `.agents/skills` and launcher-attested native sources retain their original
resource bytes, enablement and source identities. Read receipts and explicit method
bindings are application metadata. Skills do not grant authority or run an Agent
loop. Native queries do not reload deliberately unloaded inspection/JSON providers.

## Verified evidence

- Rust workspace: 199 default tests passed. All seven separately enabled real-R
  and Environment tests passed through the native verification scripts; none was
  counted as passed while ignored. Strict whole-workspace Clippy passed.
- Frontend: 270 tests and 24 ownership/boundary fixtures passed. Generated DTOs,
  embedded assets and the current binary were checked together.
- Chrome: all 26 cases passed. Normal, wide and constrained screenshots were
  inspected. The fixed Gapminder load case measured typing p95 34.4 ms and frame
  p95 16.8 ms; additional views did not duplicate shared reads.
- Real Workbench/MCP, exact help, native image/resources, pak/renv realization,
  installer cancellation, retention/quarantine/restore/purge, lost-commit recovery,
  restart binding, CLI connection/query purity, process recovery, local SSH/Slurm
  protocol fixtures, architecture/governance and Jet checks passed. The original
  user R library was unchanged. No live remote-cluster acceptance is claimed.
- Independent Codex: **30/30 core runs and 4/4 Skills/adaptation runs passed**, with
  zero violations/failures, exact native/Rho method equivalence, and unchanged
  source/binary hashes. Model `gpt-6-astra`, reasoning `high`, Codex 0.153.4.
  Each run stayed within 80 calls, 1 MiB text and ten minutes. Maximum observed:
  30 calls, 524,698 text bytes and 197,407 ms. Images were metered separately.

The formal run retained 614 hashed artifacts (58,627,766 bytes) and took 16m55s
with three independent workers. Totals: 382 model tool attempts, 380 matched MCP
deliveries, 4,060,795 text bytes and 136,584 image bytes. Actual usage fields:
10,820,205 input tokens; 9,443,328 cached input; 46,945 output; 1,822 reasoning output.

The authoritative formal result is
`target/agent-interface/acceptance/4bcd30903b55-1788916155502-8ec26ea9/manifest.json`.
It records `acceptance=true`, `passed=true`, `fixed_tree=true`, all 34 results,
resource equivalence, original operation identities and the artifact inventory.
All earlier failed attempts remain under `target/agent-interface/acceptance`.
Command logs are under `target/agent-interface`; visual reviews are under
`target/studio-browser`. The evidence packer preserves originals, includes failed
attempts, sanitizes credentials in text/nested traces and records source/archive
hashes. Its tests and CI mapping are separate from scientific acceptance.

Frozen acceptance binary SHA256:
`c1b0157931004efa6af2fd76f8b9c6eab2f58bb08211877d8ce67a074f2dad91`.

## Operational boundaries

Existing user Hosts, R memory and configuration were preserved. All acceptance
instances were disposable. No product installation, signing or publication was
performed. Read [Operations](OPERATIONS.md) before starting another Host; inspect
current ownership and processes rather than reusing old PIDs, ports or tokens.
All Cargo invocations remain serial; build and verify from the integration checkout.

Native session evidence covers the managed fork/exec helper family. Unobservable
same-family processes and missing original evidence stay protected; independent
service-manager jobs and rollback of arbitrary external effects are not implied.

The approved Packages interaction remains in
[Paper](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0).
Multiple runtimes/R-version switching, plugin execution, package-management UI,
abandoned-data migration, product installation and publication remain deferred.
The external acceptance runner is test tooling, not a product Agent behavior loop.
