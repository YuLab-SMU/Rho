# rho.agent 0.1.6

- `rho_create_workspace_tools()` now accepts exact-project Manifest V2 Tool
  projections, converts the bounded Rho schema subset to aisdk schemas, labels
  plugin/package origin, and routes execution back to the Rust broker without
  granting authority in Agent R.
- Plugin Tool descriptions, Source results, and Skill text remain explicitly
  untrusted project content and cannot override instruction or approval policy.

# rho.agent 0.1.5

- Registered Provider profiles now construct and register the isolated
  credential-bound runtime at the same canonical Provider/model identity used
  by the admitted capability route. Exact route validation therefore succeeds
  without adding a fallback, ambient credential, or second effective model.
- Runtime route validation now checks the route model against the profile's
  Provider and model fields before a session can start.

# rho.agent 0.1.4

- Added explicit, bounded runtime adapters for the reviewed
  `aisdk.providers` catalog, including optional literal Base URL overrides,
  while retaining the existing one-route/one-credential Agent boundary.
- Runtime Provider construction now passes explicit reviewed endpoints and the
  selected system-store credential, preventing undeclared ambient Provider
  variables from changing the effective connection.

# rho.agent 0.1.3

- Added one effective, typed capability-route projection to each desktop
  ChatSession so the Agent process receives only the model route selected for
  the current turn.

# rho.agent 0.1.2

- Increased the desktop Agent step budget and retained bounded previews for
  large analysis results so long multi-step runs can finish without returning
  unbounded payloads.

# rho.agent 0.1.1

- Added Agent tools for previewed one-package install, update, and remove
  requests through the dedicated environment confirmation lane.
