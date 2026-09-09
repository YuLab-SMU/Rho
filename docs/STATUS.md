# Rho: current state and focus

Updated: 2026-09-09. This is the single current status summary. Git retains history.

## Current work: daily Codex connection

The user approved the revised
[Paper settings design](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/5-0)
on 2026-09-09. Studio now opens the implemented settings page from **Agents** or
**Session → Agent Settings…**. Codex expands in place, with current project/window
context, a masked configuration preview, explicit clipboard copy and a read-only
connection-check prompt. Another agent exposes generic MCP connection details.
Connections shows real Host session observations and scoped window response times;
setup copying is never displayed as a successful connection.

The page preserves the mounted editor, drafts, undo and native R session. Existing
Editor/R controls are shared with the original runtime dialog. Only visible Agent
settings request connection observations through the existing coordinator; stale
or mismatched scope disables copying. Private configuration never enters a model
snapshot, DOM preview or persistent application state. Codex user configuration
remains unchanged; the first connection requires pasting its generated block into
Codex user settings and reloading that client's MCP connection.

A local experience project is available at `target/experience/agent-playground`.
It contains the fixed 1,704-row Gapminder CSV, attribution and `01_explore.R`, a
base-R analysis producing a 142-country view, continent summary and scatter plot.
The example was run successfully through Studio. Inspect live ownership before
starting another Host for this project; private launch/runtime files remain in
the ignored experience runtime directory.

Current UI verification: **278/278 unit tests and 27/27 isolated Chrome cases
passed** against the current built binary and assets. The new case covers actual
MCP initialization, overview/window queries, private clipboard contents versus
masked DOM, false-connection prevention, read-failure recovery, protocol closure,
current window incarnation, preserved drafts/undo and unchanged R session/operation
checkpoint. Normal (1440 × 900), wide (1920 × 1080), constrained (768 × 760), setup
and connection screenshots were inspected under `target/studio-browser/agents-*`.
Rust-generated types, frontend build/check and `cargo build --locked` passed, as did
architecture, frontend boundaries, their 24 fixtures, governance and diff checks.

The independent backend now exposes authenticated `GET /api/agent-connection`.
It returns the current endpoint and bounded MCP session observations, including
client-reported labels, initialization/closure and successful overview/live-window
response times. It stores no tokens, conversation or scientific results. Records
belong to the selected Host and reset on replacement; an open protocol session is
not proof of an active Agent task. Existing caller identities and scientific ports
are preserved. Codex user configuration has not been changed.

The unchanged connection backend was verified in `8ec6b62`: MCP 9 tests,
Workbench 8 tests, affected Clippy/format checks, and real HTTP/MCP tests both with
and without the explicit real-R option passed. Those checks cover initialization,
scoped response observations, credential exclusion, query purity, closure, Host
replacement and disconnected-work handling. No new model-based Codex acceptance
was run for this UI change; the frozen acceptance below remains separate.

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
