/** Help is static documentation. Rebuild a small structural HTML subset in an
 * inert template. No original element, style, handler, URL or resource is mounted. */
const tags = new Set("a abbr b blockquote br caption center code col colgroup dd del div dl dt em h1 h2 h3 h4 h5 h6 hr i kbd li ol p pre s samp small span strong sub sup table tbody td th thead tr tt u ul var".split(" "));
const discard = new Set("title script style iframe frame frameset object embed template noscript svg math form input textarea button select option link meta base".split(" "));
const anchorId = (value: string) => `rho-help-${encodeURIComponent(value)}`;
export function staticHelpHtml(html: string): string {
  const source = document.createElement("template"), target = document.createElement("template");
  source.innerHTML = html;
  const pending: Array<{ input: Node; output: Node }> = [...source.content.childNodes].reverse().map(input => ({ input, output: target.content }));
  while (pending.length) {
    const { input, output } = pending.pop()!;
    if (input.nodeType === Node.TEXT_NODE) { output.appendChild(document.createTextNode(input.textContent ?? "")); continue; }
    if (!(input instanceof Element)) continue;
    const tag = input.localName.toLowerCase(); if (discard.has(tag)) continue;
    if (tag === "img") { const alt = input.getAttribute("alt"); output.appendChild(document.createTextNode(alt ? `[Image: ${alt}]` : "[Image]")); continue; }
    let destination = output;
    if (tags.has(tag)) {
      const element = document.createElement(tag);
      const id = input.getAttribute("id") ?? (tag === "a" ? input.getAttribute("name") : null);
      if (id && id.length <= 512) element.id = anchorId(id);
      if (tag === "a") {
        const href = input.getAttribute("href");
        // The delegated handler interprets this inert value; there is no native
        // link navigation, base URL, popup, download or network request.
        if (href && href.length <= 8192) { element.dataset.helpLink = href; element.setAttribute("role", "link"); element.tabIndex = 0; }
      }
      for (const key of ["colspan", "rowspan"]) if (["td", "th"].includes(tag)) {
        const value = input.getAttribute(key); if (value && /^\d{1,3}$/.test(value) && +value > 0) element.setAttribute(key, value);
      }
      output.appendChild(element); destination = element;
    }
    for (const child of [...input.childNodes].reverse()) pending.push({ input: child, output: destination });
  }
  return target.innerHTML;
}
export type HelpLink = { kind: "anchor"; id: string } | { kind: "topic"; topic: string } |
  { kind: "copy"; package: string; topic: string } | { kind: "external"; url: string } | { kind: "unsupported" };
export function helpLink(href: string, pkg: string): HelpLink {
  try {
    if (href.startsWith("#")) return { kind: "anchor", id: anchorId(decodeURIComponent(href.slice(1))) };
    if (/^https?:\/\//i.test(href)) {
      const url = new URL(href); if (url.username || url.password) return { kind: "unsupported" };
      return { kind: "external", url: url.href };
    }
    // No protocol-relative links or schemes, including javascript and file.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith("//")) return { kind: "unsupported" };
    const url = new URL(href, `https://rho-help.invalid/library/${encodeURIComponent(pkg)}/html/current.html`);
    const parts = /^\/library\/([^/]+)\/(?:help|html)\/([^/]+)$/.exec(url.pathname);
    if (!parts || url.search || url.origin !== "https://rho-help.invalid") return { kind: "unsupported" };
    const targetPackage = decodeURIComponent(parts[1]), topic = decodeURIComponent(parts[2].replace(/\.html$/, ""));
    if (!/^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(targetPackage) || !topic.trim() || /[\u0000-\u001f\u007f/\\]/.test(topic) || new TextEncoder().encode(topic).length > 128)
      return { kind: "unsupported" };
    return targetPackage === pkg ? { kind: "topic", topic } : { kind: "copy", package: targetPackage, topic };
  } catch { return { kind: "unsupported" }; }
}
