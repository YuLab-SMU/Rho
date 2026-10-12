# Rho privacy policy

Updated: 2026-10-12. The selected new application tree contains design and policies;
it has no application UI, launcher, model connection or runtime data store yet.
This policy does not describe the former application's behavior as a current
implementation. The [archived policy](https://github.com/YuLab-SMU/Rho/blob/codex/legacy-app-before-main-reset/PRIVACY.md)
remains available with that source.

## Current boundary

Component consumers use the separately selected Core CLI and domain/evaluation
tools. Their inputs, retained facts, outputs, credentials and network activity
belong to their respective owners and versions. See
[Core](https://github.com/YuLab-SMU/Rho-core) and
[Plugins privacy](https://github.com/YuLab-SMU/Rho-plugins/blob/main/PRIVACY.md).
Component execution is not an application privacy guarantee.

Removing controlled source from `main` does not remove ignored local evidence,
project files, caches, databases, credentials or running sessions. Archive branches
contain controlled source; they exclude ignored local runtime material.
No user-state cleanup or migration is selected by this source replacement.

## Future application work

Before a data-handling feature is delivered, document the actual locations,
retention/removal behavior, credential handling and network destinations. Present
original task and scientific output separately from model text. Do not infer
remote cancellation, saved data or unavailable observations as successful outcomes.

Code, command arguments and diagnostics can contain private content or credentials.
Review evidence before sharing it; bounded output does not establish redaction.
Report suspected exposure through
[private vulnerability reporting](https://github.com/YuLab-SMU/Rho/security/advisories/new).
