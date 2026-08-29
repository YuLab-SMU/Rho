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
R project library, while pyproject and `uv.lock` own Python dependencies.

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
small local compute environment. Passwords and private keys are unsupported in
the registry and remain in system SSH/credential facilities.

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
the original command environment. SSH remains blocked until the remote Helper
exists. The target-aware Doctor now invokes `rho-toolchain-helper --stdio` as
a bounded JSON endpoint on the remote host, validates the returned project
`rho.toml` digest, and adopts only matching runtime checks into the local
report. Effect operations remain explicitly unsupported until remote operation
journaling and disconnect recovery are complete. Before invoking it, the client obtains the host key with
`ssh-keyscan`, verifies the exact configured SHA-256 through `ssh-keygen`, and
then uses OpenSSH `BatchMode=yes` plus `StrictHostKeyChecking=yes`. Request and
response identities bind protocol, request, target, remote project root, and
configuration digests. No unsupported target silently falls back to local
execution.

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

Every explicit sync, lock, or R package-install sequence is recorded before
spawn under:

```text
.rho/toolchain/operations/<operation-id>/operation.json
```

The journal stores ordered argv/cwd effects, timestamps, bounded output,
status, and exit codes. A command that starts and fails is recorded with
`partial_effects_possible = true`; Rho does not pretend an external package
manager rolled back effects it may already have committed.

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
