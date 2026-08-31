# Extensions and plugins

`rho-extension-runtime` remains the isolated owner of bounded plugin identities,
manifests, capability grants, lifecycle, component hosting, contributions, and
typed surface/viewer documents. Its WIT files are the guest ABI source.

`rho-plugin-dev` owns local authoring and the immutable project-scoped package
cache used by those tools. Cache writes validate complete package snapshots,
use digest identity, and reject path/symlink escape. Neither crate owns Broker
policy, semantic Store lifecycle, Desktop composition, Agent authority, or
release installation.

The runtime flow is:

```text
validate package digest/manifest → request a host-owned grant
→ activate the exact package generation → route bounded typed calls
→ revoke and dispose on transition, timeout, or failure
```

Plugins receive no ambient filesystem, network, Workspace R, project,
credential, or UI-code execution authority. Contributions are typed documents
and fixed controls, not arbitrary React or markup. Current details are in crate
public exports, WIT contracts, and adjacent lifecycle/host tests.
