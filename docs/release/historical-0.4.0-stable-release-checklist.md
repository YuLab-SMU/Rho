# Rho 0.4.0 Stable Release Checklist

Date: 2026-08-17

Status: historical stable release record; exact source, candidate, public
non-prerelease publication, Pages repair, stable/development manifests, and
independent live verification passed.

Identity: `0.4.0` / `v0.4.0` / `Rho 0.4.0`

- [x] all application version authorities and reviewed release notes equal `0.4.0`;
- [x] protected macOS/Windows/Linux stable and Rust 1.88 source legs pass;
- [x] Windows two-stage signing, installed-byte equality, smoke, and cleanup pass;
- [x] macOS signing, notarization, staple, Gatekeeper, smoke, and updater archive pass;
- [x] Linux final AppRun-patched AppImage, signature, smoke, and evidence pass;
- [x] aggregate/native evidence and passed acceptance bind exactly three platforms;
- [x] the immutable Draft contains exactly 16 accepted assets and `prerelease=false`;
- [x] protected publication preserves tag, commit, body, asset IDs/bytes, and stable state;
- [x] Stable and Development download blocks expose all three platform packages;
- [x] `/updates/stable.json` and `/updates/tauri/stable.json` expose exact `0.4.0`;
- [x] development manifests also select `0.4.0` with exactly three targets;
- [x] public Release assets and all four manifests pass independent HTTPS verification;
- [x] `rho-release` has no required-reviewer gate and the main ruleset is restored.

Owner authorization: `GO` to construct and publish only after every exact gate
above passes.

Exact release evidence: source `fca8e30702dae1081be7e4d53f6eadb7dde94d3d`;
exact-main source run `32086499471` attempt 2; candidate run `32088064266`;
public non-prerelease Release `372041662`; publish run `32089406275`.

Pages evidence: initial fixture-guard failure `32089427072`; repair PR #91 and
six-leg run `32089594322`; successful exact deployment `32090281523` from main
`e7aa4d6b4cd904d688d256865ca50c13a649a615`.

Final exact-candidate decision: `GO / RELEASED / LIVE`.
