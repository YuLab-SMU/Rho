# COMPAT-1 Plaintext Canonical Model Config Store

Status: active implementation contract, authorized by the owner's
2026-08-27 instruction `直接使用最新的方案` under the rapid-iteration ruling
(no migration; the new scheme is adopted directly). Owning umbrella:
`proposed-2026-08-27-rho-model-config-and-agent-compat-layer-spec.md`
revision 3. This slice implements that proposal's COMPAT-1 package and
stops before any export-framework work.

Date: 2026-08-27

Change class: D3 (credential storage and resolution authority change).
Risk: R3 (credentials, settings persistence, probe boundaries).

Start precondition (lane constraint): the `startup-info-integration` lane
currently owns `Cargo.toml`, `Cargo.lock`, `desktop/src-tauri/src/main.rs`
(shared-write), `desktop/ui/src/transport/types.ts`,
`desktop/ui/src/transport/mock.ts`, `docs/README.md`, and
`docs/project/active-document-cross-review.md`. Per the owner's 2026-08-27
worktree directive (`现在就是worktree 的工作方式，这个修改制作好自己的模块就行了`),
COMPAT-1 is split into two stages:

- **COMPAT-1A (module, feature lane `compat-plaintext-config`, worktree
  `../Rho-compat-config`, started 2026-08-27):** the self-contained
  plaintext-config module only — config root, V6 YAML schema, load/save
  with permission and atomic-write discipline, and the pure
  session/env/file resolver with shadowing detection — plus in-module
  tests. It is wired as a private submodule declaration inside
  `agent_llm.rs` so no shared-authority path is touched. The `serde_yml`
  (or chosen) dependency lands in `desktop/src-tauri/Cargo.toml`; the
  resulting `Cargo.lock` build artifact converges through the integration
  lane at merge per `AGENTS.md`. No cutover wiring, no UI, no deletions.
- **COMPAT-1B (cutover, integration lane, blocked until
  `startup-info-integration` finishes):** turns / connection tests /
  Settings read and write only the new store, vault and V1–V5 code are
  deleted from `main.rs` and `agent_llm.rs`, Settings gains the
  effective-source and shadowing projection, and mock parity plus document
  lifecycle land. COMPAT-1B registers as the next single-writer
  integration lane.

## 1. Scope

### 1.1 Config root and file discipline

- User-level Rho home resolution, in order: `RHO_HOME` environment
  override → `~/.rho` when it exists → `~/.config/rho` when it exists →
  `~/.rho` (created on first write). Empty-string overrides count as
  unset. `~/.rho` is the primary, extensible home (revision 4 of the
  umbrella proposal); `~/.config/rho` is the respected XDG variant.
- Home directory `0700`, files `0600` (best-effort ACL hardening on
  Windows); atomic writes (write-temp-then-rename) for every mutation.
- Pre-existing loose permissions are surfaced truthfully in Settings with
  a repair affordance; never silently chmodded.
- A missing or unreadable `config.yaml` is the truthful empty state: no
  providers configured; Settings copy names the file path so re-entry is
  one paste away.

### 1.2 V6 plaintext YAML schema

- `config.yaml` continues the V5 content model, serialized as YAML, with
  field naming aligned to aisdk where concepts overlap:
  - providers: `id`, `name`, `base_url`, `wire_api`, `api_key_env`,
    optional literal `api_key`, capability metadata;
  - models: capability metadata and runtime options;
  - preferences and capability routes as in V5.
- Session-only credential entry stays in-memory only; it is never written.
- New dependency: a maintained YAML crate (evaluate `serde_yml` first;
  record the choice in the lane's implementation notes).

### 1.3 Credential resolution and projection

- Precedence per provider: session → environment (`api_key_env`, non-empty)
  → config-file literal → truthfully not-configured. Empty-string env is
  unset. No fallback, no guessing.
- Settings projection shows the effective source per provider and flags
  when an environment value shadows a file value.
- Settings states plainly that credentials are stored in plaintext in
  `config.yaml`; values are masked by default; the existing explicit
  per-click reveal (CRED-REVEAL-1C flow) reads file/env values with audit.

### 1.4 Cutover and deletions

- Turn resolution, connection tests, model discovery, and all Settings
  commands read/write only the new store.
- Delete `agent_credential_vault.rs`, the V1–V5 settings schema and
  migration code, and the vault wiring in `main.rs`. Legacy app-data files
  (`llm-profiles.json`, `agent-local-credentials.json`, `.key`) are never
  read, modified, or deleted.
- Audit journal (stays in app-data) keeps recording Rho-triggered
  credential reads and gains a one-time `config_store_adopted` event
  naming the new path.
- Connection-test/model-discovery probes keep CRED-REVEAL-1A containment;
  the env-scrub derivation now covers every `api_key_env` declared in the
  canonical registry plus generic sensitive names.
- Mock parity (`transport/types.ts`, `transport/mock.ts`) and RSR contract
  updates land in the same slice per `AGENTS.md`.

## 2. Out Of Scope

- No export framework, target descriptors, managed-block merge, or any
  codex / claude code / opencode adapter (COMPAT-2/3).
- No migration, export, or import of legacy stores; no `*.migrated.bak`
  handling.
- No Settings information-architecture redesign.
- No version metadata, `NEWS.md`, `docs/README.md`, or
  `docs/project/active-document-cross-review.md` edits before the
  integration checkpoint; those land with the lane's integration handoff.

## 3. Boundaries

- Agent Conversation/Turn/event/approval/execution truth, Runtime Output,
  Check/Evidence, Surface Runtime, project isolation, and the
  scientific-environment lane are untouched.
- Redaction is unchanged: no secret in logs, store rows, turn events,
  audit bodies, crash reports, or IPC outside the explicit reveal command,
  even though the on-disk file is plaintext.
- Export remains fail-closed by absence: this slice adds no outward write
  path at all.

## 4. Evidence Plan

- Config home: `RHO_HOME` override, `~/.rho`-existing beats
  `~/.config/rho`-existing, XDG-only fallback, default `~/.rho` creation,
  empty-string override as unset, permissions (`0700`/`0600`),
  atomic-write failure injection (temp left behind, rename failure).
- Schema: round-trip fixtures for the V6 model, unknown-field tolerance,
  malformed YAML → truthful empty/repair state that never blocks project
  opening or non-Agent surfaces.
- Precedence: each source winning in turn, empty-string env as unset,
  shadowing display truthfulness, not-configured stays not-configured.
- Deletion honesty: legacy app-data files byte-identical after every
  operation; no code path references the vault or V1–V5 schema.
- Redaction regression across resolution and reveal; CRED-REVEAL-1A
  structured-failure fixtures pass with the extended scrub derivation.
- Audit: `config_store_adopted`, per-read events; no secret in any audit
  body.
- Focused backend tests, Settings UI source/shadowing tests, mock parity,
  and `scripts/test-rsr-contract.mjs` per the RSR contract.
