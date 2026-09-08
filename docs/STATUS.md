# Rho: current state and focus

Updated: 2026-09-08. This is the single current status summary. Git retains history.

## Current delivery

The Agent interface and standard Skills integration is being implemented against
baseline `fce14b29bc6e5c79af79ea7b942342ac2fa3e7f2`. This delivery is **in progress**;
component tests below do not establish full browser or independent-Agent acceptance.
The user authorized staged gpt-6-astra subagents, isolated acceptance instances and
commits. Existing user Hosts, R memory, installation and publication are untouched.

The integration contains shared overview/catalog/describe queries, concrete
capability payload schemas and diagnostics; version-bound object and file readers;
static package indexes and retained help text; shared verified originals and MCP
native image/resources; an Application owner, SQLite CAS receipts and a resident
Studio bridge; standard/local and launcher-attested Skill sources and explicit
method bindings. Operation result/recovery validation and original-record reads
are being hardened before final verification. Source presence is not acceptance.

Application commands retain explicit window/incarnation/resource identities.
Scientific captures preserve original Agent identity through the existing gateway.
An unchanged empty-file Save uses a Project digest observation and a verification
receipt with no invented OperationId. Environment configuration/tool observations
are established by explicit startup/operations; subsequent queries use those
stamped observations and bounded current static metadata. Retention inspection
reads native process markers without starting R or signalling processes.

## Executed checks in this delivery

- Pre-change Rust workspace default tests and frontend baseline (226 tests) passed.
- Integrated Rust contracts/application/SQLite/Skills checks passed: Application
  16, SQLite 13, shared contract 4 and Skills source 8 tests at that integration
  point. Host Skills integration subsequently passed all three tests.
- Operation registry/gateway hardening passed 14 tests before the latest journal
  evidence extension; that extension still requires its own integration run.
- Direct native R object, static package-index and code-tool scripts passed,
  including 10,001 object bindings and hostile/lazy/active-binding fixtures.
- Frontend lane tests reached 239 passing tests, with frontend boundaries and
  24 boundary fixtures passing. Integration TypeScript checking passed before
  the latest generated-contract changes.
- PNG/JPEG/SVG/crop/text preview content tests passed. The combined media authority
  run exposed a missing output capability description, since corrected; rerun is
  pending. A new native process-marker inspection fixture failed to observe its
  child immediately; diagnosis is pending and it is not counted as passed.
- Rust whole-workspace type checking and one client generate/build cycle passed
  at intermediate integration points. The following client check correctly
  rejected stale ObjectReadPage bindings after root identity fields were added.
  Final generate/build/check and whole-tree checks remain required.
- Exact local Codex `/Users/xiayh/.npm-global/bin/codex` 0.153.4 preflight with
  gpt-6-astra/high succeeded. The independent-Agent harness self-tests and native
  Skill discovery checks passed; no model task acceptance is claimed yet.

Logs and the detailed local working plan are under `target/agent-interface/`.
The acceptance runner retains all attempts, counters, actual token usage and
artifacts; final acceptance requires 30 core runs plus four Skill/adaptation runs
on one clean fixed version. Skipped prerequisites and failed attempts are not passes.

## Remaining verification and resume

Finish source/permission/pagination reviews and integration fixes, update generated
DTOs/assets, then run the affected and full Rust, frontend, governance, dependency,
Jet, real-R, Environment, process/remote-protocol, Workbench/MCP and Chrome checks.
Run the complete independent Codex suite on the final fixed tree and preserve its
manifest and all failed attempts. Architecture and operator documentation must be
updated to the actual delivered protocol before final acceptance is declared.

All Cargo invocations, including generation and script-internal builds, are serial.
Build the current `target/debug/rho` before browser/native transport acceptance.
Use disposable projects and inspect live ownership before starting a Host. Do not
reuse an old PID, port or launch token. Existing review material remains at
`target/calm-precision-project` and `target/calm-precision-run/next.sqlite` with its
sibling application store; it is not a destructive test fixture.

The approved Packages interaction remains in
[Paper](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0).
Current scope remains one local R session. Multiple runtimes/R-version switching,
plugin execution, package-management UI, abandoned-data migration, product
installation and publication remain deferred. The new acceptance harness is test
tooling, not a product Agent behavior loop.
