# Rho

Rho owns the scientific application shell, examples and selected component composition.
The retained implementation uses the former Core. The real R domain trial has completed through the new Core CLI. Subsequent
selected rebuilding proceeds on `main`; see
[Rebuild](docs/REBUILD.md) and [Status](docs/STATUS.md). Old source is preserved locally
on `codex/legacy-app-before-rebuild`; the application rebuild has not started.

| Repository | Responsibility |
| --- | --- |
| [Rho-core](https://github.com/YuLab-SMU/Rho-core) | New managed execution, request identity, continuation, resident host and CLI |
| [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) | Real scientific consumers and selected native/domain capabilities; old packages retained |
| Rho (this repository) | Application shell, examples, component selection and integration |

The component repositories are published under YuLab-SMU, each with its own source
and commit. The application split is submitted on `codex/split-repositories` for
review into `main`. See the
[development guide](docs/DEVELOPMENT.md) for the sibling checkout layout and
the [source publication procedure](docs/RELEASE.md#source-repositories).

The following commands describe the retained application baseline, not integration
with the rebuilt Core. New Core work uses its own README and CLI directly.

```sh
node dev.mjs status
npm ci --ignore-scripts --prefix ui
node dev.mjs build app
```

The application compiles using the pinned public SDK already in this checkout;
its build/check commands do not invoke Cargo or read sibling source. Plugins
likewise build against their own public dependency snapshot. The coordinated
entry uses sibling checkouts only for explicitly requested component development.

`rho.lock.json` pins component commits and SDK digests. `core-sdk.json` identifies
the generated public dependency; do not edit sdk/ locally. Build receipts in target/
identify actual binaries/packages. A source lock alone is not a build result.

See [documentation](docs/README.md), [current state](docs/STATUS.md),
[development](docs/DEVELOPMENT.md) and [operation](docs/OPERATIONS.md).
