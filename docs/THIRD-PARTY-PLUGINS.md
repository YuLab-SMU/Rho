# Develop and install third-party plugins

Rho can install independent npm packages while it is running. A package supplies
operations, Skills and standalone HTML views; it does not require rebuilding Rho
or becoming a base dependency. The first consumer is the optional
[sclet adapter](https://github.com/YuLab-SMU/Rho-plugins/tree/main/examples/sclet-plugin).
Its scientific implementation remains in sclet and its objects remain in the
project's shared R session. See the [observed episode](THIRD-PARTY-PLUGINS-EPISODE.md).

Runtime package installation is included in Rho 0.5.5. User-configured remote
markets are source functionality after 0.5.6. Build the current checkout with
`npm run build` and use `node dist/cli.js` in place of `rho` for that new path
until a distribution containing it is installed.

## Install and manage

Open a project, then **Plugins → Third-party plugins**. Install a directory entry
or enter a package source. The installed card shows its version, source, enabled
state and content digest. Open its view, read its guide, update, disable or remove
it there. An invalid source or failed update leaves the previous selection intact.

Only install packages you trust. Hosts run native code with the Rho process user's
OS permissions. Disabling npm lifecycle scripts prevents install hooks; it does
not make plugin execution a sandbox. No approval is added to already authorized
analysis. Paired browsers and Agent connections cannot install or manage packages.

The equivalent commands use the running service's private connection file:

```sh
rho plugin add /absolute/path/my-plugin
rho plugin add /absolute/path/my-plugin-0.1.0.tgz
rho plugin add @your-org/rho-plugin@0.1.0
rho plugin add 'git+https://github.com/your-org/repository.git#COMMIT:packages/plugin'
rho plugin list
rho plugin update my-plugin
rho plugin update my-plugin --source @your-org/rho-plugin@0.2.0
rho plugin disable my-plugin
rho plugin enable my-plugin
rho plugin remove my-plugin
```

Add `--connection /absolute/service-state/connection.json` for a nondefault
service. The default is `~/Rho/state/connection.json`. These commands do not start
a service. Never share the connection file. Public HTTPS `.tgz` URLs are also
accepted. Git sources require Git; package staging requires npm. Git submodules
and build hooks are not run. Build and include runtime files before distribution.

Installation stages an isolated dependency tree using npm with `--ignore-scripts`
and `--install-links`, validates the manifest and contained files, hashes the tree,
then atomically selects it. The source selector, resolved Git commit when present,
package version and runtime-tree digest remain visible. Listing does not import
plugin code. Content and calls verify the installed tree before use.

Disable blocks new calls and views. Remove takes the package out of the installed
selection. Both preserve native tasks, R sessions, project files and receipts.
Package revisions are retained in the service's `plugins/versions` directory;
remove is not a disk-purge command. Closing a view only releases its renderer.

## Remote plugin markets

In **Plugins → Third-party plugins → Plugin markets**, add an HTTPS JSON index.
The plugin search above includes its titles, descriptions, package ids and
keywords. Rho retains the index locally; opening the page, searching and listing
do not fetch it again or install its packages. **Refresh** explicitly reads the
source again. A failed refresh displays its error and keeps the last successful
index available. **Remove** removes the source, keeping installed plugins and
their recorded market keywords searchable.

The [YuLab Rho index](https://raw.githubusercontent.com/YuLab-SMU/Rho/main/site/market/rho.json)
includes Semantic figures, discoverable by `ggtree`, `clusterProfiler`, `dotplot`
and `cnetplot`. It is an optional source; add it explicitly:

```sh
rho plugin market add https://raw.githubusercontent.com/YuLab-SMU/Rho/main/site/market/rho.json
rho plugin market list
rho plugin market install MARKET_ID yulab.semantic-figures
rho plugin market refresh MARKET_ID
rho plugin market remove MARKET_ID
```

Use the id returned by `add` or `list` for `MARKET_ID`. The ordinary
`--connection FILE` option selects a running service. The browser and CLI use
the same saved sources. Agents can read cached indexes with `extension.list`;
adding, refreshing, removing sources and installing packages remain local-person
operations through `extension.market.change` and `extension.install`.

Publishers can host a static file matching the [actual index](../site/market/rho.json):

```json
{
  "apiVersion": 1,
  "title": "My lab's Rho plugins",
  "plugins": [{
    "id": "lab.my-plugin",
    "title": "My plugin",
    "version": "0.1.0",
    "description": "What this plugin does",
    "source": "@my-lab/rho-plugin@0.1.0",
    "repository": "https://github.com/my-lab/rho-plugin",
    "needs": "Required tools or data",
    "keywords": ["analysis", "visualization"]
  }]
}
```

Each index selects one version per plugin id. `keywords` is optional; the other
fields shown are required. Package sources use an exact npm version matching
`version`, or `git+https://…#FULL_40_CHARACTER_COMMIT:package/path`. The package's
actual plugin id and version must match before installation selects it. Install
binds the source to the index digest the person selected; a changed or removed
index refuses a stale install. The installed package records its market URL,
title, index digest and keywords alongside its own source and runtime-tree digest.

Index URLs use HTTPS without credentials, queries or fragments. Explicit loopback
HTTP supports local development. Redirects, authenticated indexes, automatic
refresh/update and tarball entries in markets are not supported in this pass;
direct package installation still accepts tarballs. An index is publisher metadata,
not a signature or proof of package validity. This Rho `apiVersion: 1` index is
separate from the [Harness index](../site/market/index.json); the formats are not
interchangeable. See the [observed market episode](PLUGIN-MARKETS-EPISODE.md).

## Create a package

```sh
rho plugin create my-plugin --id lab.my-plugin
rho plugin check ./my-plugin
rho plugin dev ./my-plugin
```

`create` refuses to overwrite a directory. The generated package has a working
greeting operation, Skill and view. `dev` installs checked snapshots on source
changes, ignoring `.git` and `node_modules`. Reopen a view to load a new snapshot.
Invalid edits retain the last working installation. No Rho rebuild is needed.

| File | Responsibility |
| --- | --- |
| `package.json` | npm name/version, runtime files and `rhoPlugin: "rho-plugin.json"` |
| `rho-plugin.json` | API version 1, unique plugin id, title, description and entries |
| `host.mjs` | `run(operation, input, context)` over the domain's public capabilities |
| `SKILL.md` | When/how to use the package, prerequisites, failures and result limits |
| `view.html` | Prebuilt HTML with inline scripts/styles; may bundle a framework |

Each operation declares `id`, `title`, `description`, `effect` (`read` or
`native`), the Rho `methods` it delegates, and an object `inputSchema`. Each Skill
or view declares `id`, `title` and a package-relative `file`. The manifest's
`operations`, `skills` and `views` arrays are required, but may be empty. A host
is required only when operations exist. The checker validates entry containment,
API compatibility, identifiers, duplicate entries, schemas and entry sizes.

```js
export async function run(operation, input, context) {
  if (operation === 'read-sessions') {
    const value = await context.call('kernel.read', { limit: 1 });
    return { sessions: value.sessions };
  }
  throw new Error('Unknown operation');
}
```

`context.projectRoot` is the selected project, `context.invocationId` identifies
this call, and `context.changeId(label)` supplies a stable delegated write id.
`context.call(method, body)` validates the ordinary Rho schema, original caller's
grant, current project and owner availability. Declare every delegated method.
A read operation cannot delegate a mutating method. It must also keep its own
native work read-only; native host code is trusted, not OS-confined.

The host runs in a disposable child process for each call, without the service
token. Keep long work in its actual native owner and return its handle promptly.
For example sclet submits `kernel.run` with `waitMs: 0`, then observes the same
cell with `kernel.read`. Do not create a second scientific state store in Rho.

## Agent and view entries

Agents discover installed packages through `extension.list`, read their schema
with `extension.describe`, and read a Skill through `extension.content` with
`kind: "skill"`. These operations are available through the existing layered MCP
discovery. They then call:

```json
{
  "pluginId": "lab.my-plugin",
  "expectedDigest": "64-character digest from extension.describe",
  "operation": "greet",
  "input": { "name": "World" },
  "changeId": "original-request-1"
}
```

This is the body of `extension.call`; direct HTTP clients also supply `projectId`.
The returned receipt separates plugin completion from the native result in
`value`. Native invocations retain pending/completed/unknown receipts and delegated
requests/replies. Repeat the **exact** request to observe the same receipt, even
after update or removal. `extension.read` reads it by `invocationId` for the same
caller/project. A restart converts pending receipts to unknown; it never replays
them. Read-only calls do not accumulate durable receipts. No plugin receipt makes
native work Core-managed or establishes scientific validity.

A view runs in an iframe with an opaque origin, no service credential or storage
access, and no network loading. Bundle assets inline or as data URLs. Its bridge
is restricted to the selected package and digest:

```js
const receipt = await rho.call('greet', { name: 'World' });
output.textContent = receipt.state === 'completed'
  ? receipt.value.greeting : receipt.error;
```

The frame follows the page's own height from 200 to 900 px, so let the page flow
rather than fill the viewport; a taller page scrolls inside the frame. The page
`create` generates shows a labelled form, a result and a failure state to start from.

Pass a third argument to `rho.call` to retain an explicit original changeId.
The default generates one per deliberate call. A stale digest is refused; reopen
the view after an update. Several views may be declared and selected in the plugin
panel. These runtime views currently live on Plugins, not in Studio's resource
binding/layout contract. Existing compiled React extensions still use
[UI extension authoring](PLUGIN-AUTHORING.md).

## Contribute and distribute

Keep your repository, license, dependencies and release history independent. Check
the packed artifact, not just source: `npm pack --ignore-scripts`, then install
that tarball in a disposable Rho project. Exercise missing prerequisites, an input
error, recovery, update and removal. Record the Rho/API version, package digest,
native versions and actual result. Preserve user data and avoid credentials in
examples or diagnostics. Publish to your own npm namespace or share a public Git
source/tarball; Rho does not publish packages on your behalf.

No central registration is needed to install a package. To be discoverable in the
bundled directory, submit a PR editing
[`src/extension-directory.ts`](../src/extension-directory.ts), linking the public
source, license, author guide and a reproducible acceptance record. Propose an
immutable Git commit or exact npm version. Maintainers check the declared scope;
directory inclusion is not a security audit, release signature or scientific
endorsement. Future releases of the package can update that entry independently.

## Resource limits and current scope

Use the service's `--limits` JSON file with an `extensions` object to override
limits. Exceeding a limit refuses new work, retains the previous selected package
and obtained receipts, or records an unknown result after an interrupted call.

| Protected resource | Default configuration |
| --- | --- |
| Configured market sources / entries in each index | `maxMarkets: 16`, `maxMarketEntries: 128` |
| Each downloaded index / request duration | `maxMarketBytes: 262144`, `marketTimeoutMs: 10000` |
| Installed selections / retained revisions | `maxPlugins: 32`, `maxVersions: 128` |
| Admitted runtime tree | `maxFiles: 20000`, `maxPackageBytes: 134217728` |
| Skill/view bytes | `maxContentBytes: 524288` |
| Durable invocations / receipt and result bytes | `maxReceipts: 2000`, `maxResultBytes: 1048576` |
| Concurrent calls / delegated calls per invocation | `maxRunning: 4`, `maxDelegations: 32` |
| Worker / each install subprocess | `timeoutMs: 30000`, `installTimeoutMs: 180000` |

Market limits refuse an initial add or retain the previous index after a failed
refresh. The byte limit also checks streamed responses without a Content-Length.
The tree-size check applies after npm staging; it is not a disk quota on npm/Git.
A timed-out worker does not prove a delegated native task stopped. Observe its
original identity. Retention limits refuse rather than silently evict identities;
raise them deliberately when appropriate. Manifests are capped at 64 KiB, with
32 operations and 16 entries of each content kind. The browser permits four
pending calls per view. macOS with Node 22 is observed in this episode; Windows,
Linux and independent developer usability have not been established for this path.
