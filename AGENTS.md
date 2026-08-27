# Rho agent notes

Code and reproducible command output are the source of truth. Documentation is
a compact map of the current implementation; Git is the history. Plans and
status stay with the working issue or branch rather than becoming repository
documents.

## Working loop

1. Inspect `git status` and the relevant source/tests.
2. Use `node scripts/governance.mjs impact --changed-auto` to see mapped areas
   and checks.
3. Make a small coherent change and run the closest test while iterating.
4. Run the affected checks when the behavior settles, inspect the diff, and
   report only results that actually ran.
5. Update a current document only when it explains something the code cannot
   express clearly. Delete obsolete explanation instead of archiving it.

Preserve unrelated working-tree changes. A mutation reports success only when
its authoritative state agrees. Keep identity and permission checks at the
admission boundary, contain project data and secrets, bound external data, and
leave truthful recovery after failure. These are implementation properties,
not paperwork gates.

Documentation starts at `docs/README.md`. Its machine-readable page and source
maps live in `governance/registry.json` and `governance/source-map.json`.

## Repository details

- Direct UI scientific-environment operations use their dedicated broker and
  request surface; they do not reuse Agent approval records.
- Pass the normalized broker/store project root to Workspace R environment
  helpers. Do not rely on the process working directory.
- In R, test name membership before indexing a named atomic vector.
- Keep Tauri commands, generated TypeScript facets, and browser mock handlers
  aligned in the same change.
- Frontend visual values belong in the tokenized styles under
  `desktop/ui/src/styles/`; `foundation.css` only composes layers.
- Project skill discovery validates the `.rho/skills` root itself, including
  symlink containment.
- Windows GNU Rust commands require the Rtools45 toolchain at the front of
  `PATH`.

## Parallel work

Register only genuinely independent worktrees:

```bash
node scripts/dev-lanes.mjs start --id example --own 'path/**'
node scripts/dev-lanes.mjs check --id example --changed-auto
node scripts/dev-lanes.mjs finish --id example
```

Keep real Tauri debug windows in the integration checkout. Before changing
tasks, preserve unfinished work in a clearly named WIP branch commit.

## Visual and installer operations

For a real visual run, build the current frontend and desktop, then use:

```bash
npm run rsr:build --prefix desktop
cargo build -p rho-desktop
npm run rsr:accept:visual --prefix desktop
```

When explicitly asked to package the Windows installer, verify/bootstrap Ark,
run `scripts/build-windows-installer.ps1`, and report the executable and NSIS
installer paths, sizes, and SHA-256 hashes. Do not install or publish the
artifacts automatically. See `docs/RELEASE.md` for the operator map.
