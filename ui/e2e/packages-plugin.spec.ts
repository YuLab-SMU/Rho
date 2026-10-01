/** Ordinary Packages + Help presentation fixture; native science is separate. */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { buildPackagesPlugin } from "../../scripts/build-packages-plugin.mjs";
import { buildHelpPlugin } from "../../scripts/build-help-plugin.mjs";
let directory: string, server: Server, origin: string;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "rho-packages-views-")); buildPackagesPlugin(join(directory, "packages")); buildHelpPlugin(join(directory, "help"));
  server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><body style="margin:0"><nav style="height:36px;display:flex;gap:8px;padding:4px;box-sizing:border-box"></nav><main></main></body></html>'); return; }
    const file = resolve(directory, "." + path);
    if (!file.startsWith(directory + "/")) { response.writeHead(404).end(); return; }
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
test("Packages preserves approved responsive inspection and opens Help for the selected installed copy", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await page.goto(origin);
  await page.evaluate(() => {
    const r = { instance: "r-one", plugin: "org.rho.r", revision: "sha256:" + "a".repeat(64), artifact: "sha256:" + "b".repeat(64) };
    const packages = { ...r, instance: "packages-one", plugin: "org.rho.packages" }, help = { ...r, instance: "help-one", plugin: "org.rho.help" };
    const view = { view: "packages", instance: packages, project: "project", principal: "principal", contribution: "packages", window: "window",
      configuration: { source: r, help, help_group: "main" }, state: {}, state_version: 0, closed: false };
    const fixture = { views: { packages: view } as Record<string, any>, calls: [] as any[], records: [] as any[], failSave: false, busy: false,
      layout: { project: "project", principal: "principal", window: "window", version: 1, layout: { kind: "tabs", id: "main", views: ["packages"], selected: "packages" } } };
    (window as any).fixture = fixture;
    const sources = (kind: string) => ({ kind, repository: kind === "GitHub" ? "tidyverse/dplyr" : null, repository_url: kind === "GitHub" ? "https://github.com/tidyverse/dplyr" : null,
      remote_host: kind === "GitHub" ? "github.com" : null, remote_ref: kind === "GitHub" ? "main" : null, remote_sha: kind === "GitHub" ? "abcdef1234567890" : null,
      delivery_url: null, provider: null, snapshot: null, evidence: kind === "Not recorded" ? [] : [{ field: "Repository", value: kind }],
      links: [{ label: "Project website", url: "https://dplyr.tidyverse.org/" }], notice: null });
    const groups = [
      { name: "dplyr", title: "A Grammar of Data Manipulation", version: "1.0.10", first_version: "1.1.4", primary_library_path: "/library/two", copy_count: 2,
        loaded_version: "1.0.10", loaded_path: "/library/two/dplyr", loaded_copy_observed: true, attached: false, source_kind: "CRAN", source_count: 2 },
      ...[["ggplot2", "Create Elegant Data Visualisations Using the Grammar of Graphics", "3.5.1"], ["stats", "The R Stats Package", "4.5.2"],
        ["tibble", "Simple Data Frames", "3.2.1"], ["researchTools", "Methods for multilingual observations 中文 αβ", "0.1.0"], ["tidyr", "Tidy Messy Data", "1.3.1"]].map(([name, title, version]) => ({
        name, title, version, first_version: version, primary_library_path: "/library/one", copy_count: 1, loaded_version: name === "stats" ? version : null,
        loaded_path: name === "stats" ? "/library/one/stats" : null, loaded_copy_observed: name === "stats", attached: name === "stats", source_kind: name === "researchTools" ? "Not recorded" : "CRAN", source_count: 1,
      })),
    ];
    const copies = (name: string) => (name === "dplyr" ? [["1.1.4", "/library/one", "GitHub"], ["1.0.10", "/library/two", "CRAN"]] : [[groups.find(g => g.name === name)!.version, "/library/one", "CRAN"]]).map(([version, library_path, kind], i) => ({
      name, version, title: groups.find(g => g.name === name)!.title, built: "R 4.5.2; aarch64-apple-darwin", library_path, library_index: i + 1, first_in_library_path: i === 0,
      loaded_version: name === "dplyr" ? "1.0.10" : null, loaded_path: name === "dplyr" ? "/library/two/dplyr" : null, loaded_from_library: name === "dplyr" && i === 1, attached: false, source: sources(kind),
    }));
    const observed = (data: unknown) => ({ session_id: "native", status: "ready", source: "fixture", data, observed_at_ms: 1, completeness: "complete", notices: [], diagnostic: null });
    const files = ["DESCRIPTION", "NAMESPACE", "help/AnIndex", "INDEX"].map(path => ({ path, digest: `digest-${path}` }));
    const show = (id: string) => { for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) frame.style.display = frame.dataset.view === id ? "block" : "none"; };
    const mount = (record: any) => {
      const button = document.createElement("button"); button.textContent = record.contribution === "packages" ? "Packages" : "Help"; button.onclick = () => show(record.view); document.querySelector("nav")!.append(button);
      const frame = document.createElement("iframe"); frame.sandbox.add("allow-scripts"); frame.dataset.view = record.view; frame.title = record.view;
      frame.style.cssText = "width:100vw;height:calc(100vh - 36px);border:0;display:block"; frame.src = `/${record.contribution}/dist/index.html#rho-view-nonce=${record.view}`;
      document.querySelector("main")!.append(frame); show(record.view);
    };
    window.addEventListener("message", event => {
      if (event.data?.type !== "rho:view:ready") return; const record = fixture.views[event.data.nonce]; if (!record) return;
      const channel = new MessageChannel(); let sequence = 0;
      channel.port1.onmessage = async event => {
        const message = event.data, body = message.body; fixture.calls.push({ view: record.view, ...structuredClone(body) }); let result: any, error: string | undefined;
        if (body.type === "query") {
          const args = body.arguments.arguments;
          if (body.capability.id === "r.inspection_state") result = { data: { session_id: "native", status: fixture.busy ? "busy" : "ready", cache_key: fixture.busy ? "busy" : "idle", observed_at_ms: 1, notices: [] } };
          else if (body.capability.id === "r.packages") result = { data: observed({ r_version: "4.5.2", r_home: "/R", platform: "aarch64-apple-darwin", library_paths: ["/library/one", "/library/two"],
            libraries: [1, 2].map(index => ({ index, path: index === 1 ? "/library/one" : "/library/two", status: "readable", notice: null })), mode: "installed", filter: "", offset: 0, next_offset: null,
            observation_id: "packages-original", observed_at_ms: 1, package_name: args.package_name, scanned: 7, scan_complete: true, notices: [],
            groups: args.package_name ? [] : groups, packages: args.package_name ? copies(args.package_name) : [], total_matches: args.package_name === "dplyr" ? 2 : args.package_name ? 1 : 6,
            counts: { all: 6, installed: 6, installations: 7, loaded: 2, attached: 1, multiple: 1 } }) };
          else if (body.capability.id === "r.package_index") result = { data: observed({ index_ref: "help-index", observation_id: args.observation_id, package: args.package, library_path: args.library_path, version: record.configuration.copy.version,
            files, description: [], entries: [{ kind: "topic", name: "intro", topic: "intro", title: "Introduction for the selected copy", declaration: null, resolved: true }], total: 1, offset: 0, next_offset: null, observed_at_ms: 1, complete: true, notices: [] }) };
          else if (body.capability.id === "r.read_help") {
            const text = `<h1>Selected copy ${record.configuration.copy.version}</h1><p>Documentation for ${args.library_path}.</p>`;
            result = { data: observed({ observation_id: args.observation_id, package: args.package, library_path: args.library_path, topic: args.topic, version: record.configuration.copy.version,
              found: true, text, format: "html", offset_utf8: 0, next_offset_utf8: null, total_bytes: new TextEncoder().encode(text).length, complete: true, help_files: files }) };
          } else if (body.capability.id === "windows.layout") result = { status: "ready", data: fixture.layout };
          else if (body.capability.id === "operation.get") result = { status: "ready", data: { record: fixture.records.find(item => item.operation.operation_id === body.arguments.operation_id) } };
          else error = `Unexpected query ${body.capability.id}`;
        } else if (body.type === "set_state") {
          if (fixture.failSave) error = "Fixture state capture failed"; else { record.state = body.state; record.state_version++; result = { status: "succeeded", output: record }; }
        } else if (body.type === "invoke" && body.capability.id === "windows.open_view") {
          const id = `navigation-${fixture.records.length + 1}`;
          result = { status: "succeeded", outcome: "succeeded", operation: { operation_id: id, caller: { kind: "plugin", id: record.view }, capability: body.capability,
            client_request_id: `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${record.view}:${body.request_id}`))), byte => byte.toString(16).padStart(2, "0")).join("")}`, normalized_arguments: body.arguments } };
          fixture.records.push(result); const opened = { ...body.arguments.view, view: `help-${fixture.records.length}`, project: "project", principal: "principal", state_version: 0, closed: false };
          fixture.views[opened.view] = opened; fixture.layout.version++; fixture.layout.layout.views.push(opened.view); fixture.layout.layout.selected = opened.view; mount(opened);
        } else if (["register_close_handler", "observe_lifecycle"].includes(body.type)) result = { view: record.view, state_version: record.state_version, close: { phase: "open" } };
        else if (body.type === "open_external_url") result = { navigation_requested: true };
        else error = `Unexpected request ${body.type}`;
        channel.port1.postMessage({ protocol_version: 1, connection: `connection-${record.view}`, view: record.view, sequence: ++sequence, request: message.request, ok: !error, result: structuredClone(result), error });
      };
      (event.source as Window).postMessage({ type: "rho:view:connect", nonce: record.view, protocol_version: 1, connection: `connection-${record.view}`, view: record, features: ["view_close_v1", "external_links_v1"] }, "*", [channel.port2]);
    }); mount(view);
  });
  const frame = page.frameLocator('iframe[title="packages"]'), filter = frame.getByRole("textbox", { name: "Search Packages" });
  await expect(frame.locator(".package-row")).toHaveCount(6); await expect(frame.locator(".package-list")).toContainText("A Grammar of Data Manipulation");
  expect(await page.evaluate(() => (window as any).fixture.records.length)).toBe(0);
  await frame.getByRole("button", { name: /^dplyr,/ }).click();
  await expect(frame.getByText("R is using 1.0.10.", { exact: false })).toBeVisible();
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 }); await expect.poll(() => filter.evaluate(() => innerWidth)).toBe(width);
    expect(await filter.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await filter.evaluate(() => document.fonts.ready); await page.screenshot({ path: info.outputPath(`packages-plugin-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await frame.getByRole("button", { name: "Source for dplyr 1.1.4 in Library 1", exact: true }).click();
  await expect(frame.locator(".package-source-heading")).toContainText("GitHub"); await expect(frame.getByText("Download repository not recorded.", { exact: true })).toBeVisible();
  await frame.getByRole("link", { name: "Project website", exact: false }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "open_external_url").length)).toBe(1);
  await page.screenshot({ path: info.outputPath("packages-source-wide.png") });
  await page.evaluate(() => { (window as any).fixture.busy = true; });
  await expect(frame.locator(".package-busy")).toContainText("R busy"); await expect(frame.getByRole("button", { name: "Refresh Packages", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("packages-busy-wide.png") });
  await page.evaluate(() => { (window as any).fixture.busy = false; }); await expect(frame.locator(".package-busy")).toHaveCount(0);
  await frame.getByRole("button", { name: /^R 4.5.2/ }).click(); await expect(frame.getByRole("dialog")).toContainText("/library/one"); await page.keyboard.press("Escape"); await expect(frame.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => { (window as any).fixture.failSave = true; });
  await frame.getByRole("button", { name: "Documentation", exact: true }).click(); await expect(frame.getByText("Navigation unconfirmed", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.records.length)).toBe(0);
  await page.evaluate(() => { (window as any).fixture.failSave = false; }); await frame.getByRole("button", { name: "Retry Original Request", exact: true }).click();
  const helpFrame = page.frameLocator('iframe[title="help-1"]'); await expect(helpFrame.getByRole("button", { name: /intro topic/ })).toBeVisible();
  await helpFrame.getByRole("button", { name: /intro topic/ }).click(); await expect(helpFrame.getByRole("heading", { name: "Selected copy 1.1.4", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.views["help-1"].configuration.copy)).toEqual({ nativeSession: "native", observation: "packages-original", package: "dplyr", libraryPath: "/library/one", version: "1.1.4" });
  await page.getByRole("button", { name: "Packages", exact: true }).click(); await expect(frame.getByText("Open documentation: succeeded", { exact: false })).toBeVisible();
  await frame.getByRole("button", { name: "Inspect Operation", exact: true }).click();
  await filter.fill("中文"); await expect(frame.locator(".package-row")).toHaveCount(1); await expect(frame.locator(".package-list")).toContainText("researchTools");
  expect(await page.evaluate(() => (window as any).fixture.calls.some((call: any) => call.capability?.id === "r.execute"))).toBe(false); expect(errors).toEqual([]);
});
