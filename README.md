# Rho

Rho is an operable scientific workspace. This repository owns its application
shell, examples, development entry and exact component composition.

| Repository | Responsibility |
| --- | --- |
| [Rho-core](https://github.com/YuLab-SMU/Rho-core) | Generic Host, operation journal, plugin lifecycle, public SDK, CLI/HTTP/MCP |
| [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) | Official scientific plugins, domain contracts, native adapters, methods and views |
| Rho (this repository) | Application shell, examples, component selection and integration |

The component repositories are published under YuLab-SMU, each with its own source
and commit. The application split is submitted on `codex/split-repositories` for
review into `main`. See the
[development guide](docs/DEVELOPMENT.md) for the sibling checkout layout and
the [source publication procedure](docs/RELEASE.md#source-repositories).

```sh
node dev.mjs status
npm ci --ignore-scripts --prefix ui
node dev.mjs build app
node dev.mjs build core
node dev.mjs build plugin files
node dev.mjs build plugin annotations
node scripts/test-composition.mjs
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
