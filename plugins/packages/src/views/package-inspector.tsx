import { usePackages, useSession, useNavigation, useAgent } from "../view-services.js";
import { packageCopyKey, packageLink } from "../packages.js";
import type { PackageEntry } from "../../public/r-protocol/index.js";
import type { PackageGroup } from "../../public/r-protocol/index.js";
import type { PackageSource } from "../../public/r-protocol/index.js";

export const packageState = (group: PackageGroup) =>
  group.attached ? "Attached" : group.loaded_version ? "Loaded" : "Not loaded";
function Link({
  url,
  children,
}: {
  url?: string | null;
  children: React.ReactNode;
}) {
  const safe = packageLink(url), navigation = useNavigation();
  return safe ? (
    <a href={safe} target="_blank" rel="noopener noreferrer" title="Open in a new tab" onClick={event => { event.preventDefault(); navigation.openLink(safe); }}>
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  ) : (
    <span>{children}</span>
  );
}
function SourceDetails({ source }: { source: PackageSource | null }) {
  return (
    <div className="package-source-details">
      <div className="package-source-heading">
        <h3>{source?.kind ?? "Not recorded"}</h3>
        {!!source?.evidence.length && (
          <span className="package-recorded">Recorded</span>
        )}
      </div>
      {source?.repository && (
        <p className="package-source-repository">
          <Link url={source.repository_url}>{source.repository}</Link>
        </p>
      )}
      {source?.notice && <p className="muted">{source.notice}</p>}
      {!source && (
        <p className="muted">
          The installed metadata does not identify where this copy was obtained.
        </p>
      )}
      <dl className="package-facts">
        {source?.remote_ref && (
          <>
            <dt>Ref</dt>
            <dd>{source.remote_ref}</dd>
          </>
        )}
        {source?.remote_sha && (
          <>
            <dt>Commit</dt>
            <dd>
              <code title={source.remote_sha}>
                {source.remote_sha.slice(0, 12)}
              </code>
            </dd>
          </>
        )}
        {source?.remote_host && (
          <>
            <dt>Remote host</dt>
            <dd>{source.remote_host}</dd>
          </>
        )}
        {source?.provider && (
          <>
            <dt>Repository provider</dt>
            <dd>{source.provider}</dd>
          </>
        )}
        {source?.delivery_url && (
          <>
            <dt>Recorded repository / URL</dt>
            <dd>
              <Link url={source.delivery_url}>{source.delivery_url}</Link>
            </dd>
          </>
        )}
        {source?.snapshot && (
          <>
            <dt>Snapshot in URL</dt>
            <dd>{source.snapshot}</dd>
          </>
        )}
      </dl>
      {!source?.delivery_url && (
        <p className="muted package-source-missing">
          Download repository not recorded.
        </p>
      )}
      {!!source?.evidence.length && (
        <section className="package-detail-section">
          <h4>Evidence</h4>
          <p className="muted">Installed DESCRIPTION</p>
          <details className="package-metadata">
            <summary>View recorded metadata</summary>
            <dl className="package-facts">
              {source.evidence.map((field) => (
                <div className="package-fact-pair" key={field.field}>
                  <dt>{field.field}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          </details>
          <p className="muted">
            Recorded fields describe this copy; they may not identify every step
            of its installation.
          </p>
        </section>
      )}
      {!!source?.links.length && (
        <section className="package-detail-section">
          <h4>Project links</h4>
          {source.links.map((link) => (
            <p key={link.url}>
              <Link url={link.url}>{link.label}</Link>
            </p>
          ))}
          <p className="muted">
            Project links do not establish the installation source.
          </p>
        </section>
      )}
    </div>
  );
}
export function PackageInspector({
  group,
  inline = false,
}: {
  group: PackageGroup;
  inline?: boolean;
}) {
  const p = usePackages(), session = useSession();
  const navigation = useNavigation(), agent = useAgent();
  const detail = p.details.get(group.name);
  const copies = detail?.copies ?? [];
  const primary =
    copies.find(
      (c) =>
        c.library_path === group.primary_library_path &&
        (!group.loaded_version || c.version === group.loaded_version),
    ) ?? copies[0];
  const selectedCopy =
    copies.find((c) => packageCopyKey(c) === p.sourceCopy) ?? primary;
  const sourceMode = p.inspectorMode === "source";
  const source = selectedCopy?.source ?? null;
  function showSource(copy?: PackageEntry) {
    p.showSource(copy ? packageCopyKey(copy) : null);
  }
  const waiting = !detail && session.runtime?.state === "busy";
  return (
    <section
      className={`package-inspector ${inline ? "package-inspector-inline" : "package-inspector-wide"}`}
      aria-label={`Details for ${group.name}`}
    >
      {sourceMode && (
        <button
          className="package-back"
          onClick={() => {
            p.showOverview();
          }}
        >
          ‹ Overview
        </button>
      )}
      {!inline && (
        <div className="package-inspector-heading">
          <h2>{group.name}</h2>
          <span
            className={`package-session-label ${group.attached ? "attached" : group.loaded_version ? "loaded" : ""}`}
          >
            {packageState(group)}
          </span>
          <button
            className="package-doc-button"
            onClick={() => {
              if (selectedCopy) navigation.openDocumentation(selectedCopy);
            }}
            disabled={!selectedCopy?.library_path || !p.session || p.expired || navigation.blocked || !navigation.canOpenDocumentation}
            title="View package documentation"
          >
            Documentation
          </button>
        </div>
      )}
      {!inline && (
        <p className="package-purpose">
          {group.title ?? "Purpose not recorded."}
        </p>
      )}
      {detail?.notice && (
        <p className="package-notice" role="alert">
          {detail.notice}
          {!p.expired && <button onClick={() => p.retry()} disabled={detail.loading || session.runtime?.state === "busy"}>Retry</button>}
        </p>
      )}
      {(detail?.loading || waiting) && (
        <p className="package-notice">
          {waiting
            ? "R busy. Details will refresh when idle."
            : "Reading package details…"}
        </p>
      )}
      {sourceMode ? (
        <>
          {!!copies.length && (
            <label className="package-copy-picker">
              Installed copy
              <select
                aria-label="Source Copy"
                value={selectedCopy ? packageCopyKey(selectedCopy) : ""}
                onChange={(event) => {
                  p.showSource(event.target.value);
                }}
              >
                {copies.map((copy) => (
                  <option
                    key={packageCopyKey(copy)}
                    value={packageCopyKey(copy)}
                  >
                    {copy.library_index === null
                      ? "Outside library paths"
                      : `Library ${copy.library_index}`}{" "}
                    · {copy.version}
                    {copy.loaded_from_library &&
                    copy.version === group.loaded_version
                      ? " · Loaded"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selectedCopy && (
            <SourceDetails key={packageCopyKey(selectedCopy)} source={source} />
          )}
        </>
      ) : (
        <>
          <section className="package-detail-section package-current-session">
            {!inline && <h4>Current session</h4>}
            <div className="package-detail-line">
              <strong>
                {group.loaded_version
                  ? inline
                    ? `Loaded ${group.loaded_version}`
                    : "Loaded version"
                  : "Not loaded"}
              </strong>
              {group.loaded_version && (
                <span className={inline ? "package-inline-session" : ""}>
                  {inline
                    ? group.attached
                      ? "Attached"
                      : "Namespace only"
                    : group.loaded_version}
                </span>
              )}
            </div>
            <p className="muted">
              {group.loaded_version
                ? group.attached
                  ? "Attached to the R search path."
                  : "Namespace loaded; not attached to the search path."
                : "Installed metadata does not confirm that a package can load."}
            </p>
            {group.loaded_version && !group.loaded_copy_observed && (
              <p className="package-notice">
                The observed files do not match the loaded version. Source of
                the loaded copy is not confirmed.
              </p>
            )}
            {group.loaded_version &&
              group.first_version &&
              group.loaded_version !== group.first_version && (
                <div className="package-warning">
                  R is using {group.loaded_version}. The first installed copy is{" "}
                  {group.first_version}; library order does not replace an
                  already loaded namespace.
                </div>
              )}
          </section>
          {!inline && selectedCopy && (
            <section className="package-detail-section package-overview-source">
              <div className="package-detail-line">
                <h4>
                  Source ·{" "}
                  {selectedCopy.library_index === null
                    ? "Outside libraries"
                    : `Library ${selectedCopy.library_index}`}
                </h4>
                <button
                  className="text-button"
                  onClick={() => showSource(selectedCopy)}
                >
                  {source?.kind ?? "Not recorded"} ›
                </button>
              </div>
              <p className="muted">
                {source?.provider ??
                  (source?.delivery_url
                    ? "Repository URL recorded."
                    : "Download repository not recorded.")}
              </p>
            </section>
          )}
          <section className="package-detail-section package-copies">
            <h4>
              {group.copy_count} installed{" "}
              {group.copy_count === 1 ? "copy" : "copies"}
              {group.copy_count === 0 && group.loaded_version
                ? " in current libraries"
                : ""}
            </h4>
            {copies.map((copy) => (
              <div className="package-copy" key={packageCopyKey(copy)}>
                <div className="package-copy-line">
                  <span className="package-library-index">
                    {copy.library_index ?? "–"}
                  </span>
                  <strong>{copy.version}</strong>
                  <span className="package-copy-state">
                    {copy.loaded_from_library &&
                    copy.version === group.loaded_version
                      ? "Loaded"
                      : ""}
                    {copy.first_in_library_path
                      ? copy.loaded_from_library &&
                        copy.version === group.loaded_version
                        ? " · First in search"
                        : "First in search"
                      : copy.loaded_from_library &&
                          copy.version === group.loaded_version
                        ? ""
                        : copy.library_index === null
                          ? "Outside paths"
                          : "Later in search"}
                  </span>
                </div>
                {!inline && (
                  <p className="package-copy-path">
                    {copy.library_path ?? "Path unknown"}
                  </p>
                )}
                {!inline && (
                  <button
                    className="text-button package-copy-source"
                    aria-label={`Source for ${group.name} ${copy.version} in ${copy.library_index === null ? "outside paths" : `Library ${copy.library_index}`}`}
                    onClick={() => showSource(copy)}
                  >
                    {copy.source?.kind ?? "Not recorded"} · Source details
                  </button>
                )}
              </div>
            ))}
            {!detail?.loading && copies.length === 0 && !waiting && (
              <p className="muted">
                No readable copy metadata in this observation.
              </p>
            )}
          </section>
          {inline && selectedCopy && (
            <div className="package-detail-line package-inline-source">
              <span className="muted">
                Source ·{" "}
                {selectedCopy.library_index === null
                  ? "Outside paths"
                  : `Library ${selectedCopy.library_index}`}
              </span>
              <button
                className="text-button"
                onClick={() => showSource(selectedCopy)}
              >
                {source?.kind ?? "Not recorded"} · Details
              </button>
            </div>
          )}
          <details className="package-paths">
            <summary>Show library paths</summary>
            {copies.map((copy) => (
              <div key={packageCopyKey(copy)}>
                <strong>
                  {copy.library_index === null
                    ? "Outside current libraries"
                    : `Library ${copy.library_index}`}{" "}
                  · {copy.version}
                </strong>
                <p>{copy.library_path ?? "Unknown"}</p>
                {copy.built && <p className="muted">Built: {copy.built}</p>}
              </div>
            ))}
            {group.loaded_path && (
              <div>
                <strong>Loaded namespace path</strong>
                <p>{group.loaded_path}</p>
              </div>
            )}
          </details>
        </>
      )}
      {inline && selectedCopy && <button className="package-doc-button" title="View documentation for this installed copy"
        disabled={!selectedCopy.library_path || !p.session || p.expired || navigation.blocked || !navigation.canOpenDocumentation}
        onClick={() => navigation.openDocumentation(selectedCopy)}>Documentation · {selectedCopy.version}</button>}
      {agent?.annotate && <button className="package-doc-button" disabled={agent.blocked || !selectedCopy || !p.session || p.expired || p.stale} onClick={()=>{if(selectedCopy)agent.annotate?.(selectedCopy);}}>Annotate</button>}
      {agent && <button className="package-doc-button" disabled={agent.blocked || !agent.recovering && (!selectedCopy || !p.session || p.expired || p.stale)}
        onClick={() => {if(selectedCopy)agent.ask(selectedCopy);}}>Ask about…</button>}
      {detail?.next !== null && detail?.next !== undefined && (
        <button
          className="package-more-copies"
          disabled={detail.loading || session.runtime?.state === "busy"}
          onClick={() => void p.inspect(group.name, true)}
        >
          Show more copies ({copies.length} of {detail.total})
        </button>
      )}
    </section>
  );
}
