import { expect, it, vi } from "vitest";
import { requestExternalNavigation } from "../src/plugin-external";
it("severs a fresh tab's opener before requesting navigation without a referrer", () => {
  let opener: unknown = "parent", clicked = false;
  const link = { href: "", rel: "", referrerPolicy: "", target: "", click() {
    expect(opener).toBeNull(); expect(this.rel).toBe("noreferrer noopener"); expect(this.referrerPolicy).toBe("no-referrer"); expect(this.target).toBe("_self"); clicked = true;
  } };
  const target = { set opener(value: unknown) { opener = value; }, document: { createElement: vi.fn(() => link), body: { append: vi.fn() } }, close: vi.fn() };
  expect(requestExternalNavigation("https://example.org/中文?q=1#topic", () => target as unknown as Window)).toEqual({ navigation_requested: true });
  expect(clicked).toBe(true); expect(link.href).toBe("https://example.org/%E4%B8%AD%E6%96%87?q=1#topic"); expect(target.close).not.toHaveBeenCalled();
});
it("invalid URLs and popup refusal are not reported as navigation", () => {
  const open = vi.fn(() => null);
  for (const url of ["javascript:alert(1)", "file:///private", "//example.org", "https://user:pass@example.org/", "https://example.org/ bad", "https://example.org/\\bad"])
    expect(() => requestExternalNavigation(url, open)).toThrow();
  expect(open).not.toHaveBeenCalled(); expect(() => requestExternalNavigation("https://example.org", open)).toThrow("blocked");
});
it("failed preparation closes only the freshly created blank tab", () => {
  const target = { opener: "parent", document: { createElement() { throw new Error("unavailable"); } }, close: vi.fn() };
  expect(() => requestExternalNavigation("https://example.org", () => target as unknown as Window)).toThrow("could not request");
  expect(target.close).toHaveBeenCalledOnce();
});
