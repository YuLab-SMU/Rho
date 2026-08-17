# Rho 0.4.0-dev.43 Three-Platform Automatic Updater Checklist

Date: 2026-08-17

Status: active source contract; implementation and local affected validation
pass, protected integration pending. No dev.43 tag, Draft, Release, acceptance
record, or Pages entry exists.

- [ ] Windows x64 two-stage signing, installed-byte equality, smoke, and cleanup pass;
- [ ] macOS arm64 signing, notarization, staple, Gatekeeper, smoke, and updater archive pass;
- [ ] Linux x86-64 final AppRun-patched AppImage, signature, smoke, replacement, rollback, and cleanup pass;
- [ ] aggregate/native evidence contains exactly three supported platforms;
- [ ] startup automatic discovery/install is readiness-bound and failure-safe;
- [ ] exact protected-main candidate is published with all three downloads;
- [ ] development Tauri manifest exposes exactly three valid targets;
- [ ] stable Tauri endpoint remains `404`;
- [ ] release page and public assets pass independent HTTPS verification.

Current decision: `NO_RELEASE_DECISION`.
