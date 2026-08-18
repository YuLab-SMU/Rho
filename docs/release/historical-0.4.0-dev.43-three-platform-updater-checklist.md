# Rho 0.4.0-dev.43 Three-Platform Automatic Updater Checklist

Date: 2026-08-17

Status: historical published prerelease record; exact source, candidate,
acceptance, publication, and live three-platform development update evidence
passed on 2026-08-17.

- [x] Windows x64 two-stage signing, installed-byte equality, smoke, and cleanup pass;
- [x] macOS arm64 signing, notarization, staple, Gatekeeper, smoke, and updater archive pass;
- [x] Linux x86-64 final AppRun-patched AppImage, signature, smoke, replacement, rollback, and cleanup pass;
- [x] aggregate/native evidence contains exactly three supported platforms;
- [x] startup automatic discovery/install is readiness-bound and failure-safe;
- [x] exact protected-main candidate is published with all three downloads;
- [x] development Tauri manifest exposes exactly three valid targets;
- [x] stable Tauri endpoint remains `404` at the dev.43 release boundary;
- [x] release page and public assets pass independent HTTPS verification.

Evidence: exact main `f1750c4b6cc81b464fb8f49a7376a60d6ba8a9a1`;
source run `32016789844`; candidate run `32016818404`; public Release
`371666844`; publish run `32018692323`; Pages run `32018756430`.

Final decision: `GO / RELEASED` for immutable development prerelease
`0.4.0-dev.43`.
