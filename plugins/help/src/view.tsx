import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Help } from "./help.js";
import { helpLink, staticHelpHtml } from "./content.js";

/** The existing Help reading layout, with explicit observed-copy topic selection.
 * Documentation is static; rendering and following a topic cannot execute R. */
export function HelpView({ help, copyText, openExternal }: { help: Help; copyText(text: string): Promise<void>; openExternal(url: string): Promise<void> }) {
  const state = useSyncExternalStore(help.subscribe, help.getSnapshot);
  const { copy, index, page, topic, raw, notice, loading, requiresNewObservation, indexVisible: topics } = state;
  const [linkNotice, setLinkNotice] = useState(""), [linkUrl, setLinkUrl] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const rendered = useMemo(() => page?.complete && page.found && page.format === "html" ? staticHelpHtml(page.text) : "", [page]);
  useLayoutEffect(() => { if (content.current) content.current.scrollTop = help.getSnapshot().scrollTop; }, [help, page?.complete, topic, raw, topics]);
  function follow(href: string) {
    setLinkNotice(""); setLinkUrl(""); const link = helpLink(href, copy.package);
    if (link.kind === "topic") help.open(link.topic);
    else if (link.kind === "anchor") content.current?.querySelector(`#${CSS.escape(link.id)}`)?.scrollIntoView({ block: "start" });
    else if (link.kind === "copy") setLinkNotice(`Select an installed copy of ${link.package} in Packages to read ${link.topic}.`);
    else if (link.kind === "external") {
      setLinkUrl(link.url);
      void openExternal(link.url).then(() => setLinkNotice("Documentation navigation requested in a new tab."), error => setLinkNotice(String(error)));
    }
    else setLinkNotice("This link is not a static Help topic in the selected copy.");
  }
  return <section className="help-panel">
    <header className="help-toolbar">
      <div className="help-identity" title={`${copy.package} ${copy.version}\n${copy.libraryPath}`}>
        <span className="help-package">{copy.package}</span>{topic && <><span className="help-separator">::</span><span className="help-topic">{topic}</span></>}
      </div>
      <span className="help-version">{copy.version}</span>
      <button onClick={() => help.setIndexVisible(!topics)} aria-expanded={topics}>Topics</button>
      {page?.found && <button className="help-toggle-raw" aria-pressed={raw} onClick={() => help.setRaw(!raw)}>{raw ? "Format" : "Raw"}</button>}
    </header>
    {(notice || requiresNewObservation) && <div className="help-notice" role="status">{notice}
      {requiresNewObservation ? <p>Select the installed copy again from a new Packages observation.</p> : !loading && help.needsObservation && <button onClick={() => help.retry()}>Retry Read</button>}
    </div>}
    {linkNotice && <div className="help-notice" role="status">{linkNotice}{linkUrl && <><code>{linkUrl}</code><button onClick={() => { void copyText(linkUrl).catch(error => setLinkNotice(String(error))); }}>Copy Link</button></>}
      <button aria-label="Dismiss link notice" onClick={() => { setLinkNotice(""); setLinkUrl(""); }}>Dismiss</button></div>}
    {topics ? <div className="help-topics">
      <label className="help-search">Help topics<input aria-label="Filter Help topics" value={state.filter} maxLength={128} placeholder="Search this installed copy"
        onChange={event => { try { help.search(event.target.value); } catch (error) { setLinkNotice(String(error)); } }} /></label>
      <label className="help-index-kind">Show <select aria-label="Help index entries" value={state.indexKind} onChange={event => help.setIndexKind(event.target.value as "topic" | "alias")}>
        <option value="topic">Topics</option><option value="alias">Aliases</option></select></label>
      {state.staleIndex && <p className="muted" role="status">{loading ? "Reading package index…" : "The index is waiting for its original observation."}</p>}
      {index?.notices.map((item, i) => <p className="help-notice" key={i}>{item}</p>)}
      <ul className="help-topic-list">{index?.entries.map((entry, i) => <li key={`${entry.kind}:${entry.name}:${i}`}>
        <button disabled={state.staleIndex || requiresNewObservation || !entry.topic} onClick={() => { if (entry.topic) { help.open(entry.topic); } }}>
          <span><code>{entry.name}</code><small>{entry.kind}{!entry.resolved && " · unresolved"}</small></span>{entry.title && <span>{entry.title}</span>}
        </button>{entry.declaration && <pre>{entry.declaration}</pre>}
      </li>)}</ul>
      {index && <footer className="help-index-footer"><span>{index.offset + index.entries.length} of {index.total} matches</span>
        {index.offset > 0 && <button disabled={state.staleIndex} onClick={() => help.indexPage(0)}>First Page</button>}
        {index.next_offset !== null && <button disabled={state.staleIndex} onClick={() => help.indexPage(index.next_offset!)}>Next Page</button>}</footer>}
    </div> : <div className="help-reader" ref={content} onScroll={event => help.setScroll(event.currentTarget.scrollTop)}>
      {!page && <p className="muted">{loading ? "Loading help…" : "Waiting for the selected Help topic."}</p>}
      {page && !page.found && <p className="muted">Help topic not found in this installed copy.</p>}
      {page?.found && (raw || page.format === "text" || !page.complete ? <pre className="help-raw">{page.text}</pre> :
        <div className="help-content" onClick={event => {
          const link = (event.target as Element).closest<HTMLElement>("[data-help-link]"); if (link) { event.preventDefault(); follow(link.dataset.helpLink!); }
        }} onKeyDown={event => { if (event.key === "Enter" && (event.target as HTMLElement).dataset.helpLink) { event.preventDefault(); follow((event.target as HTMLElement).dataset.helpLink!); } }}
          dangerouslySetInnerHTML={{ __html: rendered }} />)}
    </div>}
  </section>;
}
