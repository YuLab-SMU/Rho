# Airquality inclusion rules

This ordinary R project starts with `datasets::airquality`, the built-in New York
air-quality observations for May–September 1973. `analysis.R` initially requires
complete observations across every variable, then writes a keyed monthly table,
a PNG and a completion inventory. It uses only R's included packages; the
acceptance environment uses R 4.5.2, including `tools::sha256sum`.

The research question is whether requiring nonmissing solar radiation, wind and
temperature unnecessarily excludes otherwise available ozone measurements.
Changing the inclusion rule to nonmissing ozone changes May from 24 observations
and 24.125 ppb to 26 observations and about 23.61538 ppb. August also changes;
June, July and September do not. This descriptive comparison does not resolve
missingness bias or establish a causal effect.

The browser episode copies these files into a disposable project, preserves a
person's code comment and unsaved notes, and asks a real external Agent to make
the change through Rho's scoped public interface. It retains both result versions.
Run it from the application source with `npm run acceptance:base-r` after building
and selecting `RHO_CORE_BINARY`. See the [episode record](../../docs/BASE-R-EPISODE.md)
for prerequisites, evidence and limits. The fixture is not a mandatory application
workflow or a dependency added to the base catalog.
