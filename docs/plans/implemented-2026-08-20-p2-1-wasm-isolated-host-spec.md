# P2-1 Wasm Isolated Plugin Host

Status: implemented and accepted for Phase 2 integration; implementation,
source verification, exact Rust 1.88 evidence, independent security review,
and three-platform hosted/package acceptance passed through exact-head run
`32456281744` on 2026-08-21

Historical authorization: the project owner explicitly authorized rapid iteration through
the complete Phase 2 end state on 2026-08-20. This authorizes P2-1 through P2-4
in product intent, but the development-governance stop gates remain sequential.
Only P2-1 may change executable-host contracts in this package; P2-2 does not
start until the P2-1 stop gate is reviewed and recorded.

Change class: D3 shared security architecture. Risk: R3 because this package is
the first code path that executes project-owned bytes, even though it exposes
zero privileged capability and is not yet routable from the desktop product.

## Problem And Entry Evidence

Phase 2 currently has manifest/digest/discovery contracts, typed host frames,
grant predicates, contribution/lifecycle state, and adversarial tests, but its
`SyntheticEchoHost` never executes a discovered package. The product therefore
cannot claim an isolated third-party runtime.

Entry conditions are satisfied:

- Phase 1 capability, scope/generation, transactional effect, quiesce/dispose,
  bounded broker, and candidate-CAS semantics are accepted;
- P2-0 manifest schema, package digest, symlink-safe disabled discovery, and
  unfamiliar-project no-execution tests are present;
- the current package permits only `wasm`, `web-worker`, or `declarative`
  runtime declarations and newly discovered plugins remain disabled;
- P2-1 adds no Store schema, grant persistence, permission UI, contribution,
  filesystem/network/Workspace R operation, or automatic enablement.

## Runtime Decision

P2-1 selects an embedded core-WebAssembly profile using exact
`wasmtime 38.0.4`, the current release whose crate metadata declares Rust
`1.88.0`, matching Rho's MSRV. The dependency uses only `std`, `runtime`, and
`cranelift`; default features, WASI, async host functions, component model,
threads, cache, profiling, pooling, WAT parsing, and remote code loading are
excluded from the production build.

Context7's current official Wasmtime documentation establishes the selected
host primitives:

- `Config::consume_fuel` for deterministic guest instruction budgets;
- `StoreLimitsBuilder` for memory/table/instance limits;
- epoch interruption for exact cancellation of a running guest call;
- `Linker` with only explicit imports. P2-1 defines no imports at all, so WASI,
  filesystem, network, process, credential, Tauri, broker, Workspace R, Agent R,
  clock, randomness, and environment access cannot link.

Each plugin instance owns a separate Wasmtime `Engine`, `Store`, `Instance`,
fuel budget, epoch domain, cancellation state, and linear memory. Engines are
not shared because an epoch cancellation must never interrupt another project
or plugin. The Rust host remains trusted; only the Wasm guest is untrusted.

## Guest ABI V1

The module must be a binary core Wasm module, at most 4 MiB, with no imports and
these exact exports:

```text
memory: memory
rho_activate(api_version: i32) -> i32
rho_echo(ptr: i32, len: i32) -> i64
rho_heartbeat() -> i32
rho_quiesce() -> i32
rho_dispose() -> i32
```

Status `0` means success. `rho_echo` returns a packed unsigned `(ptr, len)` in
the high/low 32 bits. The host validates every input/output range against the
current memory and the 16 KiB echo bound before reading. No pointer, guest
message, trap detail, module path, or runtime internal becomes authority.

The host protocol remains `HOST_PROTOCOL_VERSION = 1` and preserves
`hello → activate → echo/heartbeat → quiesce → dispose`. A host-generated
instance ID binds every frame. A broker-owned cancellation handle binds an
exact in-flight request ID, sets a fail-closed cancellation flag, and increments
only that instance engine's epoch.

## Limits And Failure Semantics

- module bytes: 4 MiB maximum before compilation;
- linear memory: 2 MiB maximum, one memory;
- instances: one; tables: one; table elements: 1,024;
- fuel: 1,000,000 units for instantiation and each guest call;
- echo request/response: 16 KiB;
- unknown imports, missing/wrong exports, memory growth, invalid ranges,
  nonzero status, traps, fuel exhaustion, cancellation, and host panic fail
  closed with stable bounded error codes;
- activation failure never becomes active;
- trap, fuel exhaustion, invalid guest output, or in-flight epoch cancellation
  quarantines the instance and clears in-flight identity; a pre-dispatch exact
  cancellation consumes only that request and leaves the instance active;
- dispose drops the Wasm store/instance even if guest finalization traps;
- a quarantined/disposed instance rejects every later frame;
- no fallback executes JavaScript, native code, shell, R, Python, or a different
  package digest.

Compilation/instantiation and calls are bounded by module size, store limits,
fuel, and panic containment. P2-1 does not yet expose the host to the desktop;
P2-4 installed-platform acceptance must prove the same negative probes inside
the packaged application before Phase 2 acceptance.

## Authorization Decisions For Later Packages

The owner's complete-Phase-2 authorization closes the design's open decisions
with these fixed defaults; later packages may implement but not silently widen
them:

1. runtime: Wasm only for executable plugins; declarative Skills remain
   non-executable; Web Worker is deferred;
2. isolation: one Engine/Store/Instance per exact project/plugin/digest/
   generation/host session;
3. package digest: existing canonical lexicographic, length-prefixed SHA-256 and
   current manifest/package bounds remain authoritative;
4. initial events: hello, activate, echo, heartbeat, cancel, quiesce, dispose;
5. P2-2 paths are normalized project-relative globs, network is HTTPS GET/HEAD
   with redirect revalidation, Workspace R is metadata/preview only;
6. grants persist in broker-owned SQLite by exact project/digest/policy revision
   with expiry/revocation and fresh handles; UI wording is trusted-shell owned;
7. Phase 2 has no plugin key/value storage;
8. UI uses host-rendered typed descriptors in named slots, never plugin HTML or
   a sandboxed frame;
9. host protocol V1 fixtures are owned by `rho-extension-runtime` and CI;
10. every supported platform must pass no-import, WASI rejection, fuel,
    cancellation, trap, memory, two-project, and packaged-app probes;
11. packages are manually placed under `.rho/plugins`; no install/update client
    or marketplace exists in Phase 2;
12. write, process, arbitrary R, Provider/runtime, credential, native, and
    fetched-code permissions remain forbidden and require a future design.

## Scope And Non-goals

P2-1 delivers the Wasm host implementation and deterministic source tests. It
does not add enable/install UI, persistent grants, read-only broker operations,
contributions, plugin storage, schema, desktop routing, or installed acceptance.
Those are P2-2 through P2-4 and remain part of the overall active goal.

The existing TCMD-RUNS1 worktree slice is locally complete and frozen except
for hosted CI. P2-1 may add Cargo dependencies and CI coverage on top of that
baseline but may not change its command behavior, inventory, or `0.4.1-dev.2`
decision. A combined hosted run may provide later evidence for both packages;
their lifecycle records remain separate.

## Verification And Stop Gate

Required deterministic tests cover:

- valid V1 activation/Unicode echo/heartbeat/quiesce/dispose;
- module byte limit, malformed module, unknown/WASI/file/network/process/
  credential/Tauri imports, missing memory/export, wrong signatures;
- memory minimum/growth/output range and request/response byte bounds;
- activation rejection and trap containment;
- fuel exhaustion for instantiation and calls;
- exact-request pre-call and in-flight cancellation;
- wrong instance, stale frame, post-quarantine/post-dispose rejection;
- two hosts in projects A/B where trap, hang, cancel, and dispose in A do not
  change B;
- no grant, Broker façade, contribution, filesystem, network, Workspace R,
  process, credential, Tauri, or environment object appears in the Wasm API.

Before the P2-1 stop:

- `cargo test -p rho-extension-runtime --locked --no-fail-fast` passes;
- `cargo clippy -p rho-extension-runtime --all-targets --locked -- -D warnings`
  passes;
- workspace stable/MSRV check/test/build, rustfmt, dependency/license review,
  and `git diff --check` pass;
- an independent security/contract review finds no ambient-authority,
  cross-instance, cancellation, resource-limit, error-truth, or scope drift.

## Version, NEWS, And Release

P2-1 is a real but non-routable runtime foundation. It does not independently
advance the already allocated `0.4.1-dev.2` application version, R package
versions, or `NEWS.md`. The first desktop-routable enable/grant/contribution
slice must allocate the next application development candidate and add truthful
NEWS copy. No installer, publication, marketplace, or Phase 2 acceptance is
created by P2-1 source completion.

## Implementation And Local Evidence — 2026-08-20

Implemented:

- exact `wasmtime 38.0.4` core-module host with default features disabled and
  only `cranelift`, `runtime`, and `std`; latest Wasmtime `47.0.3` is excluded
  because it requires Rust 1.94;
- private immutable project/plugin/package/generation/host identity plus a
  host-computed immutable entry-module digest;
- Guest ABI V1 activation, bounded UTF-8 echo, heartbeat, quiesce, dispose,
  request cancellation, timeout quarantine, and stable errors;
- one Engine/Store/Instance and epoch domain per host, one memory/instance/
  table, 2 MiB memory, 1,024 table elements, 1,000,000 fuel, 4 MiB module, and
  16 KiB request/response limits;
- no imports and no WASI; memory64, multi-memory, tail calls, SIMD, relaxed SIMD,
  bulk memory, Wasmtime async/component/thread/cache/profiling/pooling/WAT
  production features, and every privileged Rho surface remain absent;
- binary packaged-smoke fixtures for valid ABI V1 and forbidden WASI import;
- desktop candidate/legacy smoke runs the real production Wasm host without
  creating a user-routable command or plugin contribution;
- deterministic Phase 2 host and dependency/license contracts are enforced in
  Draft Fast and all six stable/MSRV compatibility legs.

Automated evidence:

- `cargo test -p rho-extension-runtime --locked --no-fail-fast`: 165 passed;
- `cargo clippy -p rho-extension-runtime --all-targets --locked -- -D warnings`:
  passed;
- Rust `1.88.0` check and the complete 165-test crate matrix: passed;
- `cargo test --workspace --locked --no-fail-fast`: passed; desktop 206 passed
  with one existing opt-in Keychain smoke ignored;
- workspace all-target check/build, rustfmt, lockfile, dependency feature tree,
  license contract, Phase 2 host contract, command inventory, Run History,
  Phase 1 acceptance, version/release agreement, and `git diff --check`: passed;
- `rho.bridge`: 575 passed; `rho.agent`: 120 passed;
- local debug candidate and legacy desktop smokes both reported Guest ABI 1,
  echo/heartbeat/dispose success, `wasi_rejected: true`, and
  `imports_exposed: 0` while the existing Ark/Workspace/project-isolation and
  Phase 1 runtime probes also passed.

Local installed-app evidence:

- Tauri built the arm64 `Rho.app`; the command then failed closed after bundling
  when updater-archive signing found no private key, so this is not a complete
  candidate build or signing result;
- the generated App reports version `0.4.1-dev.2`, contains an arm64 executable
  and installed license resources, and passes candidate and legacy smoke;
- executable size: approximately 43 MiB; SHA-256
  `c4223ed12cd1535ef0fad9dd04e8e35c2274772d06355d4032e4b108057b023a`.

Independent security review found and resolved:

- an exact-request cancellation linearization race between completion and epoch
  increment;
- unnecessarily enabled Wasm proposals; memory64, multi-memory, tail calls,
  SIMD, relaxed SIMD, and bulk memory are now explicitly disabled;
- missing timeout-to-host quarantine and guest-dispose-trap teardown coverage;
- mutable public identity fields and the absence of a host-computed immutable
  module digest;
- missing post-quarantine non-routability, memory growth, start-function fuel,
  invalid UTF-8/output, nonzero activation, unsupported-feature, and two-project
  failure-isolation cases.

No blocking source or local macOS finding remains. P2-1 nevertheless stays
active because the higher Phase 2 stop gate requires packaged Windows and Linux
negative/smoke evidence as well. The six-leg workflow is prepared to run the
same probe, but no hosted run exists for this uncommitted/unpushed branch.
Under the owner-approved local-first exception recorded in the active Phase 2
design, P2-2 may activate for local engineering while P2-1 remains active and
unaccepted. No additional application/R version, `NEWS.md`, publication, or
release decision is made, and hosted P2-1 evidence remains mandatory before
final Phase 2 acceptance.
