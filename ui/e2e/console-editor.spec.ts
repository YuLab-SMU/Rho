/** Isolated ordinary-package editing checks. Native R acceptance is separate. */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { buildConsolePlugin } from "../../scripts/build-console-plugin.mjs";
let directory: string, root: string, server: Server, origin: string;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "rho-console-editor-"));
  root = buildConsolePlugin(join(directory, "console"));
  server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html><body style="margin:0"></body></html>'); return; }
    const file = resolve(root, "." + path);
    if (!file.startsWith(root + "/")) { response.writeHead(404).end(); return; }
    try {
      response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src data: blob:; frame-src 'none'");
      response.end(readFileSync(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(done => server.close(() => done())); if (directory) rmSync(directory, { recursive: true, force: true }); });

test("opaque Console package preserves editing, IME guards, queue controls and transient answers", async ({ page }, info) => {
  await page.goto(origin);
  await page.evaluate(() => {
    const owner = { instance: "r-one", plugin: "org.rho.r", revision: "sha256:" + "a".repeat(64), artifact: "sha256:" + "b".repeat(64) };
    const ui = { ...owner, instance: "console-one", plugin: "org.rho.console" };
    const view = { view: "console-view", instance: ui, project: "project", principal: "principal", contribution: "console", window: "window",
      configuration: { source: owner }, state: {}, state_version: 0, closed: false };
    const fixture = { calls: [] as any[], runs: [] as any[], events: [] as any[], view,
      queue: { console: { session_id: "native", current: null as any, pending: [] as any[], pause: null as any, input: null as any }, awaiting_commit: [], pending_cancellations: [], accepting: true, capacity: 33 } };
    (window as any).fixture = fixture;
    window.addEventListener("message", event => {
      if (event.data?.type !== "rho:view:ready") return;
      const channel = new MessageChannel(); let sequence = 0;
      channel.port1.onmessage = event => {
        const message = event.data, request = message.body; fixture.calls.push(structuredClone(request));
        let result: any;
        if (request.type === "query") {
          switch (request.capability.id) {
            case "operation.list_recent": result = { data: { operations: fixture.runs.map(run => ({ operation_id: run.operation.operation_id, capability: run.operation.capability })), next_cursor: null } }; break;
            case "operation.get": result = { data: { record: fixture.runs.find(run => run.operation.operation_id === request.arguments.operation_id) } }; break;
            case "r.session": result = { data: { state: fixture.queue.console.current ? "busy" : "idle", session_id: "native", queue_target: "native" } }; break;
            case "r.console": result = { data: fixture.queue }; break;
            case "r.check_code": result = { data: { status: request.arguments.arguments.code.trimEnd().endsWith("{") ? "incomplete" : "complete", indent: "  " } }; break;
            case "r.output_events": result = { data: { session_id: "native", output: { operation_id: request.arguments.arguments.operation_id,
              events: fixture.events.filter(event => event.sequence > request.arguments.arguments.after_sequence), next_sequence: fixture.events.at(-1)?.sequence ?? 0,
              has_more: false, gap: false, truncated: false, notices: [] } } }; break;
            default: throw new Error("Unexpected query " + request.capability.id);
          }
        } else if (request.type === "set_state") {
          view.state = request.state; view.state_version++; result = { status: "succeeded", output: view };
        } else if (request.type === "invoke") {
          const id = "run-" + (fixture.runs.length + 1);
          result = { operation: { operation_id: id, capability: request.capability, normalized_arguments: request.arguments, accepted_at_ms: Date.now() }, status: "succeeded", output: null };
          fixture.runs.push(result);
        } else if (request.type === "control") {
          if (request.capability.id === "r.respond_input") fixture.queue.console.input.submitted = true;
          result = { accepted: true };
        } else throw new Error("Unexpected view request");
        channel.port1.postMessage({ protocol_version: 1, connection: "connection", view: view.view, sequence: ++sequence, request: message.request, ok: true, result });
      };
      (event.source as Window).postMessage({ type: "rho:view:connect", nonce: "fixture", protocol_version: 1, connection: "connection", view }, "*", [channel.port2]);
    });
    const frame = document.createElement("iframe"); frame.sandbox.add("allow-scripts"); frame.style.cssText = "width:100vw;height:100vh;border:0;display:block";
    frame.src = "/dist/index.html#rho-view-nonce=fixture"; document.body.append(frame);
  });
  const frame = page.frameLocator("iframe"), input = frame.getByRole("textbox", { name: "Console Input", exact: true });
  await expect(frame.locator("#status")).toContainText("Ready");
  await input.fill("if (TRUE) {"); await input.press("Enter"); await expect(input).toContainText("if (TRUE) {");
  await expect(input.locator(".cm-line")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).fixture.runs.length)).toBe(0);
  await input.fill("中文 <- 42"); await input.press("Shift+Enter");
  expect(await page.evaluate(() => (window as any).fixture.runs.length)).toBe(0);
  await input.fill("中文 <- 42");
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中" }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  });
  expect(await page.evaluate(() => (window as any).fixture.runs.length)).toBe(0);
  // A deliberate subsequent key is independent of the synthetic commit key.
  await input.press("ArrowRight", { delay: 150 }); await input.press("Meta+Enter");
  await expect.poll(() => page.evaluate(() => (window as any).fixture.runs.length)).toBe(1);
  await expect(input).toHaveText("");
  await expect(frame.getByRole("textbox", { name: "Console Transcript", exact: true })).toContainText("中文 <- 42");
  await input.fill("next draft αβ"); await input.press("Home"); await input.press("ArrowUp");
  await expect(input).toContainText("中文 <- 42"); await input.press("Escape"); await input.press("Escape"); await expect(input).toContainText("next draft αβ");
  const transcript = frame.getByRole("textbox", { name: "Console Transcript", exact: true });
  await transcript.click();
  await transcript.evaluate(element => {
    const line = [...element.querySelectorAll(".cm-line")].find(line => line.textContent === "> 中文 <- 42")!;
    const range = document.createRange(); range.setStart(line.firstChild!, 2); range.setEnd(line.firstChild!, line.textContent!.length);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await expect.poll(() => transcript.evaluate(() => window.getSelection()?.toString())).toBe("中文 <- 42");
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.runs[0].status = "running";
    f.queue.console.current = { operation_id: "run-1", source: null, summary: "readline" };
    f.queue.console.input = { session_id: "native", operation_id: "run-1", request_id: "stdin-one", prompt: "Secret answer 中文", password: true, submitted: false };
  });
  await frame.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(transcript).toContainText("Running");
  await expect.poll(() => transcript.evaluate(() => window.getSelection()?.toString())).toBe("中文 <- 42");
  await expect(frame.getByRole("button", { name: "Answer Here" })).toBeVisible();
  await expect(input).toContainText("next draft αβ");
  await frame.getByRole("button", { name: "Answer Here" }).click();
  const answer = frame.getByLabel("R Input Answer");
  await expect(answer).toHaveAttribute("type", "password"); await expect(answer).toBeFocused();
  await answer.fill("do-not-save-中文"); await frame.getByRole("button", { name: "Send Answer" }).click();
  await expect(frame.locator("#input-status")).toContainText("Answer submitted");
  expect(await page.evaluate(() => JSON.stringify((window as any).fixture.view.state))).not.toContain("do-not-save");
  await expect(input).toContainText("next draft αβ");
  await frame.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.some((call: any) => call.capability?.id === "operation.request_cancellation" && call.arguments.only_if_pending === false))).toBe(true);
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.frames()[1].evaluate(() => innerWidth)).toBe(width);
    await expect(input).toBeVisible();
    const overflow = await page.frames()[1].evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.frames()[1].evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await page.screenshot({ path: info.outputPath(`console-editor-${width}.png`) });
  }
  await frame.getByRole("button", { name: "Clear View", exact: true }).click();
  await expect(frame.getByRole("textbox", { name: "Console Transcript", exact: true })).toHaveText("");
  await page.evaluate(() => { (window as any).fixture.events.push({operation_id:"run-1",sequence:1,kind:"stdout",
    text:"new output after clear 中文\n" + Array.from({length:80},(_,i)=>`retained line ${i}\n`).join(""),media:null,observed_at_ms:Date.now()}); });
  await frame.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(transcript).toContainText("new output after clear 中文");
  await expect(transcript).not.toContainText("中文 <- 42");
  await frame.locator("#transcript .cm-scroller").evaluate(element => { element.scrollTop = 240; });
  await expect.poll(() => page.evaluate(() => (window as any).fixture.view.state.scrollTop)).toBeGreaterThan(200);
  const savedScroll = await page.evaluate(() => (window as any).fixture.view.state.scrollTop);
  expect(await page.evaluate(() => (window as any).fixture.view.state.follow)).toBe(false);
  await page.locator("iframe").evaluate((element: HTMLIFrameElement) => { element.src = element.src; });
  await expect(input).toContainText("next draft αβ");
  await expect.poll(() => frame.locator("#transcript .cm-scroller").evaluate(element => element.scrollTop)).toBeCloseTo(savedScroll, 0);
  await frame.getByRole("button", { name: "Show History", exact: true }).click();
  await expect(frame.getByRole("textbox", { name: "Console Transcript", exact: true })).toContainText("中文 <- 42");
  expect(await page.evaluate(() => (window as any).fixture.runs.length)).toBe(1);
});
