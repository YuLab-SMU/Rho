# Rho: current state and focus

Updated: 2026-09-09. This is the single current status summary. Git retains history.

## Current work: native Codex, Kimi and DeepSeek Harness

Studio's approved [Agent settings design](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/5-0)
now supports Codex app-server, Kimi ACP and DeepSeek Harness ACP. The cards expose
native model/reasoning choices, connect the current project and Studio window,
and accept user tasks without configuration or prompt copying. They show native
responses, tool activity, permissions, uncertainty and disconnected-session evidence.
Manual MCP setup remains an advanced option. Rho does not add an Agent behavior loop.

DeepSeek's installed user launcher was `0.1.1-rc.2`, which lacks ACP. **Install
connection component** adds isolated official DSH/ACP packages pinned at
`0.1.2-alpha.2` under Rho's application-data directory. It does not upgrade the
user launcher or install during discovery. Each native launch copies only bounded
`settings.yaml` and `.credentials.yaml` files into a private temporary home. This
allows the newer native credential provider to convert its own copy without
changing the original. Temporary copies are removed on close or cancellation;
native conversation/attachment storage remains in a versioned component data area.
Other products' profiles and `.env` files are not copied.

Three-provider discovery is serialized and does not retry indefinitely. DeepSeek
can publish configured providers after its first session response; a bounded
750 ms startup collection retains native `config_option_update` notifications
even before a visible session exists. A separate keyless Host probe after this
fix returned all 64 models in 1.80 s, including the configured 115 NewAPI model. Setup is
explicit, has a three-minute installation deadline, and survives a lost HTTP
acknowledgement through owned, idempotent installation. DeepSeek's grouped model
options retain their opaque IDs while the UI displays native names. Permission
frames that contain only a tool-call ID are associated with that native call's
observed title/input. Tool activity separates progress speech from a subsequent
assistant response without dropping either message.

Current verification:

- Native Agent client: **14 Rust tests**; Workbench: **11 Rust tests**; frontend:
  **288 unit tests**. Typecheck, generated bindings/assets, current binary, strict
  affected Clippy/format, architecture and frontend ownership checks passed.
- The focused Chrome Agent settings cases passed **2/2**, covering manual fallback
  and all three native providers, explicit component setup, models/reasoning,
  Test, native permission choices, direct tasks, disconnection, window scope and
  zero clipboard setup. Normal and 600 px constrained DeepSeek setup/conversation
  screenshots were inspected under `target/studio-browser/agents-native-*`.
- First real DeepSeek run installed the component in 68.8 s, advertised 64 native
  model choices, connected in 2.27 s and returned `ok` in 7.16 s using
  `115-newapi/deepseek-v4-flash`. It then actually read the Rho overview and returned
  the correct directory name. Its initial assertion failed because progress speech
  and the final answer were concatenated. The protocol view and smoke test now
  preserve that tool boundary. The final real trial **passed**: 2.10 s connection,
  16.06 s `ok` response, and a verified native MCP overview with correct project
  name in 27.40 s. Duplicate requests did not replay. Original native settings
  and credential hashes were unchanged. Both logs are retained at
  `target/agent-integration/deepseek-native-acceptance.log` and
  `target/agent-integration/deepseek-native-final.log`.

The earlier Codex live test (`gpt-6-astra`) connected in 1.49 s and replied `ok`
in 4.61 s. Earlier Kimi tests established native MCP delivery, but the configured
DeepSeek service also returned an incomplete long path and timed out on another
read-only task. Those failures remain in `target/agent-integration/native-acceptance*`;
full Kimi model acceptance is not passed and has not been silently retried here.
Model/provider response quality remains distinct from protocol delivery and from
the frozen scientific acceptance below.

Kimi 0.41.0 startup exposed another MCP interoperability issue: generated Rust
numeric-width formats caused Ajv warnings to overwrite the terminal UI. The MCP
edge now omits these annotations from every input/output tool schema, including
fixed aliases; it preserves constraints, literal data and original Host contracts.
Verification passed: 11 MCP Rust tests, strict MCP Clippy, stdio MCP regression
with and without real R, architecture and documentation-map checks. A keyless
native Kimi ACP startup reproduced 1,224 warnings from the existing 64-tool live
catalog and zero from the fixed 36-tool project-only catalog; independent Ajv
compilation likewise changed from 1,396 warnings to zero. Real-R regression also
checks all advertised schemas. No model prompt was sent. Evidence is under
`target/agent-integration/kimi-schema-*`; the rebuilt binary is ready for future
Host launches. Existing Hosts and their R memory/paused work remain unchanged.
The running playground still serves the old schemas, so rebuilding alone did not
fix normal Kimi startup. The stale global `rho` MCP entry is now disabled in place
with `enabled: false`; its URL, credential and other fields remain in the original
private Kimi user configuration. No credential was copied into a project. Actual
Kimi TUI startup in the user's original working directory reproduced hundreds of
warnings before this change and zero afterwards; `/mcp` confirms `rho disabled`.
`kimi doctor` passes. A separate managed-provider refresh service error remains;
the user's selected model configuration is unchanged and no model task was sent.
Evidence is `target/agent-integration/kimi-terminal-activation.json`. This is an
operational mitigation: Rho tools are unavailable through that disabled global
entry. Re-enable it only after the corresponding Host runs the fixed binary;
replacement requires checking its current work and restart authorization.

Existing `target/experience/agent-playground`, `agent-direct-playground` and
`agent-harness-playground` Hosts and R memory are preserved. Automatic approval
rejected restarting the last instance because it already contained sample R
objects; that restart did not run. A new independent `target/experience/deepseek-ready`
project hosts the final build with the configured DeepSeek Harness model selected.
Its sample data and script are available; existing R objects remain in the earlier
instances. Private launch/runtime directories remain next to
the projects. Inspect current process and work ownership before any replacement.

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
