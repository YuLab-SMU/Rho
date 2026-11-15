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

The macOS arm64 run used Node `v22.22.3` and Rho `0.5.11`. The tarball was `rho-workspace-rho-0.5.11.tgz` with SHA-256 `cd0a876d109d6c45eb2995044753e17f0482d1e51c4330ea703833c39fbc6b33`. Installation under the disposable prefix completed successfully.

The occupied staging probe returned the expected rename failure. The half-uninstall fixture retained `rho`, `rho-ui` and `rho-screen-check` symlinks while the package directory was absent. The legacy fixture contained `~/Rho`, `~/rho-local-play`, `~/.rho-app`, `~/.rho-state`, project `.rho/rho` and tutorial state. The fake WorkBuddy root held Rho-owned records beside user-owned records.

The report status was `passed`. The installed package answered `rho paths` from the isolated HOME, `rho doctor --json` reported the legacy roots, `rho migrate --dry-run --json` listed all four legacy roots without writing them, and `rho host cleanup` removed only the Rho-owned entries from the fake WorkBuddy JSON files. `rho uninstall --purge --json` moved the occupied `.rho-R1eVz1mA` directory into the isolated quarantine, removed all three bin shims, completed `npm uninstall` with exit code 0 and retained its journal and receipt. No path under the real user HOME was used by the episode.

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

The completed F0 fixture also ran canonical state apply, profile creation, `start`, `status`, `restart`, `versions`, `logs`, `cache list`, service descriptor install/status/uninstall, profile stop and the installed-package uninstall transaction. All 22 recorded steps passed.

The run completed a purge and retained the uninstall journal and receipt under the disposable application data root. The companion platform matrix passed the macOS, Linux/XDG and Windows/APPDATA path conventions and generated service descriptors in disposable roots. Native service-manager registration and a real WorkBuddy/Cursor connector matrix still require those host machines.
