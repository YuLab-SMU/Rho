# Build a UI extension

A UI extension is a React view over an existing Rho capability, such as Documents
or Tables. The package owns its view; the existing capability owns data, edits and
operations. Rho supplies tabs, splits, focus and versioned resource bindings.

This workflow creates a package outside the application repository, previews it
without a service, and selects its compiled entry through JSON. It requires Node
22.22.x. It does not create a new server capability or dynamically install code in
a running application.

## Create and preview

From a built Rho checkout:

```sh
npm run build:service
npm run ui:create -- /absolute/path/notes-view \
  --name @example/notes-view --component example.notes
cd /absolute/path/notes-view
npm install
npm run dev
```

The generator refuses to overwrite an existing directory. It creates a private
package, pins its development dependencies and uses the local Rho package as its
SDK. An installed local tarball can be selected with `--sdk file:/absolute/rho.tgz`.
An installed SDK also provides the `rho-ui` command. No registry publication is
performed by any of these commands.

| File | What to change |
| --- | --- |
| `src/ui.tsx` | The exported React `View`, typed with `UiViewProps` from `@rho-workspace/local/ui-contract` |
| `rho-ui.json` | Component identity, version, capability owner, props schema, bindings and required methods |
| `preview.json` | Example props, document metadata and responses to declared client calls |
| `rho-selection.json` | Exact package name/version and its explicit local directory |
| `package.json` | Package identity, `./ui` export and `rho.ui` manifest location |

The preview binds to loopback and uses fixtures. Its controls exercise ready,
loading, owner-error and missing-binding states, change props and narrow the view.
It reports the last 20 method names without recording inputs. Undeclared methods
and missing fixture responses fail visibly. It receives no project credential and
has no API proxy. Source and fixture edits automatically refresh the page; this
resets local component state. It is not a live save, undo or authorization test.

## Read and update through owners

The generated example reads the exact bound document through `client.call` and
refreshes when the owner document version changes. Its effect aborts observation
on cleanup. A second view of that document reads the same buffer.

Use `view.props` for presentation inputs and `view.bindings` for exact resource
references. Preserve Unicode and version identities. Operations use the existing
typed client and its write conditions; do not create another document buffer or
assume that selecting a row changes its identity. `requiredOperations` lets the
shell explain unavailable views; it does not grant those operations.

The current `UiViewProps` contract remains `0.1-draft`. Pin the Rho SDK version and
check compatibility when upgrading. Existing first-party adapters can still supply
specialized capabilities such as framed bodies and feedback. The small extension
manifest currently contributes one full view per package.

## Check and select

```sh
# In the extension package
npm run check
npm run build

# In the Rho checkout
RHO_UI_EXTENSIONS=/absolute/path/notes-view/rho-selection.json npm run build:web
```

`check` validates the manifest and runs TypeScript. `build` also emits the compiled
entry and records its digest. The application build checks the selected package
name/version, resolves the named export and generates its registry entry. No edit
to `web/entries/`, `ui-entries.json` or generated operation contracts is needed.
The default application selection is unchanged when `RHO_UI_EXTENSIONS` is absent.

A selection has this shape:

```json
{
  "format": "rho.ui-selection/1",
  "packages": [
    {
      "package": "@example/notes-view",
      "version": "0.1.0",
      "directory": "../notes-view"
    }
  ]
}
```

Paths are relative to the selection file. Omitting `directory` resolves an installed
package from that file's location; it must export `./package.json`. The package
manifest points to `rho-ui.json`, and the UI export points to compiled JavaScript.
The browser build records package/component versions, entry and manifest digests,
and whether a local directory override was used. The emitted assets have their
own digests. Registry publication and accepted release composition remain separate.

The new build is discovered when the service starts. Use a disposable project and
an owned service for development; do not restart another person's session. For an
isolated build, `RHO_WEB_OUTPUT=/absolute/output` writes the browser assets there;
the public server's `webRoot` option selects that directory.

The component appears in `capability.list` under its existing capability owner.
An authorized Agent can create a view with `composition.apply`, using the manifest's
component/version, props and exact bindings. Ordinary layout changes and undo use
the same composition owner as other views. Disabling the capability hides the view;
removing the extension preserves its layout reference and document content.

## Generated components and limits

An AI author can edit the same source, manifest and fixtures, then run the checks
and preview. Generated layout descriptions can use a selected component immediately.
New executable component code enters through an explicit application build. These
trusted React entries run with the browser application's authority; they are not a
sandbox for untrusted HTML or JavaScript. A declaration cannot add service operations,
project access or native execution authority.

`uiExtensionLimits` in `src/ui-extension.ts` bounds selected extensions to 32,
each JSON manifest/selection to 64 KiB, and each entry file to 16 MiB. Exceeding a
limit rejects the build/start before registration; source files and retained work
are preserved. Entries must stay inside their package after resolving symlinks.
The reserved `rho.` namespace cannot be replaced, and schema references must stay
inside the props schema.

`npm run acceptance:plugin-dx` exercises a freshly generated package, standalone
preview, automatic refresh and the real shared buffer in a selected application
build. It uses Chrome and disposable projects with no Core or R runtime.
[Status](STATUS.md) records executed checks. [Frontend](FRONTEND.md) describes the
application and [Architecture](ARCHITECTURE.md#interface-composition) describes ownership.
