import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

// An Agent answer is model output, so it is parsed as Markdown and sanitized
// before it can reach the document. Anchors keep their text and surface their
// target as visible text, but lose `href`: a generated link must never be able
// to navigate the workbench webview away from the project.
const ALLOWED_TAGS = [
  "p", "br", "hr", "span",
  "strong", "em", "del", "code", "pre",
  "blockquote", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "a", "table", "thead", "tbody", "tr", "th", "td",
];

export function agentMarkdownHtml(source: string): string {
  const parsed = marked.parse(source, { async: false, gfm: true, breaks: true }) as string;
  const fragment = DOMPurify.sanitize(parsed, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/iu,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;
  for (const anchor of fragment.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    anchor.removeAttribute("href");
    anchor.className = "rho-agent-md-link";
    if (href != null && !(anchor.textContent ?? "").includes(href)) {
      anchor.title = href;
      anchor.append(` (${href})`);
    }
  }
  const host = document.createElement("div");
  host.append(fragment);
  return host.innerHTML;
}

export function AgentMarkdown({ source, className }: {
  readonly source: string;
  readonly className: string;
}) {
  const html = useMemo(() => agentMarkdownHtml(source), [source]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
