# Foundation repair episode F0

Updated: 2026-11-15.

F0 runs the installation, half-uninstall, legacy-state and host-residue scenarios in a disposable HOME, npm prefix, temporary directory and host configuration root. The episode writes `work/foundation-episode/report.json` and removes its fixture after the report is written. Set `RHO_FOUNDATION_KEEP=1` when a local inspection of the fixture is needed.

## Run

```sh
npm run build:service
npm run acceptance:foundation
```

The script packs the current checkout, installs that tarball globally under an isolated npm prefix, records the package and three bin shims, creates an occupied npm staging target, builds a half-uninstall fixture, creates the legacy home layouts and writes Rho-owned and user-owned WorkBuddy entries under a fake host root. It then reads the legacy state through the current status command.

## Observed run

The macOS arm64 run used Node `v22.22.3` and Rho `0.5.11`. The tarball was `rho-workspace-rho-0.5.11.tgz` with SHA-256 `fd0157a51ee24dc4ece334153390cc95867fa07ad630ad114817ba48eb344ca0`. Installation under the disposable prefix completed successfully.

The occupied staging probe returned the expected rename failure. The half-uninstall fixture retained `rho`, `rho-ui` and `rho-screen-check` symlinks while the package directory was absent. The legacy fixture contained `~/Rho`, `~/rho-local-play`, `~/.rho-app`, `~/.rho-state`, project `.rho/rho` and tutorial state. The fake WorkBuddy root held Rho-owned records beside user-owned records.

The report status was `passed`. The installed package answered `rho paths` from the isolated HOME, `rho doctor --json` reported the legacy roots, `rho migrate --dry-run --json` listed all four legacy roots without writing them, and `rho host cleanup` removed only the Rho-owned entries from the fake WorkBuddy JSON files. `rho uninstall --purge --json` moved the occupied `.rho-R1eVz1mA` directory into the isolated quarantine, removed all three bin shims, completed `npm uninstall` with exit code 0 and retained its journal and receipt. No path under the real user HOME was used by the episode.

The final CI foundation matrix run [43774867172](https://github.com/YuLab-SMU/Rho/actions/runs/43774867172) passed the same 28-step episode on macOS 15, Ubuntu 24.04 and Windows 2022. The Windows report used Node `v22.23.4` and tarball SHA-256 `2ee3bc654feec91126df81bb13834fc4481fa2c4f71e7e03e2a7091adff2592e`; global install and `rho upgrade --apply` both returned 0. With the fixture-only native apply switch enabled, `rho service install foundation --apply` registered `rho-foundation` through `schtasks.exe` with manager code 0, `rho service status foundation` reported `registered: true`, and `rho service uninstall foundation --apply` deleted the task with manager code 0. The final purge uninstall returned 0 and wrote its receipt.

## Acceptance checks

| Check | Result |
| --- | --- |
| Pack the current source into a tarball | Passed |
| Install globally under an isolated npm prefix | Passed |
| Detect an occupied npm staging target | Passed |
| Retain a half-uninstall state with three shims | Passed |
| Create old home and project state layouts | Passed |
| Create Rho-owned and user-owned host records | Passed |
| Read the legacy state with the current CLI | Passed |
| Discover canonical paths from an isolated HOME | Passed |
| Run doctor and migration dry-run | Passed |
| Clean host records by Rho ownership | Passed |
| Complete installed-package uninstall and shim cleanup | Passed |

The completed F0 fixture also ran the installation manifest, canonical state apply, diagnostic bundle, profile creation, `start`, `status`, `restart`, forced crash recovery, versions, upgrade dry-run/apply, logs, cache list, native service descriptor install/status/uninstall, profile stop and the installed-package purge uninstall transaction. All 28 recorded steps passed.

The run completed a purge and retained the uninstall journal and receipt under the disposable application data root. The companion platform matrix passed the macOS, Linux/XDG and Windows/APPDATA path conventions and generated native service descriptors in disposable roots. Windows native Task Scheduler registration and removal are now covered by the CI runner; macOS LaunchAgent and Linux systemd manager application remain intentionally disabled in the shared matrix and need their own user-session evidence. A real WorkBuddy/Cursor connector matrix still requires those host machines. See the [F0–F6 implementation audit](FOUNDATION-REPAIR-AUDIT.md) for the requirement-by-requirement evidence.

A second run in an isolated `node:22-bookworm` container with the Rho-plugins checkout mounted at `/Rho-plugins` passed the same 28 steps on Linux arm64. Its tarball SHA-256 was `db60e73ff1c0c218a5f450ed28697d828dfe13fd48ef75c9f1acad16ff4dcab4`. The container used its own HOME, npm prefix, cache, temporary root and service state.
