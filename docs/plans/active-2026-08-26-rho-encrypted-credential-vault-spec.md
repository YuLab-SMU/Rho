# Rho Encrypted Credential Vault — CRED-VAULT-1

Status: active implementation contract

Date: 2026-08-26

Authorization: the owner rejected the operating-system Keychain path as
unreliable and confirmed replacing it with Rho's own password-unlocked,
encrypted credential vault. The owner also confirmed that old Keychain values
must not be read, migrated, or deleted; affected credentials are re-entered.

Change class: D3. Risk: R3 because this replaces credential persistence,
introduces a password-derived encryption authority, changes schema source
metadata, and affects every credential read/write/delete/reveal path.

## 2026-08-26 Interaction Simplification Amendment

The owner rejected the password-created and per-restart unlock flow as
excessive Settings friction. This amendment supersedes every password-entry,
explicit-initialization, and explicit-unlock requirement below.

- Saving the first app-managed API key creates the Rho-owned local credential
  store automatically.
- Rho owns a random local wrapping secret in a separate current-user-only file
  and reopens the encrypted credential store automatically after restart.
- Settings exposes no vault concept, password, initialization screen, or unlock
  screen. The Provider page says `Saved locally` and proceeds directly to Add,
  View, and Replace.
- The implementation does not call, inspect, migrate, or delete macOS Keychain.
- A user with access to both Rho-owned local files has the same authority as the
  signed-in OS user. This is local storage isolation, not an additional
  user-supplied security boundary.
- The previously used unshipped password-vault filename is not reused or
  migrated. It remains untouched.

## 1. Sole Durable Store

Rho stores app-managed credentials only in
`agent-credential-vault.json` under the desktop application data directory.
The file contains a versioned KDF header, random salt, random XChaCha nonce,
authenticated entry IDs, and one encrypted credential map. It never contains
plaintext credentials or the vault password.

- Argon2id derives a 32-byte key from the user password using a fresh random
  salt and fixed reviewed parameters: 64 MiB memory, three passes, one lane.
- XChaCha20-Poly1305 encrypts/authenticates the entire credential map with a
  fresh 24-byte nonce on every write. The canonical header and entry IDs are
  authenticated associated data.
- The vault file is atomically replaced, durably flushed, and permissioned
  `0600`; its parent is created with private application-data ownership. Size,
  schema, KDF parameters, nonce/salt lengths, entry count, provider IDs, and
  plaintext credential limits are validated before allocation/use.
- The derived key exists only in a zeroizing process-memory session. Rho asks
  for the vault password once after each application start, never persists it,
  never sends it to a child process, and drops the key on process exit.
- Wrong password, tampering, corruption, unavailable storage, and durability
  failures are bounded, fail closed, and never expose cryptographic details.

There is no Keychain, Credential Manager, Secret Service, plaintext-file, or
adjacent-key fallback. Remove the `keyring` dependency and production calls.
Environment-managed and explicit session-only credentials keep their current
separate semantics.

## 2. Metadata Migration And Compatibility

Agent LLM settings advance from schema V4 to V5. On read, V4 Provider source
`system_store` becomes `rho_vault`; other sources remain unchanged. The first
successful settings mutation writes a byte-identical V4 backup before the V5
file. Older schemas migrate directly to V5 with `rho_vault` as the app-managed
default.

This metadata migration does not probe Keychain presence and does not claim a
credential exists. The old OS-store value remains untouched and unreachable.
The V5 Provider appears as `vault_not_initialized`, `vault_locked_missing`, or
`vault_locked_saved` from a strictly bounded structural header while locked;
the same header is authenticated as AAD during unlock. After successful unlock,
status is derived from authenticated decrypted content as `not_detected` or
`detected`. No historical key is guessed or silently copied.

## 3. Commands And Settings UX

Add outcome-safe commands to initialize and unlock the Rho Vault. Both accept a
transient password input and return the ordinary presentation-safe settings
view only. No password, derived key, decrypted credential, salt, nonce, KDF
detail, or crypto error crosses the response/binding/mock boundary.

The Provider page keeps Endpoint, API key, and Models together:

- uninitialized: `Create Rho Vault` opens a focused password + confirmation
  child screen;
- locked: `Unlock Rho Vault` opens a focused password child screen;
- unlocked/missing: `Add API key`;
- unlocked/saved: fixed mask, `View API key`, and `Replace`.

Initialize/unlock/add/replace drafts clear on Back, Cancel, blur, unmount,
success, and failure. Mock mode never retains the inputs. Existing secure
native View still performs fresh macOS user verification, then reads only the
already-unlocked Rho Vault; it never reintroduces an OS credential store.

## 4. Mutation And Recovery Contract

- Initialize uses create-new semantics and never overwrites an existing vault.
- Add/replace/delete/provider-delete hold the existing per-Provider operation
  guard and the vault session lock across read-modify-encrypt-durable-replace.
- Replacement preserves the old encrypted file until the complete new file is
  durable. Failed writes leave the prior credential decryptable.
- Provider deletion that cannot save metadata after deleting the credential
  restores the prior credential through the same vault transaction; recovery
  failure is reported truthfully.
- Every successful vault mutation advances the existing credential generation;
  rejected/failed mutations do not.
- Reveal audit, exact-source/no-fallback, redaction, cache isolation, and
  outcome-only IPC remain unchanged except for the exact source name.

## 5. Acceptance

Focused deterministic tests cover initialize, restart-locked, correct unlock,
wrong password, corrupt/tampered header/ciphertext, duplicate initialize,
random nonce rewrite, add/replace/delete, atomic-write failure preserving the
old value, password/draft clearing, bounds, `0600`, V4→V5 byte-identical backup,
old Keychain never called, source exactness, reveal while locked/unlocked,
audit redaction, recovery, successful-only generation, and two-Provider
isolation.

Rapid iteration may use focused Rust/binding/Settings checks while developing.
Before completion: full desktop Rust tests, format, generated bindings,
credential redaction suites, complete RSR matrix, installed macOS create/unlock/
add/restart/unlock/view/replace trial with disposable values, independent R3
review, and version/`NEWS.md` decision. No release claim before all gates pass.
