import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string, url: string, endpoint: string, host: ChildProcess, model: Server;
let requests: unknown[] = [];
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rho-component-browser-"));
  const project = join(directory, "study"); await mkdir(project);
  await writeFile(join(project, "notes.txt"), "A retained native file source.\n");
  await writeFile(join(project, "analysis.R"), "x <- 1\nprint(x)\n");
  model = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const input = JSON.parse(body); requests.push(input);
    const serialized = JSON.stringify(input), marker = serialized.match(/rho-check-[0-9a-f-]+/)?.[0];
    const verify = input.tools?.some((tool: { name: string }) => tool.name === "component_verify") && !marker;
    const answer = marker ?? (serialized.includes("synthetic image") ? serialized.includes("nGP4z8CA") ? "red" : serialized.includes("nGNg+M+AH") ? "green" : "blue" : "The selected context is available. This is a streamed fixture response.");
    if (!input.stream) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ id: "fixture", type: "message", role: "assistant", content: [{ type: "text", text: answer }], model: "fixture", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 8 } })); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (value: object) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    event({ type: "message_start", message: { id: "fixture", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    if (verify) {
      event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "verification-call", name: "component_verify", input: {} } });
      event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
      event({ type: "content_block_stop", index: 0 });
      event({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } });
      event({ type: "message_stop" }); response.end(); return;
    }
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } });
    if (serialized.includes("WAIT_FOR_STOP") && !serialized.includes("Finish after stop")) return;
    event({ type: "content_block_stop", index: 0 });
    event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } });
    event({ type: "message_stop" }); response.end();
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
  host = spawn(resolve("../target/debug/rho"), ["--database", join(directory, "state.sqlite"), "--project", project, "workbench", ...(process.env.RHO_COMPONENT_BROWSER_DEV_ASSETS ? ["--dev-assets", resolve(process.env.RHO_COMPONENT_BROWSER_DEV_ASSETS)] : [])], { env: { ...process.env, RHO_COMPONENT_BROWSER_KEY: "fixture-only" }, stdio: ["ignore", "pipe", "pipe"] });
  url = await new Promise<string>((resolve, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Host startup: ${errors}`)), 40000);
    host.stderr!.on("data", data => errors += data);
    host.stdout!.on("data", data => { output += data; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/); if (found) { clearTimeout(timer); resolve(found[0]); } });
    host.once("exit", code => { clearTimeout(timer); reject(new Error(`Host exited ${code}: ${errors}`)); });
  });
});
test.afterAll(async () => {
  if (host?.exitCode === null) { host.kill("SIGINT"); await new Promise<void>(resolve => { const timer = setTimeout(() => { host.kill("SIGKILL"); resolve(); }, 10000); host.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
  await new Promise<void>(resolve => model?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function open(page: Page) {
  await page.goto(url); await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Rho Assistant", exact: true }).click();
  await expect(page.getByLabel("New assistant conversation")).toBeVisible();
}
async function create(page: Page, profile = "project") {
  await page.getByLabel("New assistant conversation").selectOption(profile);
  await expect(page.getByRole("textbox", { name: "Agent message", exact: true })).toBeEditable();
  if (await page.locator(".ca-composer").getByRole("button", { name: "Configure model", exact: true }).isVisible()) await configure(page);
}
async function configure(page: Page) {
  await page.getByLabel("Assistant model settings").click();
  const settings = page.getByLabel("Built-in assistant settings");
  await settings.getByLabel("Enable built-in assistant").check();
  await settings.getByLabel("Base URL", { exact: true }).fill(endpoint);
  await settings.getByLabel("Model ID", { exact: true }).fill("fixture");
  await settings.getByLabel("Credential lifetime").selectOption("environment");
  await settings.getByLabel("Environment variable name").fill("RHO_COMPONENT_BROWSER_KEY");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Test connection", exact: true })).toBeEnabled();
  await page.getByLabel("Assistant model settings").click();
}
test("component entry, retained draft, fixed native source and streamed model response", async ({ page }) => {
  const before = requests.length;
  await page.goto(url);
  await page.getByRole("button", { name: "Ask about Files / Project", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Agent message", exact: true });
  await expect(input).toBeEditable(); await input.fill("Explain this file.");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  expect(requests.length).toBe(before);
  await configure(page);
  await expect(input).toHaveValue("Explain this file.");
  await page.getByRole("button", { name: "＋ Context", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Assistant sources" });
  await picker.getByLabel("Assistant source type").selectOption("files");
  await picker.getByRole("button", { name: /notes.txt/ }).click();
  await expect(picker).toContainText("A retained native file source.");
  await picker.getByRole("button", { name: "Add context", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Assistant run")).toContainText("streamed fixture response", { timeout: 20000 });
  await expect(input).toHaveValue("");
  expect(requests.length).toBe(before + 1);
  expect(JSON.stringify(requests.at(-1))).toContain("A retained native file source.");
  await input.fill("Retain this later draft.");
  await expect(page.locator(".ca-composer")).toContainText("Draft saved");
  await page.reload(); await page.getByRole("button", { name: "Rho Assistant", exact: true }).click();
  await expect(input).toHaveValue("Retain this later draft.");
  expect(requests.length).toBe(before + 1);
  await page.screenshot({ path: "../target/studio-browser/component-normal.png" });
});
test("second window reads conversation and takes control without submitting a model prompt", async ({ page, context }) => {
  const before = requests.length; await open(page); await create(page);
  const input = page.getByRole("textbox", { name: "Agent message", exact: true });
  await input.fill("First window draft");
  await expect(page.locator(".ca-composer")).toContainText("Draft saved");
  const id = await page.getByLabel("Assistant conversation", { exact: true }).inputValue();
  const second = await context.newPage(); await open(second);
  await second.getByLabel("Assistant conversation", { exact: true }).selectOption(id);
  const remote = second.getByRole("textbox", { name: "Agent message", exact: true });
  await expect(remote).toHaveValue("First window draft"); await expect(remote).not.toBeEditable();
  await second.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(remote).toBeEditable(); await expect(input).not.toBeEditable();
  expect(requests.length).toBe(before); await second.close();
});
test("component composer fits constrained and wide workspaces without changing model state", async ({ page }) => {
  const before = requests.length; await open(page); await create(page);
  const group = page.locator(".flexlayout__tabset").filter({ has: page.getByRole("tab", { name: "Agent", exact: true }) });
  await group.getByRole("button", { name: "Maximize tab set", exact: true }).click();
  for (const width of [384, 600, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const composer = page.locator(".ca-composer"); await expect(composer).toBeVisible();
    const sizes = await composer.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.width + 1);
    const box = await composer.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    if (width >= 1024) await expect(page.getByLabel("Assistant conversations", { exact: true })).toBeVisible();
    await page.screenshot({ path: `../target/studio-browser/component-${width}.png` });
  }
  expect(requests.length).toBe(before);
});

test("explicit diagnostic buttons test synthetic content and preserve conversation drafts", async ({ page }) => {
  await open(page); await create(page);
  await page.getByRole("textbox", { name: "Agent message", exact: true }).fill("Private draft must stay out of tests");
  const before = requests.length;
  await page.getByLabel("Assistant model settings").click();
  const settings = page.getByLabel("Built-in assistant settings");
  await settings.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(settings).toContainText("Connection · passed", { timeout: 20000 });
  await settings.getByRole("button", { name: "Test image input", exact: true }).click();
  await expect(settings).toContainText("Image input · passed", { timeout: 20000 });
  expect(JSON.stringify(requests.slice(before))).not.toContain("Private draft");
  await page.screenshot({ path: "../target/studio-browser/component-settings.png" });
});
test("stopping reconciles the original run and Continue is an explicit new submission", async ({ page }) => {
  await open(page); await create(page);
  const input = page.getByRole("textbox", { name: "Agent message", exact: true });
  await input.fill("WAIT_FOR_STOP");
  const before = requests.length;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Assistant run")).toContainText("streamed fixture response", { timeout: 20000 });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByLabel("Assistant run")).toContainText("stopped", { timeout: 20000 });
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.locator(".ca-composer")).toContainText("Original actions checked");
  expect(requests.length).toBe(before + 1);
  await input.fill("Finish after stop");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Assistant run").last()).toContainText("completed", { timeout: 20000 });
  expect(requests.length).toBe(before + 2);
});
test("a rejected edit preserves the draft and can be corrected without an uncertain replay", async ({ page }) => {
  await open(page); await create(page);
  const input = page.getByRole("textbox", { name: "Agent message", exact: true });
  await input.fill("Explain the workspace");
  await page.getByLabel("Assistant mode", { exact: true }).selectOption("edit");
  const before = requests.length;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/Edit requires|Open the authorized target as a document/);
  await expect(input).toHaveValue("Explain the workspace");
  await page.getByLabel("Assistant mode", { exact: true }).selectOption("explain");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Assistant run")).toContainText("completed", { timeout: 20000 });
  expect(requests.length).toBe(before + 1);
});

test("document Ask binds the observed draft and explicit save/run scope", async ({ page }) => {
  await page.goto(url);
  await page.getByRole("button", { name: "R analysis.R", exact: true }).dblclick();
  await expect(page.getByRole("tab", { name: "analysis.R", exact: true })).toBeVisible();
  const group = page.locator(".flexlayout__tabset").filter({ has: page.getByRole("tab", { name: "analysis.R", exact: true }) });
  await group.getByRole("button", { name: "Ask about Documents", exact: true }).click();
  await expect(page.locator(".ca-sources")).toContainText("analysis.R");
  if (await page.locator(".ca-composer").getByRole("button", { name: "Configure model", exact: true }).isVisible()) await configure(page);
  await page.getByLabel("Assistant mode", { exact: true }).selectOption("run");
  await page.getByLabel("Allow saving analysis.R").check();
  await page.getByRole("textbox", { name: "Agent message", exact: true }).fill("Review this captured script.");
  const posted = page.waitForRequest(request => request.url().endsWith("/api/agents/components/command") && request.postDataJSON()?.command.kind === "start");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const request = (await posted).postDataJSON().command.request;
  expect(request.grant.mode).toBe("run");
  expect(request.grant.documents).toHaveLength(1);
  expect(request.grant.documents[0]).toMatchObject({ path: "analysis.R", allow_save: true });
  expect(request.grant.documents[0].document).toEqual(request.sources.find((s: { source: string }) => s.source === "editor").reference.document);
  await expect(page.getByLabel("Assistant run")).toContainText("completed", { timeout: 20000 });
});

test("component IME preserves native preedit across observation and sends only after explicit Enter", async ({ page, context }) => {
  await open(page); await create(page);
  const input = page.getByRole("textbox", { name: "Agent message", exact: true }); await input.click();
  const commands: any[] = [];
  page.on("request", request => { if (request.url().endsWith("/api/agents/components/command")) commands.push(request.postDataJSON().command); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
  await page.waitForTimeout(2200);
  await expect(input).toHaveValue("nihao");
  expect(commands.filter(c => c.kind === "save_draft" || c.kind === "start")).toHaveLength(0);
  await cdp.send("Input.insertText", { text: "你好" });
  await expect(input).toHaveValue("你好");
  await expect(page.locator(".ca-composer")).toContainText("Draft saved");
  expect(commands.filter(c => c.kind === "start")).toHaveLength(0);
  await input.press("Enter");
  await expect(page.getByLabel("Assistant run")).toContainText("completed", { timeout: 20000 });
  expect(commands.filter(c => c.kind === "start").map(c => c.request.text)).toEqual(["你好"]);
  await cdp.detach();
});

test("typing and frame latency stay bounded while the model stream is active", async ({ page }, testInfo) => {
  await open(page); await create(page);
  async function measure() {
    await page.evaluate(() => {
      const state = { input: [] as number[], frames: [] as number[], active: true, last: performance.now() };
      (window as any).__componentPerformance = state;
      const listener = (event: KeyboardEvent) => {
        if (state.active && (event.target as Element)?.closest(".console-panel") && event.key.length === 1) {
          const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => state.input.push(performance.now() - start)));
        }
      };
      document.addEventListener("keydown", listener, true);
      (state as any).dispose = () => document.removeEventListener("keydown", listener, true);
      requestAnimationFrame(function frame(now) { if (!state.active) return; state.frames.push(now - state.last); state.last = now; requestAnimationFrame(frame); });
    });
    const input = page.getByRole("textbox", { name: "Console Input", exact: true });
    await input.fill(""); await input.pressSequentially("component latency sample ".repeat(3), { delay: 10 });
    const result = await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const state = (window as any).__componentPerformance; state.active = false; state.dispose();
      const p95 = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length * .95)];
      return { typingP95: p95(state.input), frameP95: p95(state.frames), samples: state.input.length, heapBytes: (performance as any).memory?.usedJSHeapSize ?? null };
    });
    expect(result.samples).toBeGreaterThan(30); return result;
  }
  const before = requests.length, baseline = await measure(); expect(requests.length).toBe(before);
  await page.getByRole("textbox", { name: "Agent message", exact: true }).fill("WAIT_FOR_STOP");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Assistant run")).toContainText("streamed fixture response");
  const active = await measure();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByLabel("Assistant run")).toContainText("stopped");
  expect(active.typingP95).toBeLessThan(Math.max(150, baseline.typingP95 * 3));
  expect(active.frameP95).toBeLessThan(Math.max(100, baseline.frameP95 * 3));
  const report = { baseline, active, provider: "local protocol fixture", measurement: "keydown to second animation frame; same console input on same Host; no R execution" };
  await writeFile(testInfo.outputPath("performance.json"), JSON.stringify(report, null, 2));
  await testInfo.attach("performance", { body: JSON.stringify(report), contentType: "application/json" });
});
