# Security policy

Report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/YuLab-SMU/Rho/security/advisories/new).
Include the affected source revision or artifact, platform, impact, reproduction
steps and minimal evidence. Keep credentials, private project content and
unpatched exploit details out of public reports. Maintainers coordinate validation
and disclosure through the private advisory; no fixed response deadline is promised.

## Scope and current status

Rho owns the application container and its selected composition. Application
implementation and official distribution are pending. Design requirements are not
evidence that a protection is implemented. Report component-specific issues to
[Rho-core](https://github.com/YuLab-SMU/Rho-core) or
[Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) as appropriate.
See [Status](docs/STATUS.md), [Privacy](PRIVACY.md) and
[Artifact trust](CODE_SIGNING_POLICY.md).

## Security boundaries

Native programs run with the Host's operating-system authority. A Core caller
namespace does not by itself authenticate a principal or sandbox native code.
Component identity and resource references must be checked against the selected
caller and project scope; models and retrieved content cannot expand that scope.
An Agent's existing authorization requires mechanical boundary checks, without
another application approval for the same action.

Application-delivered UI must separate trusted native capabilities from isolated
external content. Generated interfaces use approved components and action/resource
references; schema validation does not establish authorization, resource freshness
or scientific correctness. Signing proves an artifact's signing identity and byte
integrity, not the safety or correctness of its behavior.

Acceptance must exercise the actual selected application and components, including
failure and unknown outcomes. Keep signing and publication credentials out of
build/test jobs. Keep secrets out of source and public diagnostics. Distribution
controls follow [Release](docs/RELEASE.md).
