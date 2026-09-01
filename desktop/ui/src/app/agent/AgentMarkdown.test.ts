import { describe, expect, it } from "vitest";

import { agentMarkdownHtml } from "./AgentMarkdown";

describe("Agent answer Markdown", () => {
  it("renders emphasis, lists, and fenced code as structure", () => {
    const html = agentMarkdownHtml("**2026-09-02** is the date\n\n- first\n- second\n\n```r\nsummary(fit)\n```");
    expect(html).toContain("<strong>2026-09-02</strong>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<pre>");
    expect(html).toContain("summary(fit)");
    expect(html).not.toContain("**");
  });

  it("keeps a single newline as a line break", () => {
    expect(agentMarkdownHtml("first line\nsecond line")).toContain("<br>");
  });

  it("drops script, event handlers, and embedded markup", () => {
    const html = agentMarkdownHtml("<script>alert(1)</script><img src=x onerror=alert(2)><iframe src=\"https://example.com\"></iframe>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
  });

  it("renders a link without a navigable target and shows where it pointed", () => {
    const html = agentMarkdownHtml("see [the docs](https://example.com/guide)");
    expect(html).not.toContain("href");
    expect(html).toContain("the docs");
    expect(html).toContain("https://example.com/guide");
  });

  it("refuses a javascript URL outright", () => {
    const html = agentMarkdownHtml("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });
});
