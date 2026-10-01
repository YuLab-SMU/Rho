# Licensing And Third-Party Notices

This file explains the repository license boundary. It is informational and
does not replace or modify any license text.

## Rho-Original Work

Unless a file or directory contains a different notice, Rho-original source
code, documentation, tests, and scripts are licensed under
`AGPL-3.0-only`. The complete license is in [LICENSE](LICENSE).

Copyright © 2026 YuLab-SMU and contributors.

Commercial use is permitted. The AGPL's source-availability obligations apply
to distribution and to modified versions used to provide remote network
interaction. Existing permissions for historical Rho versions and copies are
not revoked by the prospective transition to AGPL.

## Third-Party Work

Third-party work is not relicensed as Rho-original work. Its own copyright,
license, and notice files remain controlling.

| Component | Repository or bundle boundary | License evidence |
| --- | --- | --- |
| Jet core | `vendor/jet-core/` | MIT; [`vendor/jet-core/LICENSE`](vendor/jet-core/LICENSE); [pinned provenance](vendor/jet-core/UPSTREAM.md) |
| Ark runtime | external executable, pinned for optional acquisition by `runtime/ark.json` | MIT plus upstream notices; acquisition retains the archive's `LICENSE` and `NOTICE` with the executable |
| sysinfo | native process observation in the execution adapter | MIT; exact version/features are pinned in `Cargo.toml` and `Cargo.lock` |

The embedded Studio also includes React/React DOM, FlexLayout, CodeMirror and
Radix Primitives (MIT), jsdiff (BSD-3-Clause), and Inter font assets (OFL-1.1).
The installed packages' license files and the exact versions in
`ui/package-lock.json` are the source evidence for those entries. Vite and
TypeScript are build dependencies. This summary is not a complete redistribution
notice bundle; inspect the actual payload before distributing it.

Upstream Jet's source and license remain in the repository; Ark notices accompany
any acquired runtime. License texts and publisher attribution must be preserved.

Rust, Node, and R dependency manifests identify additional source/runtime
dependencies. Those dependencies remain under the licenses published by their
authors; inclusion in an AGPL project does not change those terms. Before each
public distribution, check the exact payload and include the notices required
by the dependencies actually distributed. This inventory does not claim that
an external Ark/R installation is bundled with the current Rho binary.
