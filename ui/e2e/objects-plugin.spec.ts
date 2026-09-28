/** Isolated ordinary-package presentation and SDK actions. Host transactions and
 * real R observations are verified separately; this fixture establishes neither. */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { buildObjectsPlugin } from "../../scripts/build-objects-plugin.mjs";
let directory: string, root: string, server: Server, origin: string;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "rho-objects-view-")); root = buildObjectsPlugin(join(directory, "objects"));
  server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/") {
      response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><body style="margin:0"><nav style="height:36px;display:flex;gap:8px;padding:4px;box-sizing:border-box"></nav><main></main></body></html>'); return;
    }
    const file = resolve(root, "." + path);
    if (!file.startsWith(root + "/")) { response.writeHead(404).end(); return; }
    try {
      response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'none'; img-src data: blob:; frame-src 'none'");
      response.end(readFileSync(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(done => server.close(() => done())); if (directory) rmSync(directory, { recursive: true, force: true }); });

test("ordinary Objects keeps read-only content, independent object navigation and captured explicit actions", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(() => {
    const source = { instance: "r-one", plugin: "org.rho.r", revision: "sha256:" + "a".repeat(64), artifact: "sha256:" + "b".repeat(64) };
    const ui = { ...source, instance: "objects-one", plugin: "org.rho.objects" };
    const initial = { view: "directory", instance: ui, project: "project", principal: "principal", contribution: "objects", window: "window",
      configuration: { source, object_group: "main" }, state: {}, state_version: 0, closed: false };
    const fixture = { views: { directory: initial } as Record<string, any>, calls: [] as any[], records: [] as any[], failCapture: false, loseNextReply: false, hideOriginal: false,
      reopen: null as (() => void) | null,
      layout: { window: "window", project: "project", principal: "principal", version: 1, layout: { kind: "tabs", id: "main", views: ["directory"], selected: "directory" } } };
    (window as any).fixture = fixture;
    const value = (number: number | null, text: string | null = null) => ({ kind: "value", object_type: text === null ? "double" : "character", number,
      text, logical: null, imaginary: null, label: null, text_characters: text?.length ?? null, next_text_start: null });
    const metadata = (type: string, preview: any[], extra = {}) => ({ classes: [], object_type: type, kind: "value", length: preview.length,
      dimensions: [], supported_reads: ["structure", "values"], attributes: [], preview, notice: null, estimated_bytes: null, ...extra });
    const entries = [
      { name: "answer", metadata: metadata("double", [value(42)]) },
      { name: "label", metadata: metadata("character", [value(null, "中文 αβ")]) },
      { name: "palette", metadata: metadata("character", [value(null, "#2863d6"), value(null, "#25775b"), value(null, "#b33f49")]) },
      { name: "plot", metadata: metadata("list", [], { length: 4, classes: ["ggplot"], supported_reads: ["structure"] }) },
    ];
    const observation = (data: unknown) => ({ session_id: "native", source: "isolated-fixture", status: "ready", data,
      notices: [], observed_at_ms: Date.now(), completeness: "complete", diagnostic: null });
    const show = (id: string) => { for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) frame.style.display = frame.dataset.view === id ? "block" : "none"; };
    const mount = (view: any) => {
      const button = document.createElement("button"); button.textContent = view.contribution === "objects" ? "Objects" : `Object: ${view.configuration.object.name}`;
      button.onclick = () => show(view.view); document.querySelector("nav")!.append(button);
      const frame = document.createElement("iframe"); frame.sandbox.add("allow-scripts"); frame.dataset.view = view.view; frame.title = view.view;
      frame.style.cssText = "width:100vw;height:calc(100vh - 36px);border:0;display:block";
      frame.src = `/dist/index.html#rho-view-nonce=${view.view}`; document.querySelector("main")!.append(frame); show(view.view);
    };
    fixture.reopen = () => {
      const replacement = { ...structuredClone(fixture.views.directory), view: "replacement-directory", state_version: 0 };
      fixture.views[replacement.view] = replacement; mount(replacement);
    };
    window.addEventListener("message", event => {
      if (event.data?.type !== "rho:view:ready") return;
      const view = fixture.views[event.data.nonce]; if (!view) return;
      const channel = new MessageChannel(); let sequence = 0;
      channel.port1.onmessage = async event => {
        const message = event.data, body = message.body; fixture.calls.push({ view: view.view, ...structuredClone(body) });
        let result: any, error: string | undefined;
        if (body.type === "query") {
          const args = body.arguments.arguments;
          const name = args?.name ?? args?.object_ref?.slice(4), entry = entries.find(item => item.name === name);
          switch (body.capability.id) {
            case "r.inspection_state": result = { data: { session_id: "native", status: "ready", cache_key: "initial", notices: [], observed_at_ms: Date.now() } }; break;
            case "r.list_objects": result = { data: observation({ directory_ref: "directory-ref", entries, total: entries.length, offset: 0, next_offset: null, complete: true, observed_at_ms: Date.now(), notices: [] }) }; break;
            case "r.observe_object": result = { data: observation({ object_ref: `ref-${name}`, name, path: [], metadata: entry!.metadata, observed_at_ms: Date.now(), expires_at_ms: Date.now() + 60000 }) }; break;
            case "r.read_object": result = { data: observation({ object_ref: args.object_ref, root_name: name, observed_path: [], path: args.path ?? [], kind: args.kind,
              metadata: entry!.metadata, values: entry!.metadata.preview, columns: [], children: [], start: 1, next_start: null, column_start: 1, next_column_start: null,
              text_start: 1, next_text_start: null, observed_at_ms: Date.now(), complete: true, notices: [] }) }; break;
            case "windows.layout": result = { status: "ready", data: fixture.layout }; break;
            case "operation.get": result = { status: "ready", completeness: "complete", data: { record: fixture.records.find(record => record.operation.operation_id === body.arguments.operation_id) } }; break;
            case "operation.list_recent": result = { status: "ready", completeness: "complete", data: { operations: fixture.records.filter(record => !fixture.hideOriginal && record.operation.client_request_id === body.arguments.client_request_id).map(record => ({ operation_id: record.operation.operation_id })), next_cursor: null } }; break;
            default: error = `Unexpected query ${body.capability.id}`;
          }
        } else if (body.type === "set_state") {
          if (fixture.failCapture) error = "Fixture capture unavailable";
          else { view.state = body.state; view.state_version++; result = { status: "succeeded", output: view }; }
        } else if (body.type === "invoke") {
          result = { operation: { operation_id: `operation-${fixture.records.length + 1}`, caller: { kind: "plugin", id: view.view },
            client_request_id: `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${view.view}:${body.request_id}`))), byte => byte.toString(16).padStart(2, "0")).join("")}`, capability: body.capability, normalized_arguments: body.arguments }, status: "accepted", outcome: null };
          fixture.records.push(result);
          if (fixture.loseNextReply) { fixture.loseNextReply = false; error = "Fixture original reply lost"; }
          if (body.capability.id === "windows.open_view") {
            const opened = { ...body.arguments.view, view: `object-${fixture.records.length}`, project: "project", principal: "principal", state_version: 0, closed: false };
            fixture.views[opened.view] = opened; fixture.layout.version++; fixture.layout.layout.views.push(opened.view); fixture.layout.layout.selected = opened.view; mount(opened);
          }
        } else if (["register_close_handler", "observe_lifecycle"].includes(body.type)) {
          result = { view: view.view, state_version: view.state_version, close: { phase: "open" } };
        } else error = `Unexpected request ${body.type}`;
        channel.port1.postMessage({ protocol_version: 1, connection: `connection-${view.view}`, view: view.view, sequence: ++sequence, request: message.request,
          ok: !error, result: structuredClone(result), error });
      };
      (event.source as Window).postMessage({ type: "rho:view:connect", nonce: view.view, protocol_version: 1, connection: `connection-${view.view}`, view, features: ["view_close_v1"] }, "*", [channel.port2]);
    });
    mount(initial);
  });
  const directoryView = page.frameLocator('iframe[title="directory"]');
  await expect(directoryView.locator(".directory-content").getByText("42", { exact: true })).toBeVisible();
  await expect(directoryView.locator(".directory-content").getByText('"中文 αβ"', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.records.length)).toBe(0);
  const filter = directoryView.getByRole("textbox", { name: "Filter Objects" });
  await filter.fill("palette"); await expect(directoryView.locator(".object-row")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).fixture.views.directory.state))).toContain("palette");
  await filter.fill("");
  await directoryView.getByRole("button", { name: "Fields", exact: true }).click();
  await expect(directoryView.getByText("Show and arrange columns", { exact: true })).toBeVisible(); await page.keyboard.press("Escape");
  const answer = directoryView.locator(".object-entry").filter({ has: directoryView.locator('.object-name code', { hasText: /^answer$/ }) });
  await answer.getByRole("button", { name: "Open answer in New Tab", exact: true }).click();
  const detail = page.frameLocator('iframe[title="object-1"]'); await expect(detail.locator(".object-viewer-heading code")).toHaveText("answer");
  await expect(detail.getByText("42", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Objects", exact: true }).click();
  const plot = directoryView.locator(".object-entry").filter({ has: directoryView.locator('.object-name code', { hasText: /^plot$/ }) });
  await plot.locator(".object-name").click(); await expect(plot.getByRole("button", { name: "Render plot", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).fixture.failCapture = true; });
  await plot.getByRole("button", { name: "Render plot", exact: true }).click();
  await expect(directoryView.getByText("Action unconfirmed", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.records.length)).toBe(1);
  await page.evaluate(() => { (window as any).fixture.failCapture = false; });
  await directoryView.getByRole("button", { name: "Retry Original Request", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.records.length)).toBe(2);
  await expect(directoryView.getByText("Plot execution: accepted", { exact: false })).toBeVisible();
  await expect(directoryView.getByText("Fixture capture unavailable", { exact: true })).toHaveCount(0);
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => filter.evaluate(() => innerWidth)).toBe(width);
    await expect(filter).toBeVisible();
    expect(await filter.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await filter.click(); await expect(filter).toBeFocused();
    const inspected = await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "query" && call.capability.id === "operation.get").length);
    await directoryView.getByRole("button", { name: "Inspect Operation", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.type === "query" && call.capability.id === "operation.get").length)).toBe(inspected + 1);
    await filter.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`objects-plugin-${width}.png`) });
  }
  await page.evaluate(() => { (window as any).fixture.loseNextReply = true; });
  await plot.getByRole("button", { name: "Render plot", exact: true }).click();
  await expect(directoryView.getByText("Action unconfirmed", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.records.length)).toBe(3);
  const original = await page.evaluate(() => structuredClone((window as any).fixture.views.directory.state.actions.pending));
  await directoryView.getByRole("button", { name: "Set Aside", exact: true }).click();
  await expect(directoryView.getByText("Requests set aside (1)", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixture.records.length)).toBe(3);
  await expect(plot.getByRole("button", { name: "Render plot", exact: true })).toBeEnabled();
  await plot.getByRole("button", { name: "Render plot", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.records.length)).toBe(4);
  await expect.poll(() => page.evaluate(() => (window as any).fixture.views.directory.state.actions.pending)).toBeNull();
  expect(await page.evaluate(() => (window as any).fixture.views.directory.state.actions.retained)).toEqual([original]);
  await page.evaluate(() => { (window as any).fixture.reopen(); (window as any).fixture.hideOriginal = true; });
  const recovered = page.frameLocator('iframe[title="replacement-directory"]');
  await recovered.getByRole("button", { name: "Inspect Saved Request", exact: true }).click();
  await expect(recovered.getByText("No unique original Operation was found in this bounded observation. The request remains unconfirmed.", { exact: true })).toBeVisible();
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const savedRequest = recovered.getByRole("button", { name: "Inspect Saved Request", exact: true });
    await expect.poll(() => savedRequest.evaluate(() => innerWidth)).toBe(width);
    await expect(savedRequest).toBeInViewport();
    expect(await savedRequest.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await savedRequest.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`objects-retained-${width}.png`) });
  }
  await page.evaluate(() => { (window as any).fixture.hideOriginal = false; });
  await recovered.getByRole("button", { name: "Inspect Saved Request", exact: true }).click();
  await expect(recovered.getByText("Requests set aside (1)", { exact: true })).toBeHidden();
  expect(await page.evaluate(() => (window as any).fixture.views["replacement-directory"].state.actions.receipt.id)).toBe("operation-3");
  expect(await page.evaluate(() => (window as any).fixture.records.length)).toBe(4);
  await page.screenshot({ path: info.outputPath("objects-retained-recovered.png") });
  expect(errors).toEqual([]);
  const calls = await page.evaluate(() => (window as any).fixture.calls);
  const run = calls.find((call: any) => call.type === "invoke" && call.capability.id === "r.execute");
  expect(run.arguments.arguments).toMatchObject({ expected_session: "native", run: { code: "print(get(\"plot\", envir = .GlobalEnv, inherits = FALSE))", source: { view_id: "directory", label: "Objects" } } });
  expect(calls.some((call: any) => ["r.create_session", "r.respond_input"].includes(call.capability?.id))).toBe(false);
});
