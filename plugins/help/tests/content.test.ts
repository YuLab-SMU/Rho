// @vitest-environment jsdom
import { expect, it } from "vitest";
import { helpLink, staticHelpHtml } from "../src/content.js";
it("rebuilds static Help without executable elements, resource URLs, styles or forged cooperation fields", () => {
  const html = staticHelpHtml('<h2 id="usage">Usage</h2><p onclick="evil()" style="background:url(https://example.com)">中文 <em>text</em></p>' +
    '<img src="https://example.com/track" onerror="evil()" alt="example"><a href="../../demo/help/topic" target="_top" download data-help-link="javascript:evil()">Topic</a>' +
    '<script>evil()</script><iframe srcdoc="evil"></iframe><svg><a href="javascript:evil()">bad</a></svg><form><button>Submit</button></form>' +
    '<table><tr><td colspan="2">value</td></tr></table>');
  const node = document.createElement("div"); node.innerHTML = html;
  expect(node.querySelectorAll("script,iframe,svg,form,button,img,[style],[onclick],[src],[href],[target],[download]")).toHaveLength(0);
  expect(node.querySelector("a")?.dataset.helpLink).toBe("../../demo/help/topic");
  expect(node.querySelector("h2")?.id).toBe("rho-help-usage"); expect(node.textContent).toContain("中文 text[Image: example]Topic");
  expect(node.querySelector("td")?.colSpan).toBe(2);
});
it("same-package links preserve the exact copy while cross-package links require another selection", () => {
  expect(helpLink("../../demo/help/another", "demo")).toEqual({ kind: "topic", topic: "another" });
  expect(helpLink("another.html", "demo")).toEqual({ kind: "topic", topic: "another" });
  expect(helpLink("../../stats/html/lm.html", "demo")).toEqual({ kind: "copy", package: "stats", topic: "lm" });
  expect(helpLink("#%E4%B8%AD", "demo")).toEqual({ kind: "anchor", id: "rho-help-%E4%B8%AD" });
  expect(helpLink("https://r-project.org/a", "demo")).toEqual({ kind: "external", url: "https://r-project.org/a" });
});
it.each(["javascript:alert(1)", "file:///private", "//example.com", "../../demo/help/%2Ftmp", "../../demo/help/x?run=1", "https://user:password@example.com", "../../demo/help/%QQ"])("keeps unsupported destinations inert: %s", href => {
  expect(helpLink(href, "demo")).toEqual({ kind: "unsupported" });
});
