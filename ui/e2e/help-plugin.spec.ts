/** Isolated ordinary Help package: presentation/SDK behavior, not native R truth. */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { buildHelpPlugin } from "../../scripts/build-help-plugin.mjs";
let directory: string, root: string, server: Server, origin: string;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "rho-help-view-")); root = buildHelpPlugin(join(directory, "help"));
  server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><body style="margin:0"></body></html>'); return; }
    const file = resolve(root, "." + path);
    if (!file.startsWith(root + "/")) { response.writeHead(404).end(); return; }
    try {
      response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'none'; img-src data: blob:; frame-src 'none'");
      response.end(readFileSync(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(done => server.close(() => done())); if (directory) rmSync(directory, { recursive: true, force: true }); });
test("ordinary Help preserves exact-copy reading, static links, Unicode and acknowledged choices", async ({ page }, info) => {
  const errors: string[] = [], network: string[] = []; page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith(origin)) network.push(request.url()); });
  await page.goto(origin);
  await page.evaluate(() => {
    const source = { instance: "r-one", plugin: "org.rho.r", revision: "sha256:" + "a".repeat(64), artifact: "sha256:" + "b".repeat(64) };
    const copy = { nativeSession: "native", observation: "packages-a", package: "demo", libraryPath: "/observed lib", version: "1.2.3" };
    const view = { view: "help", instance: { ...source, instance: "help-one", plugin: "org.rho.help" }, project: "project", principal: "principal", contribution: "help", window: "window",
      configuration: { source, copy, topic: "demo" }, state: {}, state_version: 0, closed: false };
    const fixture = { view, calls: [] as any[], busy: false, failSave: false, close: { phase: "open" } as any, copied: "" };
    (window as any).fixture = fixture;
    const files = ["DESCRIPTION", "NAMESPACE", "help/AnIndex", "INDEX"].map(path => ({ path, digest: `digest-${path}` }));
    const html = '<h1>Demonstration 中文</h1><h2>Usage</h2><pre>demo(x, method = "default")</pre><p>Static documentation from the selected installed copy.</p>' +
      '<p><a href="../../demo/help/another">Another topic</a> · <a href="../../stats/help/lm">Linear models</a> · <a href="https://r-project.org/">R project</a></p>' +
      '<img src="https://example.com/track" alt="Example image"><script>window.bad=true</script><form><button>Untrusted action</button></form>' +
      '<h2>Details</h2>' + '<p>Retained scrolling and Unicode: 中文 αβ.</p>'.repeat(80);
    const observation = (data: unknown) => ({ session_id: "native", source: "fixture", status: "ready", data, notices: [], observed_at_ms: 1, completeness: "complete", diagnostic: null });
    const mount = () => {
      document.querySelector("iframe")?.remove(); const frame = document.createElement("iframe"); frame.sandbox.add("allow-scripts"); frame.title = "Help";
      frame.style.cssText = "width:100vw;height:100vh;border:0;display:block"; frame.src = "/dist/index.html#rho-view-nonce=help"; document.body.append(frame);
    };
    (fixture as any).mount = mount;
    window.addEventListener("message", event => {
      if (event.data?.type !== "rho:view:ready") return;
      const channel = new MessageChannel(); let sequence = 0;
      channel.port1.onmessage = async event => {
        const message = event.data, body = message.body; fixture.calls.push(structuredClone(body)); let result: any, error: string | undefined;
        if (body.type === "query") {
          const args = body.arguments.arguments;
          if (body.capability.id === "r.inspection_state") result = { data: { session_id: "native", status: fixture.busy ? "busy" : "ready", cache_key: "idle", notices: [], observed_at_ms: 1 } };
          else if (body.capability.id === "r.package_index") {
            const entries = ["demo", "another"].filter(name => !args.filter || name.includes(args.filter)).map(name => ({ kind: "topic", name, topic: name, title: `Documentation for ${name}`, declaration: null, resolved: true }));
            result = { data: observation({ index_ref: "index", observation_id: copy.observation, package: copy.package, library_path: copy.libraryPath, version: copy.version,
              files, description: [], entries, total: entries.length, offset: 0, next_offset: null, observed_at_ms: 1, complete: true, notices: [] }) };
          } else if (body.capability.id === "r.read_help") {
            const text = args.topic === "demo" ? html : '<h1>Another topic</h1><p>Same observed copy.</p>';
            result = { data: observation({ observation_id: copy.observation, package: copy.package, library_path: copy.libraryPath, version: copy.version,
              topic: args.topic, found: true, text, offset_utf8: 0, next_offset_utf8: null, total_bytes: new TextEncoder().encode(text).length,
              complete: true, help_files: files, format: "html" }) };
          } else error = `Unexpected query ${body.capability.id}`;
        } else if (body.type === "set_state") {
          if (fixture.failSave) error = "Fixture storage failure"; else { view.state = body.state; view.state_version++; result = { status: "succeeded", output: view }; }
        } else if (["register_close_handler", "observe_lifecycle"].includes(body.type)) result = { view: view.view, state_version: view.state_version, close: fixture.close };
        else if (body.type === "prepare_close") { fixture.close = { phase: "prepared", operation: body.operation, state_version: body.state_version }; result = { view: view.view, state_version: view.state_version, close: fixture.close }; }
        else if (body.type === "refuse_close") { fixture.close = { phase: "refused", operation: body.operation, reason: body.reason }; result = { view: view.view, state_version: view.state_version, close: fixture.close }; }
        else error = `Unexpected request ${body.type}`;
        channel.port1.postMessage({ protocol_version: 1, connection: "help-connection", view: view.view, sequence: ++sequence, request: message.request,
          ok: !error, result: structuredClone(result), error });
      };
      (event.source as Window).postMessage({ type: "rho:view:connect", nonce: "help", protocol_version: 1, connection: "help-connection", view, features: ["view_close_v1"] }, "*", [channel.port2]);
    }); mount();
  });
  const frame = page.frameLocator('iframe[title="Help"]');
  await expect(frame.getByRole("heading", { name: "Demonstration 中文", exact: true })).toBeVisible();
  expect(await frame.locator(".help-content").evaluate(node => node.querySelectorAll("script,form,img,iframe,[src],[href]").length)).toBe(0);
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 }); await expect.poll(() => frame.locator(".help-panel").evaluate(() => innerWidth)).toBe(width);
    expect(await frame.locator(".help-panel").evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await frame.locator(".help-panel").evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`help-plugin-${width}.png`) });
  }
  await frame.getByRole("link", { name: "Linear models" }).click(); await expect(frame.getByText("Select an installed copy of stats", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.type === "query" && c.capability.id === "r.read_help").length)).toBe(1);
  await frame.getByRole("button", { name: "Dismiss link notice" }).click();
  await frame.getByRole("link", { name: "Another topic", exact: true }).click(); await expect(frame.getByRole("heading", { name: "Another topic", exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "Topics", exact: true }).click(); const filter = frame.getByRole("textbox", { name: "Filter Help topics" });
  await filter.fill("demo"); await expect(frame.locator(".help-topic-list li")).toHaveCount(1);
  await frame.locator(".help-topic-list").getByRole("button").click(); await expect(frame.getByRole("heading", { name: "Demonstration 中文", exact: true })).toBeVisible();
  await frame.locator(".help-reader").evaluate(node => { node.scrollTop = 850; });
  await expect.poll(() => page.evaluate(() => (window as any).fixture.view.state.choices?.scrollTop)).toBe(850);
  await page.evaluate(() => (window as any).fixture.mount());
  await expect.poll(() => frame.locator(".help-reader").evaluate(node => node.scrollTop)).toBe(850);
  await frame.getByRole("button", { name: "Raw", exact: true }).click(); await expect(frame.locator(".help-raw")).toContainText('<h1>Demonstration 中文</h1>');
  await page.evaluate(() => { (window as any).fixture.close = { phase: "requested", operation: "closing" }; });
  await expect.poll(() => page.evaluate(() => (window as any).fixture.close.phase)).toBe("prepared");
  expect(await page.evaluate(() => (window as any).fixture.view.state.choices.raw)).toBe(true);
  const reads = await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.type === "query"));
  expect(reads.every((read: any) => read.arguments.binding.provider.instance === "r-one" && read.arguments.binding.target === "native")).toBe(true);
  expect(errors).toEqual([]); expect(network).toEqual([]);
});
