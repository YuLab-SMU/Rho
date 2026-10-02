# Rho documentation

Read [Status](STATUS.md) first for current implementation and verification. The
application checkout coordinates two independent source repositories; it no
longer contains their production sources or a Cargo workspace.

| Need | Read |
| --- | --- |
| Current state and remaining limits | [Status](STATUS.md) |
| Current ownership and invariants | [Architecture](ARCHITECTURE.md) |
| Target scientific capabilities | [Next Version](NEXT-VERSION.md) |
| Build or change a component | [Development](DEVELOPMENT.md) |
| Run a local application | [Operations](OPERATIONS.md) |
| Source publication, exact assembly and future signed releases | [Release](RELEASE.md) |
| UI decisions and user problems | [Design](RHO-DESIGN.md), [Feedback](STUDIO-FEEDBACK.md) |
| Core source and protocol | [Core repository](https://github.com/YuLab-SMU/Rho-core) |
| Official plugin source and builds | [Plugins repository](https://github.com/YuLab-SMU/Rho-plugins) |

Status is the single current summary. Keep it below 300 lines and distinguish
source organization, independently built artifacts and actually executed flows.
Git retains the former monorepo, retired runners and historical evidence claims;
there is no generated whole-product source/check catalog in the new layout.
