# Toolchains and project environments

`rho-toolchain` owns the project-level R and Python execution contract. The
project root contains one strict `rho.toml`; unknown or missing fields, moving R
aliases, unsafe relative paths, oversized files, and symlinked configuration
are rejected:

```toml
schema = 1

[runtime.r]
version = "4.5.2"
manager = "rig"
environment = "renv"
lockfile = "renv.lock"
installer = "pak"

[runtime.python]
version = "3.12"
manager = "uv"
project = "pyproject.toml"
lockfile = "uv.lock"
```

Package names are not duplicated into `rho.toml`: renv and `renv.lock` own the
R project library, while pyproject and `uv.lock` own Python dependencies. When
an opened project contains R source but has no toolchain contract, desktop
startup initializes renv, installs the required `jsonlite` and `pak` support,
snapshots the project library, writes a schema-2 local `rho.toml` against the
exact startup R, and then retries Workspace admission. There is no manual setup
command or configuration-file step. A failed local Doctor triggers one
journaled restore/repair and admission retry. A malformed `rho.toml` is first
preserved under `.rho/toolchain/recovery/` before Rho rebuilds the local
contract; valid non-local contracts remain fail-closed rather than being
silently replaced.

## Compute targets

Schema 2 may select a machine-local target identity without embedding host
credentials:

```toml
schema = 2

[compute]
default_target = "lab-gpu"
required_capabilities = ["cpu", "gpu"]
```

`<Rho home>/targets.yaml` binds that identity to two orthogonal dimensions:

```yaml
schema: 1
targets:
  lab-gpu:
    host:
      kind: ssh
      host: gnode01
      username: scientist
      host_fingerprint: SHA256:...
      remote_root: /data/projects
      identity_file: /home/me/.rho/ssh/lab-gpu/id_ed25519
    isolation:
      kind: docker
      engine: docker
      image: registry/rho@sha256:...
    capabilities: [cpu, gpu]
```

Hosts are `local` or pinned-fingerprint `ssh`; isolation is `native`, immutable
digest `docker`/`podman`, or a Conda environment with an exact explicit-spec
digest. The built-in `local` target is always available and cannot be changed
away from local/native. Missing `targets.yaml` therefore still leaves a stable
small local compute environment. Passwords are never written to the registry.
Environment → Connections may use a password once, through a temporary
askpass bridge, to install a dedicated Ed25519 public key. The private key is
stored with restricted permissions under `<Rho home>/ssh/<target-id>/`; only
its absolute `identity_file` reference is recorded in `targets.yaml`. Existing
operator-managed keys can be referenced instead. A configured SSH target can
be reopened in the same form, edited, and reverified with its existing key;
changing metadata does not require the one-time password again.

Doctor resolves the project target before probing runtimes. Local/native uses
the implemented rig/renv/pak/uv path. Local Docker/Podman Doctor inspects the
exact local image digest, mounts the project read-only with networking disabled,
resolves rig inside the image, verifies the configured renv lock against the
image R library, and runs `uv sync --locked --check` against the configured
image Python environment. Run and Live plans use the same immutable,
read-only, network-disabled container boundary with only the project mounted
writable. Sync, lock, and package install are rejected because an ephemeral
container cannot truthfully persist an image environment; rebuild the pinned
image instead. Local Conda Doctor now hashes the exact stdout from
`conda list --explicit`, compares it with the configured digest, then performs
rig/Rscript, renv/pak/jsonlite, uv lock, `.venv`, and exact Python checks through
`conda run --no-capture-output --name <environment>`. Conda Run/Live preserves
the original command environment. SSH uses `rho-toolchain-helper --stdio` as a
bounded JSON endpoint on the remote host. The Helper publishes an exact build
identity; Desktop probes it and automatically upgrades stale embedded builds
with a bounded retry interval. Target-aware Doctor validates the
returned project `rho.toml` digest and adopts only matching runtime checks into
the local report. Remote requests carry an explicitly confirmed, bounded,
ordered command vector. Run/Live requires exactly one command plus the complete
target-bound environment receipt; the Helper checks its ID/mode and writes
`environment.json` before the operation journal and spawn. Sync/Lock accepts
multiple effects without a Run/Live receipt. All effects share one operation
journal, stop at the first failure, retain each reached effect's exact status,
and expose `partial_effects_possible` plus that journal in the response and
through inspection. Before invoking the Helper, the client obtains the host key
with `ssh-keyscan`, verifies the exact configured SHA-256 through `ssh-keygen`, and
then uses OpenSSH `BatchMode=yes` plus `StrictHostKeyChecking=yes`. Request and
response identities bind protocol, request, target, remote project root, and
configuration digests. Once SSH dispatch begins, a disconnect, invalid frame,
or missing response is conservatively persisted in the local mirror as
`uncertain`; it is never reported as a failed operation with no effects. A
read-only `InspectOperation` then returns the bounded durable remote journal.
Only a journal with matching operation, project, target, configuration, kind,
and status can converge the mirror to `succeeded` or `failed`; a still-running
journal remains uncertain, while a verified missing pre-spawn journal converges
to a known no-command-admission failure. Dispatch refuses any second request
for a `dispatching` or `uncertain` operation identity before inspection; retry
is a deliberate new operation only after the original terminal truth is known.
No unsupported target silently falls back to local execution.

A successful Doctor becomes an explicit, mode-specific `TargetAdmission` bound
to the canonical project, `rho.toml`, target-registry digest, capabilities,
host/isolation realization, and exact runtime evidence. Workspace, Run, Live,
Sync, Lock, and package plan construction and target adaptation require that
admission and reject stale or wrong-mode evidence. The desktop caches only the
managed project's admitted Workspace realization, revalidates its config and
target binding before every Run and auxiliary Live process admission, and
fails closed if `rho.toml` or `targets.yaml` changes. Equivalent Rscript entry
points from the same canonical R home are accepted only when the admitted and
desktop exact versions also match. Desktop Workspace R is currently local Ark
only: an admitted Docker, Conda, or SSH Workspace is reported as unsupported
instead of being silently launched against local R.

Environment → Connections is the no-terminal setup path. The primary form asks
only for address, username, port, and a one-time password. Rho pins the
preferred offered Ed25519 host key, detects the remote home and Slurm partition
facts, creates and installs a dedicated key, uploads the exact embedded Helper
source, builds it on the remote host with pinned dependencies, atomically
updates `targets.yaml`, and optionally selects the target in the current
`rho.toml` without discarding unrelated TOML formatting. Target name, remote
folder, capabilities, existing-key use, and immediate project selection remain
collapsed advanced options. The password is cleared after the operation and is
never returned to the frontend or included in errors. Editing a target keeps
its ID stable and uses the already configured private key unless the operator
explicitly requests key repair.

Resource governance observes up to 16 registered target environments per
refresh and keeps target identity separate from physical device identity, so
local native, Docker, and Conda environments can share one device while SSH
targets report their remote device through the authenticated Helper. The
read-only resource operation measures the configured remote filesystem without
requiring a copied `rho.toml`; project config/digest checks remain mandatory for
Doctor and execution effects. CPU, memory, the project filesystem, and bounded
`nvidia-smi` GPU telemetry are
classified as healthy, warning, critical, or unavailable. Memory below 10%
available, project storage below 5% available, critical pressure on a
GPU-capable target selected for required GPU work, or missing telemetry for
that project-required GPU capability blocks formal Target Admission. CPU pressure
is visible but remains advisory. Desktop Run/Live admission reuses a matching
observation for at most 15 seconds, then refreshes before admitting more work;
project/config/target changes invalidate the cache.

## Resolution and execution

- `rig list --json` is bounded and parsed into installed R records. Rho accepts
  only the record whose reported semantic version exactly equals
  `runtime.r.version`; aliases such as `release` are never durable config.
- Managed R execution uses the safe `Rscript` sibling of the selected rig R
  binary with `--no-save --no-restore --no-site-file` and a positional script.
  Rscript therefore preserves its underlying `--file=<path>` identity rather
  than Rho translating the script to `source()` or `-e`.
- Project `.Rprofile`/`.Renviron` are selected explicitly when safe, renv owns
  the private project library, and automatic snapshots are disabled.
- R sync restores the configured lock with renv; locking is a separate
  `renv::snapshot()` operation. `pak::pkg_install()` targets the renv project
  library with dependency upgrades disabled and does not update `renv.lock`.
- Python execution uses
  `uv run --project <project> --locked --no-sync --python <version> -- ...`.
  Ordinary execution cannot install dependencies or change `uv.lock`.
  Explicit sync uses `uv sync --locked`; explicit lock uses `uv lock`.

`doctor()` is read-only. It verifies rig's exact R/Rscript pair, renv activation
and project library, pak/jsonlite, configured locks, uv, the configured Python
project, `uv sync --locked --check`, and `.venv` Python. The desktop exposes
this through `toolchain_doctor`; Environment → Toolchains is the primary
read-only project toolchain view, while Packages and Requests remain separate
modes.

## Durable effects and receipts

Every automatic initialization or repair, and every explicit sync, lock, or R
package-install sequence, is recorded before spawn under:

```text
.rho/toolchain/operations/<operation-id>/operation.json
```

The journal stores ordered argv/cwd effects, timestamps, bounded output,
status, and exit codes. A command that starts and fails is recorded with
`partial_effects_possible = true`; Rho does not pretend an external package
manager rolled back effects it may already have committed. Before a mutating
SSH request is dispatched, the local project also persists a payload-digest
mirror under `.rho/toolchain/remote-operations/<operation-id>/mirror.json`.
The mirror binds local and remote project identity, target/configuration
digests, request identity, and the last authoritative remote journal without
copying command environments into a second durable file.

Every run or live activation has a validated receipt at:

```text
.rho/runs/<run-id>/environment.json
.rho/live/<session-id>/environment.json
```

The receipt binds the exact `rho.toml` and target-registry digests to target
ID, host/isolation realization, resolved interpreters, lockfile hashes, R
system/user/project/effective libraries, installed package versions, `.venv`,
Python site-packages, platform, and observed system requirements. A changed
config, target binding, lock, or incompatible runtime invalidates the receipt.

## Target acceptance

```bash
cargo test -p rho-toolchain --test target_e2e --locked
cargo test -p rho-toolchain --test remote_multi_effect --locked
```

The hermetic process-boundary acceptance compiles temporary Docker, Conda,
OpenSSH, uv, and Python stand-ins, then exercises the production registry,
Doctor, Target Admission, plan adaptation, journal, Helper, mirror, disconnect,
and InspectOperation paths. It verifies immutable/offline Docker arguments,
Conda explicit-spec hashing, authenticated SSH Run/Sync/Lock dispatch, ordered
multi-effects, and uncertain-to-terminal reconciliation without requiring a
developer machine's mutable environments or network.
