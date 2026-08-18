# Rho 0.4.0 Stable Release Checklist

Date: 2026-08-17

Status: active exact stable release contract; owner publication authorization
is recorded, while source integration, exact candidate, publication, and live
stable-channel evidence remain pending.

Identity: `0.4.0` / `v0.4.0` / `Rho 0.4.0`

- [x] all application version authorities and reviewed release notes equal `0.4.0`;
- [ ] protected macOS/Windows/Linux stable and Rust 1.88 source legs pass;
- [ ] Windows two-stage signing, installed-byte equality, smoke, and cleanup pass;
- [ ] macOS signing, notarization, staple, Gatekeeper, smoke, and updater archive pass;
- [ ] Linux final AppRun-patched AppImage, signature, smoke, and evidence pass;
- [ ] aggregate/native evidence and passed acceptance bind exactly three platforms;
- [ ] the immutable Draft contains exactly 16 accepted assets and `prerelease=false`;
- [ ] protected publication preserves tag, commit, body, asset IDs/bytes, and stable state;
- [ ] Stable and Development download blocks expose all three platform packages;
- [ ] `/updates/stable.json` and `/updates/tauri/stable.json` expose exact `0.4.0`;
- [ ] development manifests also select `0.4.0` with exactly three targets;
- [ ] public Release assets and all four manifests pass independent HTTPS verification;
- [ ] `rho-release` has no required-reviewer gate and the main ruleset is restored.

Owner authorization: `GO` to construct and publish only after every exact gate
above passes.

Current exact-candidate decision: `NO_RELEASE_DECISION`.
