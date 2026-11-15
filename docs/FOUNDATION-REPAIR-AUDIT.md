# F0–F6 implementation audit

Updated: 2026-11-15.

This audit records the evidence for the foundation plan. All commands below use disposable roots unless a command is explicitly described as a read-only check. No migration, uninstall or service registration was run against the operator's real HOME.

| Work package | Implemented behavior | Evidence |
| --- | --- | --- |
| F0 | npm tarball install, occupied staging rename, three-shim half-uninstall, legacy roots, project lock, host residue, diagnostic bundle, crash/restart, upgrade dry-run/apply and purge uninstall | `npm run acceptance:foundation`, 28/28 steps, `work/foundation-episode/report.json` |
| F1 | platform resolver, state envelope, migration inventory, copy verification, switch journal, project-lock migration and digest-checked rollback | `test/foundation.test.mjs`, migration rollback test, `rho migrate --dry-run/--apply/--rollback` |
| F2 | manifest package/bin ownership, version inventory, upgrade dry-run/apply entrypoint, staged uninstall, dangling-shim repair, quarantine, receipt and resumable operation journal | installed-package F0 episode, `rho versions`, `rho upgrade --dry-run`, `rho uninstall --dry-run` |
| F3 | CLI/env/profile precedence, profile roots/ports/logs/plugins/limits, service PID/process registry, direct service lock, native descriptor generation and optional manager registration | launcher tests, service descriptor matrix, `rho profile`, `rho status`, `rho service` |
| F4 | TTL temporary registry, fake HOME allowlist, config digest metadata, temporary/cache budgets, cache pruning and bounded log rotation/retention | foundation unit tests, F0 cache/log steps, `rho cache list/prune`, `rho logs` |
| F5 | explicit host adapter contract, JSON ownership adapter, per-file digest reports, user-entry preservation, pending cleanup receipt and runtime process/worker registry | fake WorkBuddy fixture, host cleanup tests, `rho host scan/cleanup`, `rho doctor --repair` |
| F6 | redacted diagnostic bundle, secret-file mode checks, bounded doctor scans, component/version inventory and three-platform path/native-descriptor matrix | `rho doctor --bundle`, secret-file test, `npm run acceptance:foundation:matrix` |

The Linux episode also ran in a disposable `node:22-bookworm` container and passed the full 28-step flow. The matrix runs all three platform path contracts on this macOS host by setting `RHO_PLATFORM` and platform-specific directory variables. It verifies descriptor contents without invoking a host service manager. `rho service install --apply` contains the native `launchctl`, `systemctl --user` and `schtasks.exe` paths, but actual macOS/Windows manager registration still needs the corresponding user session. WorkBuddy/Cursor connector versions and their real configuration locations likewise need host-specific evidence.

The Core-backed application regression run completed with 383 passing tests and 3 Windows-only skips. The docs site assembled 86 documents, rewrote 602 links, and its VitePress build rendered successfully.

The latest F0 artifact is recorded in [the episode](FOUNDATION-REPAIR-EPISODE.md). The source owner keeps component-level semantics in Rho-core and Rho-plugins; this audit covers the Rho lifecycle and ownership boundary only.
