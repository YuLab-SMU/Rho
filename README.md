# Rho

Rho is an operable scientific workspace. This repository owns its application
shell, examples, development entry and exact component composition.

| Repository | Responsibility |
| --- | --- |
| [Rho-core](../Rho-core/README.md) | Generic Host, operation journal, plugin lifecycle, public SDK, CLI/HTTP/MCP |
| [Rho-plugins](../Rho-plugins/README.md) | Official scientific plugins, domain contracts, native adapters, methods and views |
| Rho (this repository) | Application shell, examples, component selection and integration |

The sibling repositories currently exist locally. No new GitHub repository or
remote publication is implied. Each repository has its own source and commit.

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
