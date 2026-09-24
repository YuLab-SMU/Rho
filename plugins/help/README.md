# Help plugin

Help reads the static index and documentation of one exact installed R package
copy. The configuration pins the R provider revision/artifact/instance and the
native session, package observation, library and version selected in Packages.
Topic/alias search, paging and same-package links retain those identities. Cross-package
links ask for an explicit installed-copy selection; no name-based fallback runs.
Busy reads wait for the next poll. Expired observations or changed files remain
visible diagnostics requiring a new explicit Packages selection.

HTML is accumulated in bounded UTF-8 chunks with index and Help file fences.
Incomplete markup is shown only as raw text. Complete HTML is rebuilt as static
structural content with no original scripts, handlers, styles or fetched resources.
External documentation URLs can be copied through public clipboard cooperation;
public external-window cooperation remains separate. Images are represented by
alt text, not automatically fetched from the package or network.

The view saves topic, search, raw display and scrolling through the public SDK and
participates in cooperative closure. It never starts R, loads or attaches a
package, runs examples, installs anything or creates scientific execution records.
Native data and HTML are not stored in its presentation state. Reopening reads the
same original copy; an expired observation is not silently renewed. The ordinary
package's eventual scenario placement and Packages navigation are separate from
its independently importable build. The fixed workbench is still being replaced.

`node scripts/test-help-plugin.mjs` from the Rho checkout verifies the independent
copy outside the repository. See BUILD.md for building without private core code.
