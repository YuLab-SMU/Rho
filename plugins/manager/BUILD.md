# Build the ordinary manager plugin

Run `node scripts/build-manager-plugin.mjs DEST` from the Rho checkout, with a new
directory outside the checkout. The assembler copies the public UI SDK and
protocol declarations and uses the existing TypeScript compiler. It does not
download or install tools. The assembled package can be rebuilt with
`node build.mjs` using `tsc` on PATH or an explicit `RHO_PLUGIN_TSC`.

Snapshot with the ordinary plugin CLI, activate its exact `ui-web` artifact, and
open contribution `manager` with configuration and state `{}` using
`windows.open_view`. Use the generic plugin window. No core build or private
module is required to change this manager.

The manifest declares management capabilities and their delegation scopes
explicitly. Activation, view creation and scenario preparation need the scopes
of the instances they manage. The Host intersects them with the caller's actual
authority. Installing the package does not grant authority, and no source or
delivery-origin privilege exists. Narrow these declarations when building a
manager for a restricted deployment.
