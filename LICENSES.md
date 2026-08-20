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
| Jet | `vendor/jet/` | MIT; [`vendor/jet/LICENSE`](vendor/jet/LICENSE) |
| Lucide icons | `desktop/dist/vendor/lucide/` | ISC; [`desktop/dist/vendor/lucide/LICENSE`](desktop/dist/vendor/lucide/LICENSE) |
| Monaco Editor | `desktop/dist/vendor/monaco/` | MIT; `desktop/dist/vendor/monaco/LICENSE`, copied by `scripts/sync-monaco-assets.mjs` |
| DOMPurify | `desktop/dist/vendor/viewer/` | Apache-2.0 option from its upstream dual license; `LICENSE.dompurify.txt` |
| Marked | `desktop/dist/vendor/viewer/` | MIT; `LICENSE.marked.txt` |
| Papa Parse | `desktop/dist/vendor/viewer/` | MIT; `LICENSE.papaparse.txt` |
| KaTeX | `desktop/dist/vendor/viewer/` | MIT; `LICENSE.katex.txt`, copied by `scripts/sync-viewer-assets.mjs` |
| Ark runtime | pinned by `runtime/ark.json` and staged as a Tauri sidecar | MIT plus upstream notices; the bootstrap process copies the archive's `LICENSE` and `NOTICE` into `desktop/resources/runtime/` for bundling |
| Wasmtime / Cranelift | `wasmtime 38.0.4` Cargo dependency for the no-WASI Phase 2 Wasm host | Apache-2.0 WITH LLVM-exception; exact version/features are pinned in `Cargo.toml` and `Cargo.lock` |
| WAT parser | test-only `wat 1.257.1` Cargo dependency for deterministic Wasm fixtures | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; excluded from production dependencies |

Rust, Node, and R dependency manifests identify additional source/runtime
dependencies. Those dependencies remain under the licenses published by their
authors; inclusion in an AGPL project does not change those terms. Before each
signed public candidate, the exact distributable payload and its notices must
be audited again under the release contract.
