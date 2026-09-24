/** Browser-only window presentation fixture; no Host, scientific runtime or SDK
 * authority is replaced by this fixture. Native window ports have Host tests. */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";

let directory: string, origin: string, server: Server;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "rho-plugin-layout-"));
  await build({ configFile: false, root: resolve("."), define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { outDir: directory, emptyOutDir: true,
    lib: { entry: resolve("e2e/fixtures/plugin-layout.tsx"), formats: ["es"], fileName: "fixture" }, minify: false }, logLevel: "error" });
  const files = readdirSync(directory), script = files.find(name => name.endsWith(".js"))!, css = files.find(name => name.endsWith(".css"));
  server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.end(`<!doctype html><html><head>${css ? `<link rel="stylesheet" href="/${css}">` : ""}</head><body style="margin:0"><div id="root"></div><script type="module" src="/${script}"></script></body></html>`); return; }
    const id = path.match(/^\/frame\/(first|second|third)$/)?.[1];
    if (id) {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><html><body style="font:14px sans-serif;margin:16px"><label>Draft <textarea aria-label="Draft" style="box-sizing:border-box;display:block;width:100%;height:160px"></textarea></label><p>Independent view: ${id}</p><script>window.lifetime=crypto.randomUUID();parent.postMessage({type:'loaded',id:'${id}'},'*')</script></body></html>`); return;
    }
    const name = path.slice(1);
    if (!files.includes(name)) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "text/javascript"); response.end(readFileSync(join(directory, name)));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(done => server.close(() => done())); if (directory) rmSync(directory, { recursive: true, force: true }); });

test("opaque plugin frames retain their document and unsaved input through docking, hiding and model replacement", async ({ page }, info) => {
  await page.goto(origin);
  const original = page.frameLocator('iframe[title="Original"]'), input = original.getByRole("textbox", { name: "Draft" });
  await input.fill("未保存的草稿 αβ\nThe exact old view remains alive.");
  const lifetime = await input.evaluate(() => (window as any).lifetime);
  await page.getByRole("tab", { name: "User branch", exact: true }).click(); await expect(input).toBeHidden();
  await page.getByRole("button", { name: "Show original", exact: true }).click(); await expect(input).toBeVisible();
  await page.getByRole("button", { name: "Move original to side", exact: true }).click();
  await expect(input).toBeVisible();
  await page.getByRole("button", { name: "Restore saved layout", exact: true }).click();
  await expect(input).toHaveValue("未保存的草稿 αβ\nThe exact old view remains alive.");
  await page.getByRole("button", { name: "Move original back", exact: true }).click();
  const from = await page.getByRole("tab", { name: "Original", exact: true }).boundingBox();
  const to = await page.getByRole("tab", { name: "Inspector", exact: true }).boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  await page.mouse.move(from!.x + 35, from!.y + 12); await page.mouse.down();
  await page.mouse.move(to!.x + 35, to!.y + 12, { steps: 16 }); await page.mouse.up();
  await expect.poll(() => page.getByRole("tab", { name: "Original", exact: true }).evaluate(element =>
    element.closest('[role="tablist"]')?.textContent)).toContain("Inspector");
  expect(await input.evaluate(() => (window as any).lifetime)).toBe(lifetime);
  await page.getByRole("button", { name: "Move original back", exact: true }).click();
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 });
    // CSS flow changes before the docking library measures its slots and the
    // stable frame layer follows them. Wait for those real rectangles to agree
    // before a coordinate-based click, especially when shrinking a wide iframe.
    await expect.poll(() => page.evaluate(() => {
      const tab = document.querySelector('[role="tab"][aria-label="Original"]');
      const slot = tab?.closest(".flexlayout__tabset")?.querySelector(".flexlayout__tabset_content");
      const frame = document.querySelector('[data-plugin-frame="first"]');
      if (!slot || !frame) return false;
      const a = slot.getBoundingClientRect(), b = frame.getBoundingClientRect();
      return a.width > 0 && ["x", "y", "width", "height"].every(key => Math.abs(a[key as keyof DOMRect] as number - (b[key as keyof DOMRect] as number)) < 1);
    })).toBe(true);
    await expect(input).toBeVisible(); await input.click(); await expect(input).toBeFocused();
    expect(await input.evaluate(() => (window as any).lifetime)).toBe(lifetime);
    await expect.poll(() => page.evaluate(() => (window as any).fixture.loads)).toEqual({ first: 1, second: 1, third: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`plugin-layout-${width}.png`) });
  }
  // Closing is an owner request. The docking library cannot discard the frame
  // while that owner still needs to flush state and acknowledge closure.
  await page.getByRole("tab", { name: "Original", exact: true }).locator('[data-layout-path$="/button/close"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.closes)).toEqual(["first"]);
  await expect(input).toHaveValue("未保存的草稿 αβ\nThe exact old view remains alive.");
});
