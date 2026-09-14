import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string, url: string, endpoint: string, host: ChildProcess, model: Server;
let requests: unknown[] = [];
const scienceRequest="SCIENCE_LIVE_TEST: Run Sys.sleep(4), plot(1:3), and print SCIENCE_BROWSER_DONE in Main.";
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rho-component-browser-"));
  const project = join(directory, "study"); await mkdir(project);
  await writeFile(join(project, "notes.txt"), "A retained native file source.\nValidation marker: RHO_NATIVE_FILE_3847_ALPHA\n");
  await writeFile(join(project, "analysis.R"), "x <- 1\nprint(x)\n");
  model = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const input = JSON.parse(body); requests.push(input);
    const serialized = JSON.stringify(input), marker = serialized.match(/rho-check-[0-9a-f-]+/)?.[0];
    const verify = input.tools?.some((tool: { name: string }) => tool.name === "component_verify") && !marker;
    const science=serialized.includes(scienceRequest);
    const usedTools=input.messages?.flatMap((message:{content:unknown})=>Array.isArray(message.content)?message.content:[]).filter((part:{type?:string})=>part.type==="tool_use").map((part:{name:string})=>part.name)??[];
    const scientificTool= science && !usedTools.includes("rho_task_intent") ? {name:"rho_task_intent",input:{request_excerpt:scienceRequest,actions:[{action:"execute",document_id:null,path:null}]}} : science && !usedTools.includes("workspace_run_r") ? {name:"workspace_run_r",input:{code:'Sys.sleep(4); plot(1:3); cat("SCIENCE_BROWSER_DONE\\n")'}} : null;
    const answer = science ? "SCIENCE_BROWSER_DONE. The original R operation returned." : marker ?? (serialized.includes("synthetic image") ? serialized.includes("nGP4z8CA") ? "red" : serialized.includes("nGNg+M+AH") ? "green" : "blue" : serialized.includes("LONG_STREAM") ? "A long streamed explanation with retained source references.\n".repeat(80) : "The selected context is available. This is a streamed fixture response.");
    if (!input.stream) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ id: "fixture", type: "message", role: "assistant", content: [{ type: "text", text: answer }], model: "fixture", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 8 } })); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (value: object) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    event({ type: "message_start", message: { id: "fixture", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    if(scientificTool){
      event({type:"content_block_start",index:0,content_block:{type:"tool_use",id:`science-${scientificTool.name}`,name:scientificTool.name,input:{}}});
      event({type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:JSON.stringify(scientificTool.input)}});
      event({type:"content_block_stop",index:0});event({type:"message_delta",delta:{stop_reason:"tool_use",stop_sequence:null},usage:{output_tokens:8}});event({type:"message_stop"});response.end();return;
    }
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
  host = spawn(resolve("../target/debug/rho"), ["--database", join(directory, "state.sqlite"), "--project", project, "workbench", ...((process.env.RHO_BROWSER_DEV_ASSETS || process.env.RHO_COMPONENT_BROWSER_DEV_ASSETS) ? ["--dev-assets", resolve((process.env.RHO_BROWSER_DEV_ASSETS || process.env.RHO_COMPONENT_BROWSER_DEV_ASSETS)!)] : [])], { env: { ...process.env, RHO_COMPONENT_BROWSER_KEY: process.env.RHO_COMPONENT_BROWSER_REAL_MODEL ? process.env.RHO_COMPONENT_BROWSER_SECRET : "fixture-only" }, stdio: ["ignore", "pipe", "pipe"] });
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
  await expect(page.getByLabel("Agent panel", {exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Rho Assistant",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"External tasks",exact:true})).toHaveCount(0);
}
async function create(page: Page) {
  await page.locator('.agent-panel button[aria-label="New task"]:visible').first().click();
  await page.getByRole("menuitem",{name:"Rho",exact:true}).click();
  await expect(page.getByRole("textbox", { name: "Agent message", exact: true })).toBeEditable();
  if (await page.getByRole("button",{name:"Configure Rho",exact:true}).isVisible()) await configure(page);
}
async function configure(page: Page) {
  await page.locator('.agent-panel button[aria-label="Agent Settings"]').click();
  const settings = page.getByLabel("Rho settings",{exact:true});
  await settings.getByLabel("Enable Rho").check();
  await settings.getByLabel("Base URL", { exact: true }).fill(process.env.RHO_COMPONENT_BROWSER_REAL_MODEL ? process.env.RHO_COMPONENT_BROWSER_URL! : endpoint);
  await settings.getByLabel("Model ID", { exact: true }).fill(process.env.RHO_COMPONENT_BROWSER_REAL_MODEL || "fixture");
  await settings.getByText("Credential source",{exact:true}).click();
  await settings.getByLabel("Credential source",{exact:true}).selectOption("environment");
  await settings.getByLabel("Environment variable name").fill("RHO_COMPONENT_BROWSER_KEY");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Test connection", exact: true })).toBeEnabled();
  await page.getByRole("button",{name:"Back to workspace",exact:true}).click();
}
test("component entry, retained draft, fixed native source and streamed model response", async ({ page }) => {
  const before = requests.length;
  await page.goto(url);
  await page.getByRole("button", { name: "Ask about Files / Project", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Agent message", exact: true });
  await expect(input).toBeEditable(); await input.fill("Explain this file.");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  expect(requests.length).toBe(before);
  await configure(page);
  await expect(input).toHaveValue("Explain this file.");
  await page.getByRole("button", { name: "Add context", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add workspace context" });
  await picker.getByLabel("Context source type").selectOption("files");
  await picker.getByRole("button", { name: /notes.txt/ }).click();
  await expect(picker).toContainText("A retained native file source.");
  await picker.getByRole("button", { name: "Add context", exact: true }).click();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Agent turn")).toContainText("streamed fixture response", { timeout: 20000 });
  await expect(input).toHaveValue("");
  expect(requests.length).toBe(before + 1);
  expect(JSON.stringify(requests.at(-1))).toContain("A retained native file source.");
  await input.fill("Retain this later draft.");
  await expect(page.locator(".at-composer-region")).toContainText("Draft saved");
  await page.reload();
  await expect(input).toHaveValue("Retain this later draft.");
  expect(requests.length).toBe(before + 1);
  await page.screenshot({ path: "../target/studio-browser/component-normal.png" });
});
test("second window reads conversation and takes control without submitting a model prompt", async ({ page, context }) => {
  const before = requests.length; await open(page); await create(page);
  const input = page.getByRole("textbox", { name: "Agent message", exact: true });
  await input.fill("First window draft");
  await expect(page.locator(".at-composer-region")).toContainText("Draft saved");
  const second = await context.newPage(); await open(second);
  const remote = second.getByRole("textbox", { name: "Agent message", exact: true });
  await expect(remote).toHaveValue("First window draft"); await expect(remote).not.toBeEditable();
  await second.getByRole("button", { name: "Take over", exact: true }).click();
  await expect(remote).toBeEditable(); await expect(input).not.toBeEditable();
  expect(requests.length).toBe(before); await second.close();
});
test("component composer fits constrained and wide workspaces without changing model state", async ({ page }, testInfo) => {
  const before = requests.length; await open(page); await create(page);
  const panel=page.getByLabel("Agent panel",{exact:true});
  await panel.locator('input[type="file"]').setInputFiles({name:"long-reproducible-analysis-context-and-experimental-groups.md",mimeType:"text/markdown",buffer:Buffer.from("A representative local attachment for layout inspection.")});
  await expect(panel.locator(".at-asset")).toBeVisible();
  await panel.getByRole("textbox",{name:"Agent message",exact:true}).fill("请比较这份实验数据，并保留分析步骤。\nCompare the experimental groups and explain the next analysis step.");
  await panel.getByRole("button",{name:"Task actions",exact:true}).click();await page.getByRole("menuitem",{name:"Rename",exact:true}).click();
  await panel.getByRole("textbox",{name:"Task title",exact:true}).fill("Compare experimental groups with reproducible analysis context");await panel.getByRole("textbox",{name:"Task title",exact:true}).press("Enter");
  const group = page.locator(".flexlayout__tabset").filter({ has: page.getByRole("tab", { name: "Agent", exact: true }) });
  await group.getByRole("button", { name: "Maximize tab set", exact: true }).click();
  await expect(panel.locator(".at-draft-status")).toHaveText("Draft saved");
  const measurements: unknown[]=[];
  for (const width of [386, 600, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    if(width===386)await expect.poll(async()=>Math.round((await panel.boundingBox())!.width)).toBe(320);
    const panelBounds=await panel.boundingBox();
    const composer = page.locator(".at-composer-region"); await expect(composer).toBeVisible();
    const sizes = await composer.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.width + 1);
    const box = await composer.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const send=await panel.getByRole("button",{name:"Send message",exact:true}).boundingBox();expect(send!.y+send!.height).toBeLessThanOrEqual(panelBounds!.y+panelBounds!.height);
    measurements.push({window:page.viewportSize(),panel:panelBounds,composer:box});
    if (width >= 1024) await expect(page.getByLabel("Project tasks", { exact: true })).toBeVisible();
    await expect(page.getByRole("button",{name:"Drafts synced",exact:true})).toBeVisible();
    const inputBox=await panel.getByRole("textbox",{name:"Agent message",exact:true}).boundingBox(),bodyBox=await panel.locator(".at-composer-content").boundingBox();
    expect(inputBox!.y+inputBox!.height).toBeLessThanOrEqual(bodyBox!.y+bodyBox!.height+1);
    await expect.poll(()=>panel.getByRole("textbox",{name:"Agent message",exact:true}).evaluate(node=>node.scrollHeight-node.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `../target/studio-browser/component-${width===386?"320-panel":width}.png` });
  }
  expect(requests.length).toBe(before);
  await testInfo.attach("layout-measurements",{body:JSON.stringify(measurements,null,2),contentType:"application/json"});
});

test("explicit diagnostic buttons test synthetic content and preserve conversation drafts", async ({ page }) => {
  await open(page); await create(page);
  await page.getByRole("textbox", { name: "Agent message", exact: true }).fill("Private draft must stay out of tests");
  const before = requests.length;
  await page.locator('.agent-panel button[aria-label="Agent Settings"]').click();
  const settings = page.getByLabel("Rho settings",{exact:true});
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
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Agent turn")).toContainText("streamed fixture response", { timeout: 20000 });
  await page.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await expect(page.getByLabel("Agent turn")).toContainText("Stopped", { timeout: 20000 });
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.locator(".at-composer-region")).toContainText("Original actions checked");
  expect(requests.length).toBe(before + 1);
  await input.fill("Finish after stop");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".ca-turn > p > small").last()).toContainText(/^Response complete$/, { timeout: 20000 });
  expect(requests.length).toBe(before + 2);
});
test("Rho permissions do not select explain edit or run work modes", async ({ page }) => {
  await open(page); await create(page);
  const input = page.getByRole("textbox", { name: "Agent message", exact: true });
  await page.getByRole("button",{name:"Permission mode",exact:true}).click();
  for (const name of ["Ask","Auto approval","Full access"]) await expect(page.getByRole("menuitem").filter({has:page.getByText(name,{exact:true})})).toBeVisible();
  await page.getByRole("menuitem").filter({has:page.getByText("Full access",{exact:true})}).click();
  await expect(page.getByLabel("Assistant mode",{exact:true})).toHaveCount(0);
  await input.fill("Explain the workspace");
  const before=requests.length;
  const posted=page.waitForRequest(request=>request.url().endsWith("/api/agents/components/command")&&request.postDataJSON()?.command.kind==="start");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  expect((await posted).postDataJSON().command.request.grant.permission_policy).toBe("full_access");
  await expect(page.locator(".ca-turn > p > small").last()).toContainText(/^Response complete$/,{timeout:20000});
  expect(requests.length).toBe(before+1);
});

test("document Ask binds the observed draft while the Agent chooses its work", async ({ page }) => {
  await page.goto(url);
  await page.getByRole("button", { name: "R analysis.R", exact: true }).dblclick();
  await expect(page.getByRole("tab", { name: "analysis.R", exact: true })).toBeVisible();
  const group = page.locator(".flexlayout__tabset").filter({ has: page.getByRole("tab", { name: "analysis.R", exact: true }) });
  await group.getByRole("button", { name: "Ask about Documents", exact: true }).click();
  await expect(page.locator(".at-context-chips")).toContainText("analysis.R");
  if (await page.getByRole("button", { name: "Configure Rho", exact: true }).isVisible()) await configure(page);
  await page.getByRole("textbox", { name: "Agent message", exact: true }).fill("Review this captured script.");
  const posted = page.waitForRequest(request => request.url().endsWith("/api/agents/components/command") && request.postDataJSON()?.command.kind === "start");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const request = (await posted).postDataJSON().command.request;
  expect(request.grant.permission_policy).toBe("ask");
  expect(request.grant.documents).toHaveLength(1);
  expect(request.grant.documents[0]).toMatchObject({ path: "analysis.R", allow_save: false });
  expect(request.grant.documents[0].document).toEqual(request.sources.find((s: { source: string }) => s.source === "editor").reference.document);
  await expect(page.locator(".ca-turn > p > small").last()).toContainText(/^Response complete$/, { timeout: 20000 });
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
  await expect(page.locator(".at-composer-region")).toContainText("Draft saved");
  expect(commands.filter(c => c.kind === "start")).toHaveLength(0);
  await input.press("Enter");
  await expect(page.locator(".ca-turn > p > small").last()).toContainText(/^Response complete$/, { timeout: 20000 });
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
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Agent turn")).toContainText("streamed fixture response");
  const active = await measure();
  await page.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await expect(page.getByLabel("Agent turn")).toContainText("Stopped");
  expect(active.typingP95).toBeLessThan(Math.max(150, baseline.typingP95 * 3));
  expect(active.frameP95).toBeLessThan(Math.max(100, baseline.frameP95 * 3));
  const report = { baseline, active, provider: "local protocol fixture", measurement: "keydown to second animation frame; same console input on same Host; no R execution" };
  await writeFile(testInfo.outputPath("performance.json"), JSON.stringify(report, null, 2));
  await testInfo.attach("performance", { body: JSON.stringify(report), contentType: "application/json" });
});

test("long replies follow the stream while preserving an explicit earlier reading position", async ({ page }) => {
  await open(page); await create(page);
  const input = page.getByRole("textbox", { name: "Agent message", exact: true });
  await input.fill("LONG_STREAM"); await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".ca-turn > p > small").last()).toContainText(/^Response complete$/);
  const history = page.locator(".at-conversation");
  await expect.poll(() => history.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(40);
  await history.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  await input.fill("A short follow-up."); await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".ca-turn")).toHaveCount(2);
  await expect(page.locator(".ca-turn > p > small").last()).toContainText(/^Response complete$/);
  expect(await history.evaluate(node => node.scrollTop)).toBeLessThan(40);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(() => history.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(40);
});

test("opt-in real model reads a native file through the approved Studio UI", async ({ page }) => {
  test.skip(!process.env.RHO_COMPONENT_BROWSER_REAL_MODEL, "Requires an explicitly authorized real model service.");
  test.setTimeout(180000);
  await open(page); await create(page);
  await page.getByRole("button", { name: "Add context", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add workspace context" });
  await picker.getByLabel("Context source type").selectOption("files");
  await picker.getByRole("button", { name: /notes.txt/ }).click();
  await expect(picker).toContainText("RHO_NATIVE_FILE_3847_ALPHA");
  await picker.getByRole("button", { name: "Add context", exact: true }).click();
  await page.getByRole("textbox", { name: "Agent message", exact: true }).fill("Quote the validation marker from the selected notes.txt file, then cite the file. Keep the answer short.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".at-message-assistant .at-message-text")).toContainText("RHO_NATIVE_FILE_3847_ALPHA", { timeout: 150000 });
  await expect(page.locator(".ca-turn > p > small").last()).toContainText(/^Response complete$/, { timeout: 150000 });
  await page.screenshot({ path: "../target/studio-browser/component-real-model.png" });
});

test("opt-in real model edits saves and executes through the resident Studio bridge", async ({ page }) => {
  test.skip(!process.env.RHO_COMPONENT_BROWSER_REAL_MODEL, "Requires an explicitly authorized real model service and real R.");
  test.setTimeout(660000);
  await page.goto(url);
  await expect(page.locator(".console-status > span").first()).toHaveText("Ready", { timeout: 60000 });
  await page.getByRole("button", { name: "R analysis.R", exact: true }).dblclick();
  const group = page.locator(".flexlayout__tabset").filter({ has: page.getByRole("tab", { name: "analysis.R", exact: true }) });
  await group.getByRole("button", { name: "Ask about Documents", exact: true }).click();
  await expect(page.locator(".at-context-chips")).toContainText("analysis.R");
  if (await page.getByRole("button", { name: "Configure Rho", exact: true }).isVisible()) await configure(page);
  await page.getByRole("textbox", { name: "Agent message", exact: true }).fill("Change the selected analysis.R script so x is assigned 42 and then printed. Save it to its existing path and execute the whole saved script in the authorized R session. Verify the actual result and cite the original execution. Do not only propose code.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".ca-turn > p > small").last()).toContainText(/^Response complete$/, { timeout: 620000 });
  const saved = await readFile(join(directory, "study", "analysis.R"), "utf8");
  expect(saved).toMatch(/x\s*(?:<-|=)\s*42/);
  await expect(page.locator(".console-transcript")).toContainText("[1] 42", { timeout: 20000 });
  await expect(page.locator(".ca-tool")).not.toHaveCount(0);
  await page.screenshot({ path: "../target/studio-browser/component-real-model-execution.png" });
});

test("Rho uploads previews and sends owned attachments through the shared composer", async ({page}) => {
  await open(page); await create(page); const before=requests.length;
  const panel=page.getByLabel("Agent panel",{exact:true});
  await panel.locator('input[type="file"]').setInputFiles({name:"attached.md",mimeType:"text/markdown",buffer:Buffer.from("Attachment marker: RHO_UPLOAD_2197\n")});
  await expect(panel.locator(".at-asset")).toContainText("attached.md");
  await panel.locator(".at-asset-main").click();
  const preview=page.getByRole("dialog",{name:"Preview attachment",exact:true});
  await expect(preview).toContainText("RHO_UPLOAD_2197"); await preview.getByRole("button",{name:"Close attachment preview",exact:true}).click();
  expect(requests.length).toBe(before);
  const posted=page.waitForRequest(request=>request.url().endsWith("/api/agents/components/command")&&request.postDataJSON()?.command.kind==="start");
  await panel.getByRole("button",{name:"Send message",exact:true}).click();
  const request=(await posted).postDataJSON().command.request; expect(request.text).toBe(""); expect(request.assets).toHaveLength(1);
  await expect(panel.locator(".ca-turn > p > small").last()).toContainText("Response complete",{timeout:20000});
  expect(JSON.stringify(requests.slice(before))).toContain("RHO_UPLOAD_2197");
  await expect(panel.locator(".at-sent-asset").first()).toContainText("attached.md");
  await panel.getByRole("button",{name:"Remove attached.md",exact:true}).click(); await expect(panel.locator(".at-asset")).toHaveCount(0);
  await expect(panel.locator(".at-sent-asset").first()).toContainText("attached.md");
});

test("Rho paste and drop attachments retain the message without starting a model", async ({page}) => {
  await open(page); await create(page); const before=requests.length;
  const input=page.getByRole("textbox",{name:"Agent message",exact:true}); await input.fill("Keep this draft");
  await input.evaluate(node=>{const transfer=new DataTransfer();transfer.items.add(new File(["pasted data"],"pasted.txt",{type:"text/plain"}));node.dispatchEvent(new ClipboardEvent("paste",{clipboardData:transfer,bubbles:true,cancelable:true}));});
  await expect(page.locator(".at-assets")).toContainText("pasted.txt");
  await page.locator(".at-composer").evaluate(node=>{const transfer=new DataTransfer();transfer.items.add(new File(["dropped data"],"dropped.txt",{type:"text/plain"}));node.dispatchEvent(new DragEvent("drop",{dataTransfer:transfer,bubbles:true,cancelable:true}));});
  await expect(page.locator(".at-assets")).toContainText("dropped.txt"); await expect(input).toHaveValue("Keep this draft"); expect(requests.length).toBe(before);
});

test("Rho scientific work follows the original R operation and opens its real result",async({page})=>{
  await open(page);await expect(page.locator(".console-status > span").first()).toHaveText("Ready",{timeout:60000});await create(page);
  await page.getByRole("textbox",{name:"Agent message",exact:true}).fill(scienceRequest);await page.getByRole("button",{name:"Send message",exact:true}).click();
  const work=page.getByLabel("Scientific work",{exact:true});await expect(work).toContainText("1 active",{timeout:20000});
  await work.locator("summary").click();const original=work.locator("[data-operation-id]");await expect(original).toContainText(/Running|Accepted/);
  const id=await original.getAttribute("data-operation-id");expect(id).toBeTruthy();await page.screenshot({path:"../target/studio-browser/component-scientific-running.png"});
  await expect(page.locator(".ca-turn > p > small").last()).toContainText("Response complete",{timeout:20000});await expect(original).toContainText("Succeeded");
  await expect(work).toContainText("R session · Main");await expect(page.locator(".console-transcript")).toContainText("SCIENCE_BROWSER_DONE");
  await expect(work.getByRole("button",{name:/Open original plot/})).toBeVisible();expect(await original.getAttribute("data-operation-id")).toBe(id);
  await work.getByRole("button",{name:/Open original plot/}).click();await expect(page.locator(".plot-original img").first()).toBeVisible();
  await page.screenshot({path:"../target/studio-browser/component-scientific-complete.png"});
});
