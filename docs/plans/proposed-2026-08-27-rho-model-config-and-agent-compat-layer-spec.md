# Rho Canonical Model Configuration and Agent-Tool Compatibility Layer

Status: proposed design contract, revision 3. Seeded by the owner's
2026-08-27 direction after a research pass over Codex CLI, Claude Code,
opencode, Cursor, and DeepSeek Harness: Rho keeps its own independent model
configuration system, and a compatibility layer projects it to aisdk today
and to other agent tools (codex, claude code, opencode, …) later. Revision 2
recorded the owner's further 2026-08-27 constraint: no encrypted vault, no
OS keychain, no non-plaintext credential storage of any kind — plaintext
configuration files in the aisdk style are the only accepted credential
store. Revision 3 records the owner's 2026-08-27 rapid-iteration ruling: no
migration of any kind — the new plaintext store is adopted directly, and the
legacy app-data `llm-profiles.json` and vault files are simply abandoned in
place (never read, never modified, never deleted). This supersedes the
same-day withdrawn draft that would have made aisdk's own configuration
files the authority. Revision 4 records the owner's 2026-08-27 directory
decision: follow the codex / claude code / opencode convention and support
both user-level paths — `~/.rho` is the primary, extensible Rho home (it
will hold more than configuration over time), and `~/.config/rho` is the
respected XDG variant. This document is `proposed-`; packages in it are
activated only through their own `active-` slices per
`docs/project/active-development-governance.md`.

Date: 2026-08-27

Change class: D3 because the target relocates the model/credential
configuration authority to a user-visible standard location, replaces the
credential storage mechanism entirely (plaintext instead of the encrypted
vault), amends resolution precedence, and adds a new export surface that
writes configuration into other tools' config locations.

Risk: R3 because implementation touches credential storage and resolution,
settings persistence (adopted directly, with legacy stores abandoned in
place), and a new outward-facing write path.

Package owned directly by this proposal: COMPAT-0 only — this contract, the
canonical schema and location rules, the plaintext credential-storage
decision, the export-layer semantics, and the cross-review. COMPAT-1/2/3/4
are staged handoffs that each require their own bounded authorization.

## 1. Owner Direction And Research Digest

The owner rejected configuration storage derived from the application bundle
path (`~/Library/Application Support/org.yulab.rho`) as invisible,
non-portable, and duplicating credentials the user already maintains for
their R/shell environment. The owner also surveyed how mainstream agent
tools solve LLM API access and credential storage:

| Tool | Credential approach | Lesson for Rho |
| --- | --- | --- |
| Codex CLI | pluggable store: `file` / `keyring` / `auto` / `ephemeral` | storage as a policy choice; plaintext file is a legitimate first-class mode |
| Claude Code | macOS Keychain default, file fallback elsewhere; strict split between secret config and shareable behavior config | keychain coupling is exactly what the owner is rejecting |
| opencode / cursor-agent | env-first with config-file provider entries | env is the universal compatibility primitive |
| Cursor IDE | keys in unencrypted local SQLite, readable by any extension; unfixed | plaintext is acceptable only when the read path is broker-owned and the file is user-owned with tight permissions — not a database any plugin can scan |
| DeepSeek Harness | write-only secrets; UI/config keep only references | honest display discipline: even in a plaintext world, the UI shows masked values by default |
| aisdk | plain YAML in `~/.config/aisdk/`, env-first via `api_key_env`, literal `api_key` supported | the owner's chosen model: simple, standard, user-editable, portable |

The owner's conclusion, recorded verbatim in direction: OS keychains and
self-built encrypted vaults bring headless/CI breakage, cross-platform
inconsistency, silent-downgrade ambiguity, and operator complexity that is
not worth it for Rho. Rho will store credentials exactly like aisdk does:
plain text in a user-owned configuration file, protected by filesystem
permissions, with environment variables as the first-class override
channel. This eliminates the CRED-VAULT-1 vault entirely rather than
relocating it.

## 2. Goals

- Rho owns one canonical model-configuration registry: providers, models,
  capability-relevant metadata, preferences, and credentials — all in one
  plaintext YAML file the user can read and edit.
- The canonical registry lives in the user-level Rho home, which supports
  both mainstream conventions (§5.1): `~/.rho` (primary, extensible) or
  `~/.config/rho` (XDG variant), overridable with `RHO_HOME`.
- Credential resolution becomes: explicit session entry → environment
  variable → config-file literal → truthfully not-configured. Existing
  `~/.Renviron` keys work with zero re-entry; every shadowing is visible in
  the UI (no silent precedence).
- The CRED-VAULT-1 vault and the app-data `llm-profiles.json` are abandoned
  in place: the new code never reads them, and they are left untouched on
  disk for the user to remove. Rapid iteration accepts re-entering
  credentials into the new plaintext file instead of building a migrator.
- A one-way compatibility layer exports the canonical registry to agent
  tools' native configuration surfaces, starting with aisdk; codex and
  claude code adapters follow as separate packages.

## 3. Non-Goals

- No encryption at rest, no OS keychain, no envelope/device-key scheme, no
  password or unlock flow — explicitly rejected by the owner.
- No import/two-way sync: Rho never adopts foreign config files as
  authority.
- No change to the Agent-turn execution path: Rust continues to resolve the
  effective model and credential and inject them into the aisdk session,
  exactly as today.
- No change to Agent Conversation/Turn/approval/execution truth, Runtime
  Output, Check/Evidence, Surface Runtime, project isolation, or the
  scientific-environment lane.
- No LiteLLM/gateway client, no OAuth, no per-project credential stores.
- No Settings information-architecture redesign beyond truthful source
  projection.
- No release, candidate, version-metadata, or `NEWS.md` claim from this
  proposal alone.

## 4. Current Authorities Being Amended

| Active contract | Amendment |
| --- | --- |
| CRED-UX (`active-2026-08-05-system-credential-and-simple-llm-settings-spec.md`) | settings file relocates to the XDG root and becomes YAML; redaction, revision discipline, and no-fallback rules retained |
| CRED-SEC (`active-2026-08-26-llm-credential-sources-and-store-hardening-spec.md`) | source semantics replaced: sources are session / environment / config-file literal; resolution precedence amended; audit retained |
| CRED-VAULT-1 (`active-2026-08-26-rho-encrypted-credential-vault-spec.md`) | superseded in full by the owner's plaintext direction; the vault module and its files are abandoned in place and the code is deleted outright (no exporter, per the rapid-iteration ruling) |
| CRED-REVEAL-1A | probe containment unchanged; scrub list derivation gains every `api_key_env` declared in the canonical registry |
| CRED-REVEAL-1B/1C | reveal flows stay explicit per-click with audit, but read from the plaintext file or environment — no store eligibility matrix remains |
| SETTINGS-UX2A | projection gains the truthful effective-source display (session / environment / config file / not configured, and when env shadows a file value) |

## 5. Target Architecture

### 5.1 Canonical registry and locations

- The user-level Rho home follows the codex / claude code / opencode
  convention and supports both path styles; resolution order:
  1. `RHO_HOME` (environment override, whole-home);
  2. `~/.rho` when it already exists (primary home — over time it will
     hold more than configuration, and it mirrors the project-level
     `.rho/` convention the repository already uses);
  3. `~/.config/rho` when it already exists (XDG variant);
  4. otherwise `~/.rho` (created on first write).
  Empty-string overrides count as unset, consistent with the credential
  rules. The effective home is surfaced truthfully in Settings.
- Home directory `0700`; files `0600` (best-effort ACL hardening on
  Windows).
- `config.yaml` sits at the home root — the single canonical file, schema
  version 6 (continues the V5 content model, serialized as YAML):
  providers (with `base_url`, `wire_api`, `api_key_env`, optional literal
  `api_key`), models with capability metadata, preferences, and
  capability routes. Field naming follows aisdk's conventions where the
  concepts overlap, so the aisdk adapter stays mechanical.
- Session-only entry remains as an in-memory UI convenience; it is never
  persisted and is not a storage mechanism.
- Application-internal state (SQLite, project sessions, logs, audit
  journal, plugin caches) stays in the Tauri app-data directory; only the
  user-facing AI-access configuration moves.

### 5.2 Credential resolution precedence

For each provider, in order:

1. **session** — an explicit in-app entry for the running session only;
2. **environment** — the provider's declared `api_key_env`, when present
   and non-empty (this is what makes existing `~/.Renviron` setups work);
3. **config file** — the literal `api_key` in `config.yaml`;
4. otherwise truthfully **not configured** — no guessing, no fallback.

The Settings projection always shows which source is effective and flags
when an environment value shadows a file value, so precedence is never
silent (the gh-CLI lesson).

### 5.3 Legacy abandonment (no migration)

- Rapid-iteration ruling: there is no V5→V6 migrator, no vault export flow,
  and no dual-run comparison. The new code reads and writes only
  `config.yaml` under the XDG root.
- The app-data `llm-profiles.json`, `agent-local-credentials.json`, and
  `agent-local-credentials.key` are never read, modified, or deleted by new
  code; the vault module and the V1–V5 schema/migration code are removed
  from the codebase outright (git history preserves them).
- A missing or unreadable `config.yaml` means the truthful empty state:
  no providers configured. Settings copy points the user at the file so
  re-entry is one paste away.
- The audit journal stays in app-data and gains a one-time
  `config_store_adopted` event naming the new path.

### 5.4 Compatibility/export layer

- One-way projection, Rho → tool. Each adapter is a declarative target
  descriptor: tool name, config locations, file format, managed-block
  markers, env-var naming map, and which registry fields it can express.
- Deterministic managed-block merge: Rho writes only between explicit
  markers (for example `# >>> rho managed` / `# <<< rho managed`) or into
  a dedicated include file where the tool supports one; user content
  outside the managed block is byte-preserved. Unparseable target files
  abort the export with a truthful error — never a rewrite-from-scratch.
- Every export produces a dry-run diff preview; applying requires an
  explicit user action naming the target paths, and is recorded in the
  audit journal. Since the canonical store is itself plaintext, exports
  write real values by default; a reference-only mode (env names, no
  values) remains available.
- Generic env materialization is the fallback adapter: emit a shell
  snippet or launch wrapper exporting the resolved `api_key_env` pairs, so
  tools without a dedicated adapter still work.
- First adapter: **aisdk** — sync the canonical registry into
  `${XDG_CONFIG_HOME}/aisdk/config.yaml` (managed block), so the user's
  own R console and scripts share Rho's configuration. The Agent-turn path
  inside Rho is unchanged (§3).
- Next adapters (own packages, with format research): **codex**
  (`~/.codex/config.toml` + env keys) and **claude code**
  (`~/.claude/settings.json` env surface). opencode/cursor-agent follow the
  same descriptor pattern.

## 6. Security Restatement

- Plaintext-at-rest is the only durable credential mode, directed by the
  owner. Protection is filesystem permissions only: `0700` root, `0600`
  files, atomic writes. Pre-existing world-readable files are reported
  truthfully with a repair affordance, never silently chmodded.
- The Settings UI states plainly that credentials are stored in plaintext
  in `config.yaml`; masked display by default remains (DeepSeek Harness
  lesson) even though the file is readable.
- Redaction unchanged: no secret in logs, store rows, turn events, audit
  bodies, crash reports, or IPC outside the explicit reveal command.
- Export is an outward write path and stays fail-closed: declared target
  paths only, marker-bounded edits, diff preview, explicit apply, audit
  event.
- Probe containment (CRED-REVEAL-1A) unchanged; env-scrub derivation now
  also covers every `api_key_env` declared in the canonical registry.
- Precedence is visible: env-shadowing of a file value is shown in
  Settings, never silent.

## 7. Staged Packages And Stop Points

- **COMPAT-0 (this proposal):** contract, plaintext-storage decision,
  location and precedence rules, export semantics, cross-review. Stop: no
  code.
- **COMPAT-1 (plaintext store, direct adoption):** XDG root +
  `RHO_CONFIG_HOME`, V6 YAML schema read/write with atomic writes and
  permission discipline, session → environment → file resolution, turns /
  connection tests / Settings cut straight over to the new store, vault and
  V1–V5 code deleted, Settings effective-source and shadowing projection,
  audit event. No migration, no dual-run.
  Stop: no export framework yet.
- **COMPAT-2 (export framework + aisdk adapter):** target-descriptor
  framework, managed-block merge engine, diff preview, confirmation and
  audit flow, aisdk YAML sync, generic env materialization.
  Stop: only the aisdk and env adapters.
- **COMPAT-3 (codex + claude-code adapters):** format research recorded in
  the package spec, both adapters, installed-app acceptance of a real
  exported configuration. Stop: further tools need their own packages.

Each package requires its own `active-` slice and owner authorization
before implementation. Only one package may be in flight.

## 8. Open Owner Decision Points

Recorded defaults stand unless the owner corrects them; corrections amend
this proposal before the affected package is authorized.

- **D-1 precedence:** session → environment → config-file literal
  (environment deliberately outranks the file, matching aisdk and making
  existing `~/.Renviron` keys effective immediately; shadowing is always
  displayed).
- **D-2 format and location:** single `config.yaml` in aisdk-style YAML at
  the user-level Rho home — `~/.rho` primary / `~/.config/rho` XDG variant
  / `RHO_HOME` override (revision 4); V6 schema continuing the V5 content
  model; session-only entry kept as an in-memory convenience.
- **D-3 turn path:** unchanged — Rust resolves and injects into the aisdk
  session; the aisdk YAML adapter serves the user's own R usage, not
  Rho's turns.
- **D-4 exports:** write real values by default with per-export
  confirmation and named targets; reference-only mode available.

## 9. Evidence Menu For Implementing Packages

- Location: fresh-install layout, `RHO_HOME` override, `~/.rho`-existing
  beats `~/.config/rho`-existing, XDG-only fallback, default `~/.rho`
  creation, empty-string override as unset, legacy app-data files never
  touched (byte-identical before and after any operation).
- Precedence: each source winning in turn, empty-string env treated as
  unset, shadowing display truthfulness, not-configured stays
  not-configured (no fallback).
- Export: managed-block round-trip preserves user content byte-for-byte,
  malformed target aborts truthfully, dry-run diff equals applied result,
  idempotent re-export, audit rows.
- Redaction regression across the new resolution and export paths;
  CRED-REVEAL-1A structured-failure fixtures pass with the extended scrub
  derivation; `config.yaml` contents never appear in logs or events even
  though they are plaintext on disk.
- Permissions: `0700` root, `0600` files; pre-existing loose permissions
  reported with a repair affordance.
- Two-project isolation: project runs never write each other's exports.
- Recovery: unreadable/malformed `config.yaml` yields the truthful
  not-configured state and never blocks project opening or non-Agent
  surfaces.
- Mock/browser parity for every new Settings state per the RSR contract.
