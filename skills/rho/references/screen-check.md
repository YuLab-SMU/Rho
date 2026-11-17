# Checking a page in a real browser

`rho-screen-check` ships with `@rho-workspace/rho`. From a project where the package is installed, run `npx rho-screen-check --help`; from a Rho checkout, run `node scripts/screen-check.mjs --help`. It needs Google Chrome or Microsoft Edge on the machine, or Playwright's Chromium; without one it exits 2 and says how to fix that.

The canonical workflow is the operation Skill [`rho.screen-check`](../operations/rho-screen-check/SKILL.md). When you are connected to a project, read it with `skill.read`; when you are using a layered Rho connection, resolve the exact Skill reference with `rho_index` and `rho_resolve`. This reference remains the entry point for the installed integration Skill so the workflow has one source of truth.
