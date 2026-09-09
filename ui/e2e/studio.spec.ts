import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentClientSession } from "../src/generated/AgentClientSession";
import type { AgentClientAction } from "../src/generated/AgentClientAction";
import type { ConnectAgent } from "../src/generated/ConnectAgent";
import type { DiscoverAgent } from "../src/generated/DiscoverAgent";
import type { LocalAgent } from "../src/generated/LocalAgent";

function nativeAgentCatalog(request: DiscoverAgent): LocalAgent {
  const codex = request.provider === "codex";
  return {
    provider: request.provider, executable: codex ? "/fixture/bin/codex" : "/fixture/bin/kimi", version: codex ? "0.153.4" : "0.41.0",
    models: codex ? [
      { id: "native-balanced", name: "Native Balanced", efforts: ["low", "high"], default_effort: "low" },
      { id: "native-detailed", name: "Native Detailed", efforts: ["medium", "high"], default_effort: "medium" },
    ] : [{ id: "configured/flash", name: "Configured Flash", efforts: [], default_effort: null }],
    selected_model: request.model ?? (codex ? "native-balanced" : "configured/flash"),
    selected_effort: codex ? request.model === "native-detailed" ? "medium" : "low" : null,
    discovery_ms: 150, error: null,
  };
}

let directory: string, url: string, host: ReturnType<typeof spawn>;
async function startHost(extra: string[] = []) {
  host = spawn(
    resolve("../target/debug/rho"),
    [
      "--database",
      join(directory, "next.sqlite"),
      "--project",
      join(directory, "中文项目"),
      "workbench",
      ...extra,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  url = await new Promise<string>((resolve, reject) => {
    let output = "",
      errors = "";
    const timeout = setTimeout(
      () => reject(new Error(`Host startup timed out: ${errors}`)),
      40000,
    );
    host.stderr!.on("data", (b) => (errors += b));
    host.stdout!.on("data", (b) => {
      output += b;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-z0-9]+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    host.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Host exited ${code}: ${errors}`));
    });
  });
}
async function stopHost() {
  if (host?.exitCode === null) {
    host.kill("SIGINT");
    await new Promise<void>((resolve) => host.once("exit", () => resolve()));
  }
}
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rho-studio-"));
  await mkdir(join(directory, "中文项目"));
  await startHost();
});
test.afterAll(async () => {
  await stopHost();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function resetLayout(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Reset Layout", exact: true })
    .click();
}
async function newFile(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "New R File", exact: true }).click();
}
async function openFile(page: import("@playwright/test").Page, path: string) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open File…", exact: true }).click();
  await page.getByRole("dialog").getByLabel("File Path").fill(path);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Open", exact: true })
    .click();
}
test.afterEach(async () => {
  const state = (await queryNative("workspace.console_state")).data;
  if (state?.pause) {
    await api("/api/host", {
      project_root: (await (await api("/api/info")).json()).project_root,
      frame: {
        id: crypto.randomUUID(),
        request: {
          method: "invoke",
          params: {
            client_request_id: crypto.randomUUID(),
            capability: { id: "workspace.resume_queue", version: 1 },
            arguments: {
              session_id: state.session_id,
              pause_id: state.pause.id,
            },
            preconditions: [],
          },
        },
      },
    });
  }
});
test("real Console, settings and docking shell", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await expect(page.getByText("中文项目", { exact: true })).toBeVisible();
  await expect(page.locator(".console-prompt .primary").first()).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Console Input" })
    .fill('cat("Studio R ready\\n")');
  await page.locator(".console-prompt .primary").first().click();
  await expect(page.getByText("Studio R ready", { exact: true })).toBeVisible();
  await expect(page.locator(".console-status > span").first()).toHaveText(
    "Ready",
  );
  await page.getByRole("button", { name: "Environment", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText("jsonlite Available · rlang Available · Ark Available"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({ path: "../target/studio-browser/m1-shell.png" });
  expect(errors).toEqual([]);
});

test("incremental output precedes completion and plots keep their identity", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  const input = page.getByRole("textbox", { name: "Console Input" });
  await input.fill(
    'cat("first-live\\n"); Sys.sleep(3); cat("second-live\\n"); plot(1:4)',
  );
  await page.locator(".console-prompt .primary").first().click();
  await expect(
    page
      .locator(".console-transcript")
      .getByText("first-live", { exact: true }),
  ).toBeVisible({ timeout: 2500 });
  await expect(page.locator(".console-status > span").first()).toHaveText(
    "Running",
  );
  await expect(
    page
      .locator(".console-transcript")
      .getByText("second-live", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".plot-original img").last()).toBeVisible();
  await page.locator(".console-plot-link").last().click();
  await expect(page.locator(".plot-original img")).toBeVisible();
  const original = await page.locator(".plot-original img").getAttribute("src");
  await input.fill(
    'plot(4:1); cat("before failure\\n"); stop("expected studio failure")',
  );
  await page.locator(".console-prompt .primary").first().click();
  await expect(page.locator(".queue-notice").first()).toBeVisible();
  await expect(
    page
      .locator(".console-transcript")
      .getByText("before failure", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".console-plot-link")).toHaveCount(2);
  await expect(page.locator(".plot-original img")).toHaveAttribute(
    "src",
    original!,
  );
  await page.getByRole("button", { name: "Next Plot" }).click();
  await expect(page.locator(".plot-original img")).not.toHaveAttribute(
    "src",
    original!,
  );
  expect(errors).toEqual([]);
});

test("create a Chinese R file, save-run, inspect objects and edit-run again", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await newFile(page);
  const editor = page.locator(".document-panel .cm-content");
  await editor.fill(
    'studio_data <- data.frame(组别 = c("甲", "乙"), value = c(1, 2))\ncat("saved file ran\\n")\nplot(studio_data$value)\n',
  );
  await page.getByRole("button", { name: "Run File", exact: true }).click();
  await page.getByLabel("File Path", { exact: true }).fill("分析脚本.R");
  await page.getByRole("button", { name: "Save and Run", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .locator(".console-transcript")
      .getByText("saved file ran", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".save-status")).toHaveText("✓ Saved");
  await expect(
    page
      .getByRole("button")
      .filter({ has: page.locator("code", { hasText: "studio_data" }) }),
  ).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.locator("code", { hasText: "studio_data" }) })
    .click();
  await expect(page.locator(".objects-panel table")).toContainText("甲");
  await editor.fill(
    'studio_data$value <- c(3, 4)\ncat("modified file ran\\n")\nplot(studio_data$value)\n',
  );
  await editor.press("Meta+Shift+Enter");
  await expect(
    page
      .locator(".console-transcript")
      .getByText("modified file ran", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".save-status")).toHaveText("✓ Saved");
  await page.screenshot({ path: "../target/studio-browser/m3-loop.png" });
  expect(errors).toEqual([]);
});

test("UTF-8 pages, BOM/CRLF saves, disk conflicts and draft refresh", async ({
  page,
}) => {
  const fixture = "\uFEFF# " + "中".repeat(23000) + "\r\nx <- 1\r\n";
  const file = join(directory, "中文项目", "跨页 文件.R");
  await writeFile(file, fixture);
  await page.goto(url);
  await openFile(page, "跨页 文件.R");
  const editor = page.locator(".document-panel:visible .cm-content");
  await expect(editor).toContainText("x <- 1");
  await editor.press("Meta+End");
  await editor.press("End");
  await editor.press("Enter");
  await editor.press("x");
  await editor.press("Meta+s");
  await expect(page.locator(".document-panel:visible .save-status")).toHaveText(
    "✓ Saved",
  );
  const saved = await readFile(file, "utf8");
  expect(saved.startsWith("\uFEFF")).toBe(true);
  expect(saved.replaceAll("\r\n", "").includes("\n")).toBe(false);
  await editor.fill('cat("must not run after conflict\\n")');
  await writeFile(file, "# external disk edit\r\n");
  let runs = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/host")) {
      const data = request.postDataJSON();
      if (
        data?.frame?.request?.method === "invoke" &&
        data.frame.request.params.capability.id === "workspace.run_r"
      )
        runs++;
    }
  });
  await page.getByRole("button", { name: "Run File", exact: true }).click();
  await expect(
    page.locator(".document-panel:visible [role=alert]"),
  ).toContainText(/precondition failed|patch does not apply/);
  expect(runs).toBe(0);
  expect(await readFile(file, "utf8")).toBe("# external disk edit\r\n");
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".document-panel:visible .cm-content"),
  ).toContainText("must not run after conflict");
  expect(runs).toBe(0);
});

test("layout lifecycle preserves editor state, undo and R execution count", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  await newFile(page);
  const editor = page.locator(".document-panel:visible .cm-content");
  await editor.fill("# draft preserved");
  await editor.press("End");
  await editor.press("!");
  let invokes = 0;
  page.on("request", (r) => {
    if (
      r.url().endsWith("/api/host") &&
      r.postDataJSON()?.frame?.request?.method === "invoke"
    )
      invokes++;
  });
  const group = page
    .locator(".flexlayout__tabset")
    .filter({ has: page.getByRole("tab", { name: /Untitled/ }) });
  await group.getByRole("button", { name: "Collapse Group" }).click();

  await expect
    .poll(async () => Math.round((await group.boundingBox())!.height))
    .toBe(38);
  await group.getByRole("button", { name: "Restore Group" }).click();
  await expect(editor).toContainText("# draft preserved!");
  await group.getByRole("button", { name: "Maximize tab set" }).click();
  await expect(editor).toBeVisible();
  await group.getByRole("button", { name: "Restore tab set" }).click();
  const tab = group.getByRole("tab", { name: /Untitled/ });
  const target = page.getByRole("tab", { name: "Console", exact: true });
  const from = (await tab.boundingBox())!,
    to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 50, from.y + 15);
  await page.mouse.down();
  await page.mouse.move(to.x + 30, to.y + 15, { steps: 16 });
  await page.mouse.up();
  await expect(editor).toContainText("# draft preserved!");
  await editor.click();
  await editor.press("Meta+z");
  await expect(editor).toContainText("# draft preserved");
  await expect(editor).not.toContainText("!");
  await page
    .getByRole("tab", { name: /Untitled/ })
    .locator(".flexlayout__tab_button_trailing")
    .click();
  await expect(page.locator(".document-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Untitled.R/ })
    .last()
    .click();
  await expect(editor).toContainText("# draft preserved");
  await editor.click();
  await editor.press("Meta+Shift+z");
  await expect(editor).toContainText("# draft preserved!");
  expect(invokes).toBe(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(editor).toBeVisible();
  await page.screenshot({ path: "../target/studio-browser/m4-1280.png" });
});

test("draft and layout recover after Host restart on another port", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  await newFile(page);
  await page
    .locator(".document-panel:visible .cm-content")
    .fill("# 跨端口保留的草稿");
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  const previous = url;
  const windowId = new URL(page.url()).searchParams.get("window");
  expect(windowId).toBeTruthy();
  await stopHost();
  await startHost();
  expect(new URL(url).port).not.toBe(new URL(previous).port);
  const resume = new URL(url);
  resume.searchParams.set("window", windowId!);
  await page.goto(resume.toString());
  await expect(
    page.locator(".document-panel:visible .cm-content"),
  ).toContainText("跨端口保留的草稿");
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
});

test("refresh never resubmits an unconfirmed invocation", async ({ page }) => {
  await page.goto(url);
  let requests = 0,
    requestId = "";
  await page.route("**/api/host", async (route) => {
    const body = route.request().postDataJSON();
    if (
      body?.frame?.request?.method === "invoke" &&
      body.frame.request.params.arguments?.code?.includes("unconfirmed_once")
    ) {
      requests++;
      requestId = body.frame.request.params.client_request_id;
      try {
        await route.fetch();
        await route.abort("connectionreset");
      } catch {}
    } else await route.continue();
  });
  await page
    .getByRole("textbox", { name: "Console Input" })
    .fill(
      'cat("unconfirmed_once start\\n"); Sys.sleep(3); cat("unconfirmed_once end\\n")',
    );
  await page.locator(".console-prompt .primary").first().click();
  await expect(
    page
      .locator(".console-transcript")
      .getByText("unconfirmed_once start", { exact: true }),
  ).toBeVisible({ timeout: 2500 });
  expect(requestId).not.toBe("");
  await page.reload();
  await expect(
    page
      .locator(".console-transcript")
      .getByText("unconfirmed_once end", { exact: true }),
  ).toBeVisible();
  expect(requests).toBe(1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("offline drafts remain visible and synchronize when the connection returns", async ({
  page,
  context,
}) => {
  await page.goto(url);
  await resetLayout(page);
  await newFile(page);
  const editor = page.locator(".document-panel:visible .cm-content");
  await editor.fill("# initial");
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  await context.setOffline(true);
  await editor.fill("# 离线草稿必须保留");
  await expect(
    page.getByText("Draft sync pending", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".notice")).toBeVisible();
  await expect(editor).toContainText("离线草稿必须保留");
  await context.setOffline(false);
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".document-panel:visible .cm-content"),
  ).toContainText("离线草稿必须保留");
});

test("two windows do not silently overwrite each other’s drafts", async ({
  page,
  context,
}) => {
  await page.goto(url);
  await resetLayout(page);
  await newFile(page);
  await page
    .locator(".document-panel:visible .cm-content")
    .fill("# window one starting draft");
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto(url);
  await resetLayout(second);
  await newFile(second);
  expect(new URL(second.url()).searchParams.get("window")).not.toBe(new URL(page.url()).searchParams.get("window"));
  await page
    .locator(".document-panel:visible .cm-content")
    .fill("# window one");
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  await second
    .locator(".document-panel:visible .cm-content")
    .fill("# window two retained");
  await expect(second.getByText("Draft synced", { exact: true })).toBeVisible();
  await expect(
    second.locator(".document-panel:visible .cm-content"),
  ).toContainText("window two retained");
  await page.reload();
  await expect(
    page.locator(".document-panel:visible .cm-content"),
  ).toContainText("window one");
  await second.reload();
  await expect(second.locator(".document-panel:visible .cm-content")).toContainText("window two retained");
  await expect(second.getByText("Draft synced", { exact: true })).toBeVisible();
  await second.close();
});

async function api(path: string, body?: unknown) {
  const parsed = new URL(url),
    token = new URLSearchParams(parsed.hash.slice(1)).get("token");
  return fetch(parsed.origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function queryNative(id: string, args: unknown = {}) {
  const info = await (await api("/api/info")).json();
  return (
    await (
      await api("/api/host", {
        project_root: info.project_root,
        frame: {
          id: crypto.randomUUID(),
          request: {
            method: "query_snapshot",
            params: { capability: { id, version: 1 }, arguments: args },
          },
        },
      })
    ).json()
  ).result;
}

test("R configuration rejects active requests and MCP sessions, then explicitly restarts", async ({
  page,
}) => {
  await page.goto(url);
  const before = await queryNative("workspace.runtime_status");
  const config = await (await api("/api/r")).json();
  await page
    .getByRole("textbox", { name: "Console Input" })
    .fill('cat("switch fence started\\n"); Sys.sleep(3)');
  await page.locator(".console-prompt .primary").first().click();
  await expect(
    page
      .locator(".console-transcript")
      .getByText("switch fence started", { exact: true }),
  ).toBeVisible({ timeout: 2500 });
  expect(
    (
      await api("/api/r", {
        selection: config.current.selection,
        end_session: true,
      })
    ).status,
  ).toBe(409);
  await expect
    .poll(
      async () => (await queryNative("workspace.console_state")).data.current,
    )
    .toBeNull();
  const parsed = new URL(url),
    authorization =
      "Bearer " + new URLSearchParams(parsed.hash.slice(1)).get("token");
  const headers = {
    Authorization: authorization,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const initialize = await fetch(parsed.origin + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "studio-test", version: "1" },
      },
    }),
  });
  expect(initialize.ok).toBe(true);
  const session = initialize.headers.get("mcp-session-id");
  expect(session).toBeTruthy();
  await initialize.body?.cancel();
  expect(
    (
      await api("/api/r", {
        selection: config.current.selection,
        end_session: true,
      })
    ).status,
  ).toBe(409);
  await fetch(parsed.origin + "/mcp", {
    method: "DELETE",
    headers: {
      ...headers,
      "mcp-session-id": session!,
      "MCP-Protocol-Version": "2025-11-25",
    },
  });
  expect(
    (
      await api("/api/r", {
        selection: {
          ...config.current.selection,
          executable: "/missing/studio-R",
        },
        end_session: true,
      })
    ).status,
  ).toBe(400);
  expect((await queryNative("workspace.runtime_status")).data.session_id).toBe(
    before.data.session_id,
  );
  const changed = await (
    await api("/api/r", {
      selection: config.current.selection,
      end_session: true,
    })
  ).json();
  expect(changed.error).toBeNull();
  expect(
    (await queryNative("workspace.runtime_status")).data.session_id,
  ).not.toBe(before.data.session_id);
});

test("development assets refresh without ending the R session", async ({
  page,
}) => {
  const assets = join(directory, "dev-assets");
  await mkdir(assets);
  await copyFile(
    resolve("../crates/workbench/assets/app.js"),
    join(assets, "app.js"),
  );
  await copyFile(
    resolve("../crates/workbench/assets/style.css"),
    join(assets, "style.css"),
  );
  await stopHost();
  await startHost(["--dev-assets", assets]);
  await page.goto(url);
  await page
    .getByRole("textbox", { name: "Console Input" })
    .fill('dev_sentinel <- 123; cat("dev session ready\\n")');
  await page.locator(".console-prompt .primary").first().click();
  await expect(
    page
      .locator(".console-transcript")
      .getByText("dev session ready", { exact: true }),
  ).toBeVisible();
  const before = (await queryNative("workspace.runtime_status")).data;
  await writeFile(
    join(assets, "style.css"),
    (await readFile(join(assets, "style.css"), "utf8")) +
      "\n.wordmark{color:rgb(1,2,3)}",
  );
  await page.reload();
  await expect(page.locator(".wordmark")).toHaveCSS("color", "rgb(1, 2, 3)");
  const after = (await queryNative("workspace.runtime_status")).data;
  expect(after.session_id).toBe(before.session_id);
  expect(after.processes[0].pid).toBe(before.processes[0].pid);
  await expect
    .poll(
      async () =>
        (
          await queryNative("workspace.inspect_object", {
            name: "dev_sentinel",
            max_items: 1,
          })
        ).data?.preview,
    )
    .toEqual([123]);
});

test("SVG and HTML display fixtures cannot execute in the Studio document", async ({
  page,
}) => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" onload="parent.__rhoAttack=1"><script>parent.__rhoAttack=2</script><rect width="60" height="60" fill="blue"/></svg>';
  const data = Array.from(Buffer.from(svg)),
    digest = "sha256:" + createHash("sha256").update(svg).digest("hex");
  await page.route("**/api/host", async (route) => {
    const body = route.request().postDataJSON(),
      request = body?.frame?.request;
    if (
      request?.method === "query_snapshot" &&
      request.params.capability.id === "workspace.output_events"
    ) {
      const response = await route.fetch(),
        reply = await response.json();
      if (reply.result?.data) {
        const page = reply.result.data;
        page.events = page.events.map((event: any) =>
          event.media
            ? {
                ...event,
                media: {
                  ...event.media,
                  mime_type: "image/svg+xml",
                  byte_size: data.length,
                  sha256: digest,
                },
              }
            : event,
        );
      }
      await route.fulfill({ response, json: reply });
    } else if (
      request?.method === "query_snapshot" &&
      request.params.capability.id === "workspace.read_output"
    ) {
      const args = request.params.arguments;
      await route.fulfill({
        json: {
          id: body.frame.id,
          ok: true,
          result: {
            target: { kind: "workspace", identity: "fixture" },
            source: "security-fixture",
            observed_at_ms: 1,
            status: "ready",
            completeness: "complete",
            notices: [],
            data: {
              reference: args.reference,
              offset: 0,
              bytes: data,
              has_more: false,
            },
          },
        },
      });
    } else await route.continue();
  });
  await page.goto(url);
  await page.getByRole("button", { name: "Plot Actions", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Go to Latest", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Console Input" })
    .fill('plot(1:3); cat("<iframe onload=parent.__rhoAttack=3>\\n")');
  await page.locator(".console-prompt .primary").first().click();
  await expect(page.locator(".plot-original img").last()).toBeVisible();
  await page.locator(".console-plot-link").last().click();
  await expect(page.locator(".plot-original img")).toBeVisible();
  expect(await page.evaluate(() => "__rhoAttack" in window)).toBe(false);
  expect(await page.locator("iframe").count()).toBe(0);
  await expect(
    page
      .locator(".console-transcript")
      .getByText("<iframe onload=parent.__rhoAttack=3>", { exact: true }),
  ).toBeVisible();
});

test("narrow and short containers keep essential controls and 38px groups", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  await newFile(page);
  await page
    .locator(".document-panel:visible .cm-content")
    .fill("# size fixture");
  await page
    .getByRole("textbox", { name: "Console Input" })
    .fill("size_data <- data.frame(x=1:30, y=1:30); plot(1:3)");
  await page.locator(".console-prompt .primary").first().click();
  await expect(page.locator(".plot-original img").last()).toBeVisible();
  await page.locator(".console-plot-link").last().click();
  const bounds = await page.getByRole("separator").evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
  const vertical = bounds
    .filter((r) => r.width <= 10 && r.height > 600)
    .sort((a, b) => b.x - a.x)[0]!;
  await page.mouse.move(vertical.x + 4, vertical.y + 100);
  await page.mouse.down();
  await page.mouse.move(1148, vertical.y + 100, { steps: 10 });
  await page.mouse.up();
  const horizontal = (
    await page.getByRole("separator").evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    )
  )
    .filter((r) => r.width > 240 && r.height <= 10)
    .sort((a, b) => b.width - a.width)[0]!;
  await page.mouse.move(horizontal.x + 200, horizontal.y + 4);
  await page.mouse.down();
  await page.mouse.move(horizontal.x + 200, 756, { steps: 10 });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Run File", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".console-status")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Plot Actions" }),
  ).toBeVisible();
  await page.screenshot({ path: "../target/studio-browser/m4-h04.png" });
  const plotGroup = page
    .locator(".flexlayout__tabset")
    .filter({ has: page.getByRole("tab", { name: "Plots", exact: true }) });
  await plotGroup.getByRole("button", { name: "Collapse Group" }).click();
  await expect
    .poll(async () => Math.round((await plotGroup.boundingBox())!.height))
    .toBe(38);
  await plotGroup.getByRole("button", { name: "Maximize tab set" }).click();
  await expect(page.locator(".plot-original img")).toBeVisible();
  await expect
    .poll(async () => (await plotGroup.boundingBox())!.height)
    .toBeGreaterThan(700);
  await plotGroup.getByRole("button", { name: "Restore tab set" }).click();
  await expect
    .poll(async () => Math.round((await plotGroup.boundingBox())!.height))
    .toBe(38);
  await plotGroup.getByRole("button", { name: "Restore Group" }).click();
  await resetLayout(page);
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Untitled.R/ })
    .last()
    .click();
  await page.setViewportSize({ width: 560, height: 300 });
  await expect(page.locator(".console-status")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Fit", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Plot Actions" }),
  ).toBeVisible();
  await page.screenshot({ path: "../target/studio-browser/m4-combined.png" });
});

test("editor preferences persist without executing code or losing document text", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  await newFile(page);
  const editor = page.locator(".document-panel:visible .cm-content");
  await editor.fill("# 偏好不改变文档");
  let invokes = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/host") &&
      request.postDataJSON()?.frame?.request?.method === "invoke"
    )
      invokes++;
  });
  await page.getByRole("button", { name: "Environment", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Code Font Size" })
    .selectOption("16");
  await page.getByRole("combobox", { name: "Indent Width" }).selectOption("2");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".document-panel:visible .cm-editor")).toHaveCSS(
    "font-size",
    "16px",
  );
  await expect(editor).toContainText("偏好不改变文档");
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".document-panel:visible .cm-editor")).toHaveCSS(
    "font-size",
    "16px",
  );
  expect(invokes).toBe(0);
  await page.getByRole("button", { name: "Environment", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Code Font Size" })
    .selectOption("14");
  await page.getByRole("combobox", { name: "Indent Width" }).selectOption("4");
  await page.getByRole("button", { name: "Close", exact: true }).click();
});

test("long streaming output does not remount the editor or move its focus", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  await newFile(page);
  const editor = page.locator(".document-panel:visible .cm-content");
  await editor.fill("# ");
  const handle = await editor.elementHandle();
  await page
    .getByRole("textbox", { name: "Console Input" })
    .fill(
      'for (i in 1:8) { cat(paste(rep("long output", 1200), collapse=" "), "\\n"); Sys.sleep(0.2) }',
    );
  await page.locator(".console-prompt .primary").first().click();
  await editor.click();
  await editor.press("End");
  await page.keyboard.insertText("中文输入保持稳定");
  await expect(page.locator(".console-transcript").last()).toContainText(
    "long output",
  );
  await expect
    .poll(
      async () => (await queryNative("workspace.console_state")).data.current,
    )
    .toBeNull();
  expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(editor).toBeFocused();
  await expect(editor).toContainText("中文输入保持稳定");
});

async function invokeNative(code: string, accepted = false) {
  const info = await (await api("/api/info")).json();
  const response = await api("/api/host", {
    project_root: info.project_root,
    frame: {
      id: crypto.randomUUID(),
      request: {
        method: "invoke",
        params: {
          client_request_id: crypto.randomUUID(),
          capability: { id: "workspace.run_r", version: 1 },
          arguments: { code, output_mode: "console" },
          preconditions: [],
          return_after_acceptance: accepted,
        },
      },
    },
  });
  const reply = await response.json();
  expect(reply.ok, reply.error).toBe(true);
  return reply.result;
}
async function runConsole(page: import("@playwright/test").Page, code: string) {
  const panel = page.locator(".console-panel:visible").first();
  await panel.locator(".console-input .cm-content").fill(code);
  await panel.locator(".console-prompt .primary").click();
  await expect(panel.locator(".console-input .cm-content")).toHaveText("");
}

async function moveVisibleView(page: import("@playwright/test").Page, tabName: string, target: string, placement: string) {
  const group = page.locator(".flexlayout__tabset").filter({ has: page.getByRole("tab", { name: tabName, exact: true }) });
  await group.getByRole("button", { name: /^Group Actions:/ }).click();
  await page.getByRole("menuitem", { name: "Move To…", exact: true }).click();
  await page.getByRole("combobox", { name: "Target Region" }).selectOption(target);
  await page.getByRole("combobox", { name: "Placement" }).selectOption(placement);
  await page.getByRole("button", { name: "Move View", exact: true }).click();
}

async function countViewRequests(page: import("@playwright/test").Page) {
  const counts: Record<string, number> = {}, started = Date.now();
  const count = (request: import("@playwright/test").Request) => {
    if (!request.url().endsWith("/api/host")) return;
    const call = request.postDataJSON()?.frame?.request;
    const key = call?.method === "query_snapshot" ? call.params.capability.id : call?.method;
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  };
  page.on("request", count);
  // A fixed observation window and one identical invalidation make request cost comparable.
  await Promise.all([invokeNative("invisible(NULL)"), page.waitForTimeout(4000)]);
  page.off("request", count);
  return { durationMs: Date.now() - started, counts };
}

async function settleSelectedPlot(page: import("@playwright/test").Page, reference: { operation_id: string; sequence: number }) {
  const image = page.locator('[data-plot-view="plots"] .plot-original img');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("data-operation-id", reference.operation_id);
  await expect(image).toHaveAttribute("data-output-sequence", String(reference.sequence));
  await expect.poll(() => image.evaluate((node) => {
    const original = node as HTMLImageElement;
    return original.complete && original.naturalWidth > 0 && original.naturalHeight > 0;
  })).toBe(true);
  // Let image dimensions and ResizeObserver updates reach the painted canvas.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test("multiple Console drafts, continuation, history and IME events retain their scope", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  const first = page.getByRole("textbox", {
    name: "Console Input",
    exact: true,
  });
  await first.fill("1 + 1");
  await expect(page.locator(".console-prompt .primary").first()).toBeEnabled();
  await first.press("Enter");
  await expect(page.locator(".console-transcript:visible")).toContainText(
    "[1] 2",
  );
  await first.fill("mean(");
  await first.press("Enter");
  await expect(first).toContainText("mean(");
  await expect.poll(() => first.innerText()).toContain("\n");
  await first.fill("# draft before history");
  await first.press("Home");
  await first.press("ArrowUp");
  await expect(first).toHaveText("1 + 1");
  await first.press("Escape");
  await expect(first).toHaveText("# draft before history");
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Console View" }).click();
  const second = page.locator(
    ".console-panel:visible .console-input .cm-content",
  );
  await expect(second).toHaveText("");
  await second.fill("# second draft");
  await second.dispatchEvent("compositionstart", { data: "中" });
  await second.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  await second.dispatchEvent("compositionend", { data: "中" });
  await expect(second).toHaveText("# second draft");
  await page.getByRole("tab", { name: "Console", exact: true }).click();
  await expect(first).toHaveText("# draft before history");
  await page.getByRole("tab", { name: "Console 2", exact: true }).click();
  await page
    .getByRole("tab", { name: "Console 2", exact: true })
    .locator(".flexlayout__tab_button_trailing")
    .click();
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Console 2", exact: true })
    .click();
  await expect(
    page.locator(".console-panel:visible .console-input .cm-content"),
  ).toHaveText("# second draft");
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".console-panel:visible .console-input .cm-content"),
  ).toHaveText("# second draft");
});

test("queued runs survive refresh and an error pauses the remaining code", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  await runConsole(
    page,
    'queue_counter <- 1L; Sys.sleep(2); cat("queue head done\\n")',
  );
  await runConsole(
    page,
    'queue_counter <- queue_counter + 1L; stop("queue barrier")',
  );
  await runConsole(
    page,
    'queue_counter <- queue_counter + 10L; cat("queue resumed\\n")',
  );
  await expect(page.locator(".queue-notice").first()).toBeVisible();
  const state = (await queryNative("workspace.console_state")).data;
  expect(state.pending).toHaveLength(1);
  expect(
    (
      await queryNative("workspace.inspect_object", {
        name: "queue_counter",
        max_items: 1,
      })
    ).data.preview,
  ).toEqual([2]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resume Queue", exact: true }),
  ).toBeVisible();
  expect(
    (await queryNative("workspace.console_state")).data.pending,
  ).toHaveLength(1);
  await page.getByRole("button", { name: "Resume Queue", exact: true }).click();
  await expect(
    page
      .locator(".console-transcript")
      .getByText("queue resumed", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await queryNative("workspace.inspect_object", {
        name: "queue_counter",
        max_items: 1,
      })
    ).data.preview,
  ).toEqual([12]);
});

test("stdin has a separate answer field and accepts an answer after a browser refresh", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  await runConsole(
    page,
    'input_answer <- readline("R answer: "); cat("received:", input_answer, "\\n")',
  );
  const draft = page.getByRole("textbox", {
    name: "Console Input",
    exact: true,
  });
  await draft.fill("# next command remains");
  await expect(page.locator(".stdin-request")).toContainText("R answer:");
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  await page.reload();
  await expect(draft).toHaveText("# next command remains");
  await page.getByRole("button", { name: "Answer Here" }).click();
  await page
    .getByRole("textbox", { name: "R Input Response" })
    .fill("verified");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(page.locator(".console-transcript")).toContainText(
    "received: verified",
  );
  await expect(draft).toHaveText("# next command remains");
  await runConsole(
    page,
    'menu_answer <- menu(c("First", "Second"), graphics=FALSE); cat("choice:",menu_answer,"\\n")',
  );
  await expect(page.locator(".stdin-request")).toBeVisible();
  if (await page.getByRole("button", { name: "Answer Here" }).isVisible())
    await page.getByRole("button", { name: "Answer Here" }).click();
  await page.getByRole("textbox", { name: "R Input Response" }).fill("2");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(page.locator(".console-transcript")).toContainText("choice: 2");
});

test("parent placement is reversible and every view can close without running R", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  let invokes = 0;
  page.on("request", (r) => {
    if (
      r.url().endsWith("/api/host") &&
      r.postDataJSON()?.frame.request.method === "invoke"
    )
      invokes++;
  });
  await page
    .getByRole("button", { name: "Group Actions: Plots", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move To…", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Target Region" })
    .selectOption("editing-region");
  await page.getByRole("combobox", { name: "Placement" }).selectOption("Left");
  await expect(page.locator(".dock-destination")).toBeVisible();
  const preview = (await page.locator(".dock-destination").boundingBox())!;
  await page.getByRole("button", { name: "Move View", exact: true }).click();
  const plots = page
    .locator(".flexlayout__tabset")
    .filter({ has: page.getByRole("tab", { name: "Plots", exact: true }) });
  const placed = (await plots.boundingBox())!;
  expect(Math.abs(placed.x - preview.x)).toBeLessThan(3);
  expect(Math.abs(placed.width - preview.width)).toBeLessThan(3);
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Undo Layout Change", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Group Actions: Plots", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move To…", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".dock-destination")).toHaveCount(0);
  while (await page.getByRole("tab").count())
    await page
      .getByRole("tab")
      .first()
      .locator(".flexlayout__tab_button_trailing")
      .click();
  await expect(page.getByText("Make room for your work")).toBeVisible();
  await page.getByRole("button", { name: "Show Panels", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Show Console", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Console", exact: true }),
  ).toBeVisible();
  expect(invokes).toBe(0);
});

test("plot comparison pins identity and Export Original preserves its checksum", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  const record = await invokeNative('plot(1:5, main="Export original")');
  await expect(page.locator(".plot-original img")).toBeVisible();
  await page.getByRole("button", { name: "Plot Actions" }).click();
  await page
    .getByRole("menuitem", { name: "Go to Latest", exact: true })
    .click();
  await page
    .locator('.plot-panel[data-plot-view="plots"]')
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    record.operation.operation_id,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Plot Actions" }).click();
  await page.getByRole("menuitem", { name: "Open Plot in New View" }).click();
  await expect(page.locator(".plot-panel:visible")).toHaveCount(2);
  const pinned = page.locator(".plot-panel").filter({ hasText: "Pinned plot" }),
    original = await pinned.locator(".plot-original img").getAttribute("src");
  await invokeNative('plot(5:1, main="Later output")');
  await expect(pinned.locator(".plot-original img")).toHaveAttribute(
    "src",
    original!,
  );
  await pinned.getByRole("button", { name: "Plot Actions" }).click();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Export Original", exact: true })
    .click();
  const download = await downloadEvent;
  const bytes = await readFile((await download.path())!);
  const media = (
    await queryNative("workspace.list_outputs", {
      operation_id: record.operation.operation_id,
      limit: 100,
    })
  ).data.media[0].reference;
  expect("sha256:" + createHash("sha256").update(bytes).digest("hex")).toBe(
    media.sha256,
  );
  expect(download.suggestedFilename()).toContain(record.operation.operation_id);
});

test("Chrome native IME composition never submits code on the commit key", async ({
  page,
  context,
}) => {
  await page.goto(url);
  await resetLayout(page);
  const input = page.getByRole("textbox", {
    name: "Console Input",
    exact: true,
  });
  await input.fill("# ");
  await input.press("End");
  let runs = 0;
  page.on("request", (r) => {
    if (
      r.url().endsWith("/api/host") &&
      r.postDataJSON()?.frame?.request?.method === "invoke" &&
      r.postDataJSON().frame.request.params.capability.id === "workspace.run_r"
    )
      runs++;
  });
  const session = await context.newCDPSession(page);
  await session.send("Input.imeSetComposition", {
    text: "中文",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 36,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 36,
  });
  expect(runs).toBe(0);
  await session.send("Input.insertText", { text: "中文" });
  await expect(input).toContainText("中文");
  // The native composition can emit a second commit key after compositionend.
  // Wait through its rendering turn before asserting absence of submission.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(runs).toBe(0);
  await input.press("Enter");
  await expect.poll(() => runs).toBe(1);
  await expect(input).toHaveText("");
  await session.detach();
});

test("fixed gapminder analysis, in-place previews and input/frame latency under load", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const project = join(directory, "中文项目");
  for (const part of [
    "data/raw",
    "data/processed",
    "R",
    "scripts",
    "output/figures",
  ])
    await mkdir(join(project, part), { recursive: true });
  await copyFile(
    resolve("e2e/fixtures/gapminder/gapminder.csv"),
    join(project, "data/raw/gapminder.csv"),
  );
  const script = await readFile(
    resolve("e2e/fixtures/gapminder/analysis.R"),
    "utf8",
  );
  await page.goto(url);
  await resetLayout(page);
  await newFile(page);
  const editor = page.locator(".document-panel:visible .cm-content");
  await editor.fill(script);
  await page.getByRole("button", { name: "Run File", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("File Path")
    .fill("scripts/国家发展分析.R");
  const analysisResponse = page.waitForResponse((response) => {
    if (!response.url().endsWith("/api/host")) return false;
    const call = response.request().postDataJSON()?.frame?.request;
    return call?.method === "invoke" && call.params.capability.id === "workspace.run_r" &&
      call.params.arguments?.code?.includes("Analysis complete:");
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save and Run", exact: true })
    .click();
  const analysisReply = await (await analysisResponse).json();
  expect(analysisReply.ok, analysisReply.error).toBe(true);
  const analysisOperationId = analysisReply.result.operation.operation_id as string;
  await page.locator(".console-transcript:visible .cm-scroller").evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(page.locator(".console-transcript:visible")).toContainText(
    "Analysis complete: 1704 rows",
  );
  for (const name of ["raw", "clean", "summary_by_year"])
    await page
      .locator(".objects-panel")
      .getByRole("button", { name: new RegExp(`› ${name}$`) })
      .click();
  await expect(page.locator(".objects-panel table")).toHaveCount(3);
  await expect(page.locator(".object-viewer")).toHaveCount(0);
  expect(
    (
      await queryNative("workspace.inspect_object", {
        name: "model",
        max_items: 20,
      })
    ).data.preview,
  ).toBeNull();
  let analysisMedia: { reference: { operation_id: string; sequence: number } }[] = [];
  await expect.poll(async () => {
    const observation = await queryNative("workspace.list_outputs", { operation_id: analysisOperationId, after_sequence: 0, limit: 100 });
    analysisMedia = observation.status === "ready" ? observation.data.media : [];
    return analysisMedia.length;
  }).toBe(3);
  const selectedAnalysisPlot = analysisMedia.at(-1)!.reference;
  await page.locator('[data-plot-view="plots"]').getByRole("button", { name: "Plot Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Go to Latest", exact: true }).click();
  await page.locator(".console-transcript:visible .cm-scroller").evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await settleSelectedPlot(page, selectedAnalysisPlot);
  await page.screenshot({
    path: "../target/studio-browser/calm-gapminder-1440.png",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".console-transcript:visible .cm-scroller").evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await settleSelectedPlot(page, selectedAnalysisPlot);
  await page.screenshot({
    path: "../target/studio-browser/calm-gapminder-1280.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const largeScript = Array.from(
    { length: 4000 },
    (_, i) => `# Analysis note ${i}: stable document, output and plot history`,
  ).join("\n");
  await writeFile(join(project, "scripts/large-analysis.R"), largeScript);
  await openFile(page, "scripts/large-analysis.R");
  await expect(
    page.getByRole("tab", { name: "large-analysis.R", exact: true }),
  ).toBeVisible();
  await editor.press("Meta+End");
  const plotHistory = Number((await page.locator('[data-plot-view="plots"] .plot-toolbar > span').innerText()).split("/")[1]);
  expect(plotHistory).toBeGreaterThanOrEqual(analysisMedia.length);
  await runConsole(
    page,
    'for (i in 1:200) {cat("load-observation",i,"\\n"); Sys.sleep(0.025)}',
  );
  await editor.click();
  await editor.press("Meta+End");
  await page.evaluate(() => {
    const state = {
      input: [] as number[],
      frames: [] as number[],
      active: true,
      last: performance.now(),
    };
    (window as any).__rhoPerformance = state;
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          state.active &&
          (event.target as Element)?.closest(".document-panel") &&
          event.key.length === 1
        ) {
          const start = performance.now();
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              state.input.push(performance.now() - start),
            ),
          );
        }
      },
      true,
    );
    requestAnimationFrame(function frame(time) {
      if (!state.active) return;
      state.frames.push(time - state.last);
      state.last = time;
      requestAnimationFrame(frame);
    });
  });
  await page.keyboard.type(" latency_sample".repeat(8), { delay: 10 });
  await expect(editor).toBeFocused();
  const canvas = page.getByLabel("Plot Canvas", { exact: true });
  await canvas.hover();
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, i < 6 ? -45 : 45);
  const splitter = (
    await page.getByRole("separator").evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    )
  ).find((r) => r.w > 400 && r.h < 10)!;
  await page.mouse.move(splitter.x + 120, splitter.y + 3);
  await page.mouse.down();
  await page.mouse.move(splitter.x + 120, splitter.y + 40, { steps: 24 });
  await page.mouse.up();
  const measured = await page.evaluate(() => {
    const state = (window as any).__rhoPerformance;
    state.active = false;
    return {
      input: state.input,
      frames: state.frames,
      userAgent: navigator.userAgent,
      dpr: devicePixelRatio,
    };
  });
  const percentile = (values: number[], p: number) =>
    [...values].sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.floor(values.length * p))
    ];
  await expect.poll(async () => (await queryNative("workspace.console_state")).data.current).toBeNull();
  const singleViewRequests = await countViewRequests(page);
  const originalImage = page.locator('[data-plot-view="plots"] .plot-original img'),
    original = await originalImage.getAttribute("src"),
    originalOperation = await originalImage.getAttribute("data-operation-id"),
    originalSequence = Number(await originalImage.getAttribute("data-output-sequence"));
  const mediaReadsAfterAddingViews: { operation: string; sequence: number; offset: number }[] = [];
  const mediaReads = (request: import("@playwright/test").Request) => {
    if (!request.url().endsWith("/api/host")) return;
    const call = request.postDataJSON()?.frame?.request;
    if (call?.method === "query_snapshot" && call.params.capability.id === "workspace.read_output") {
      const args = call.params.arguments;
      mediaReadsAfterAddingViews.push({ operation: args.reference.operation_id, sequence: args.reference.sequence, offset: args.offset });
    }
  };
  page.on("request", mediaReads);
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Console View", exact: true }).click();
  const additionalConsoleId = await page.locator(".console-panel:visible").getAttribute("data-console-view");
  const additionalConsoleName = await page.locator(`[role="tab"] [data-rho-view="${additionalConsoleId}"]`).innerText();
  await moveVisibleView(page, additionalConsoleName, "workspace", "Below");
  await expect(page.locator(".console-panel:visible")).toHaveCount(2);
  await page.locator('[data-plot-view="plots"]').getByRole("button", { name: "Plot Actions" }).click();
  await page.getByRole("menuitem", { name: "Open Plot in New View", exact: true }).click();
  await expect(page.locator(".plot-panel:visible")).toHaveCount(2);
  await expect(page.locator(".plot-panel:visible .plot-original img")).toHaveCount(2);
  expect(await page.locator(".plot-panel:visible .plot-original img").evaluateAll((images) => images.map((image) => image.getAttribute("src")))).toEqual([original, original]);
  const additionalViewRequests = await countViewRequests(page);
  page.off("request", mediaReads);
  for (const capability of ["workspace.snapshot", "workspace.inspect_object", "workspace.packages"])
    expect(additionalViewRequests.counts[capability] ?? 0, capability).toBeLessThanOrEqual(singleViewRequests.counts[capability] ?? 0);
  for (const capability of ["workspace.runtime_status", "workspace.console_state"])
    expect(additionalViewRequests.counts[capability] ?? 0, capability).toBeLessThanOrEqual((singleViewRequests.counts[capability] ?? 0) + 2);
  expect(mediaReadsAfterAddingViews.filter((read) => read.operation === originalOperation && read.sequence === originalSequence)).toHaveLength(0);
  expect(new Set(mediaReadsAfterAddingViews.map((read) => `${read.operation}:${read.sequence}:${read.offset}`)).size).toBe(mediaReadsAfterAddingViews.length);
  const comparisonGroup = page.locator(".flexlayout__tabset").filter({ has: page.getByRole("tab", { name: /^Comparison / }) });
  await comparisonGroup.getByRole("button", { name: "Maximize tab set" }).click();
  await page.screenshot({ path: "../target/studio-browser/modular-plots-maximized.png" });
  await comparisonGroup.getByRole("button", { name: "Restore tab set" }).click();
  const os = await import("node:os");
  const metrics = {
    recordedAt: new Date().toISOString(),
    viewport: { width: 1440, height: 900 },
    scriptLines: 4000,
    streamLines: 200,
    streamDelayMs: 25,
    plotHistory,
    analysisOperationId,
    analysisPlots: analysisMedia.length,
    selectedAnalysisPlot,
    inputSamples: measured.input.length,
    inputP95Ms: percentile(measured.input, 0.95),
    frameSamples: measured.frames.length,
    frameP95Ms: percentile(measured.frames, 0.95),
    measurement:
      "keydown capture to second animation frame; frame intervals while typing, wheel zooming and dragging a splitter",
    browser: measured.userAgent,
    dpr: measured.dpr,
    cpu: os.cpus()[0]?.model,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    requestCost: { singleViewRequests, additionalViewRequests, mediaReadsAfterAddingViews, consoleViews: 2, plotViews: 2 },
  };
  await writeFile(
    testInfo.outputPath("performance.json"),
    JSON.stringify(metrics, null, 2),
  );
  await testInfo.attach("performance", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  expect(metrics.inputSamples).toBeGreaterThan(60);
  expect(metrics.inputP95Ms).toBeLessThan(50);
  expect(metrics.frameP95Ms).toBeLessThan(33);
  await expect
    .poll(
      async () => (await queryNative("workspace.console_state")).data.current,
    )
    .toBeNull();
});

test("Packages follows the Paper design with grouped copies, sources and busy cached search", async ({
  page,
}) => {
  await page.goto(url);
  await resetLayout(page);
  const setup = await invokeNative(`
    .rho_packages_original <- .libPaths()
    .rho_packages_dir <- tempfile('rho-packages-')
    dir.create(.rho_packages_dir)
    .rho_packages_libs <- file.path(.rho_packages_dir, c('库一', '库二'))
    for (i in seq_along(.rho_packages_libs)) {
      dir.create(.rho_packages_libs[[i]])
      pkg <- file.path(.rho_packages_libs[[i]], 'rhoStudioFixture')
      dir.create(pkg)
      source_fields <- if (i == 1L) c('RemoteType: github', 'RemoteHost: api.github.com', 'RemoteUsername: fixture', 'RemoteRepo: science', 'RemoteRef: main', 'RemoteSha: 1234567890abcdef') else 'Repository: CRAN'
      writeLines(c('Package: rhoStudioFixture', paste0('Version: ', i, '.0'), 'Title: 中文 <img src=x onerror=alert(1)>', source_fields), file.path(pkg, 'DESCRIPTION'))
    }
    .libPaths(c(.rho_packages_libs, .rho_packages_original))
    rm(pkg, i, source_fields)
  `);
  expect(setup.status).toBe("succeeded");
  try {
    await page.getByRole("button", { name: "Panels", exact: true }).click();
    await page.getByRole("menuitem", { name: "Packages", exact: true }).click();
    const panel = page.locator(".packages-panel:visible");
    await expect(panel.getByRole("status")).toContainText("Observed");
    await expect(panel.locator(".package-index-status")).toHaveCount(0);
    await panel.getByLabel("Search Packages").fill("rhoStudioFixture");
    await expect(panel.locator(".package-row")).toHaveCount(1);
    await expect(panel.locator(".package-row")).toContainText("1.0");
    await expect(panel.locator(".package-inline-copies")).toHaveText(
      "2 copies",
    );
    await expect(panel.locator(".package-row-purpose")).toHaveText(
      "中文 <img src=x onerror=alert(1)>",
    );
    await expect(panel.locator(".package-row")).not.toContainText("/Library/");
    await panel.locator(".package-row").click();
    const inspector = panel.locator(".package-inspector");
    await expect(
      inspector.getByText("Not loaded", { exact: true }),
    ).toBeVisible();
    await expect(inspector.locator(".package-copy")).toHaveCount(2);
    await inspector
      .getByRole("button", { name: "GitHub · Details", exact: true })
      .click();
    await expect(
      inspector.getByRole("heading", { name: "GitHub", exact: true }),
    ).toBeVisible();
    await expect(
      inspector.getByText("1234567890ab", { exact: true }),
    ).toBeVisible();
    await expect(
      inspector.getByRole("link", { name: "fixture/science" }),
    ).toHaveAttribute("href", "https://github.com/fixture/science");
    await inspector.locator(".package-metadata summary").click();
    await expect(inspector.locator(".package-metadata")).toContainText(
      "1234567890abcdef",
    );
    const otherCopy = await inspector
      .getByLabel("Source Copy")
      .locator("option")
      .filter({ hasText: "Library 2 · 2.0" })
      .getAttribute("value");
    await inspector.getByLabel("Source Copy").selectOption(otherCopy!);
    await expect(
      inspector.getByRole("heading", { name: "CRAN", exact: true }),
    ).toBeVisible();
    await inspector
      .getByRole("button", { name: "‹ Overview", exact: true })
      .click();
    await expect(panel.locator("img, script")).toHaveCount(0);
    await expect(
      panel.getByRole("button", {
        name: /^(Install|Update|Remove|Load Package)( |$)/,
      }),
    ).toHaveCount(0);
    const busyRun = invokeNative("Sys.sleep(2)");
    await expect(panel.locator(".package-busy")).toContainText("R busy");
    let packageQueries = 0;
    const countQueries = (request: import("@playwright/test").Request) => {
      if (
        request.url().endsWith("/api/host") &&
        request.postData()?.includes('"workspace.packages"')
      )
        packageQueries++;
    };
    page.on("request", countQueries);
    await panel.getByLabel("Search Packages").fill("Purpose not in metadata");
    await expect(
      panel.getByRole("heading", { name: /No matches/ }),
    ).toBeVisible();
    await panel.getByLabel("Search Packages").fill("rhoStudioFixture");
    await expect(panel.locator(".package-row")).toHaveCount(1);
    expect(packageQueries).toBe(0);
    page.off("request", countQueries);
    await expect(
      panel.getByRole("button", { name: "Refresh Packages" }),
    ).toBeDisabled();
    await busyRun;
    await invokeNative(
      ".libPaths(c(rev(.rho_packages_libs), .rho_packages_original))",
    );
    await expect(
      panel.getByRole("button", { name: "Refresh Packages" }),
    ).toBeEnabled();
    await panel.getByRole("button", { name: "Refresh Packages" }).click();
    await expect(panel.locator(".package-row")).toContainText("2.0");
    await expect(panel.locator(".package-index-status")).toHaveCount(0);
    await panel.getByLabel("Search Packages").fill("stats");
    await panel.getByRole("button", { name: /^Loaded \d/ }).click();
    await expect(panel.locator(".package-row").first()).toHaveAttribute(
      "aria-label",
      /Attached/,
    );
    await panel.getByRole("button", { name: /^Attached \d/ }).click();
    await panel.locator(".package-footer .package-runtime-button").click();
    await expect(
      page.getByRole("dialog", { name: "R & libraries" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Library search order", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      panel.locator(".package-footer .package-runtime-button"),
    ).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 800 });
    const rowBounds = await panel.locator(".package-row").first().boundingBox();
    const scrollBounds = await panel.locator(".package-scroll").boundingBox();
    expect(rowBounds!.y + rowBounds!.height).toBeLessThanOrEqual(
      scrollBounds!.y + scrollBounds!.height,
    );
    await page.screenshot({
      path: "../target/studio-browser/packages-paper-compact.png",
    });
    await panel.getByLabel("Search Packages").fill("");
    await panel.getByRole("button", { name: /^All \d/ }).click();
    const group = page
      .locator(".flexlayout__tabset")
      .filter({ has: page.locator('[data-rho-view="packages"]') });
    await group.getByRole("button", { name: "Maximize tab set" }).click();
    await expect(panel).toHaveClass(/packages-wide/);
    await panel.getByLabel("Search Packages").fill("rhoStudioFixture");
    await panel.locator(".package-row").click();
    await expect(panel.locator(".package-inspector-wide")).toBeVisible();
    await expect(panel.locator(".package-columns")).toContainText("Source");
    await expect(panel.locator(".package-row-source")).toContainText("CRAN +1");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({
      path: "../target/studio-browser/packages-paper-wide.png",
    });
    await group.getByRole("button", { name: "Restore tab set" }).click();
    await page
      .locator('[data-rho-view="packages"]')
      .locator("..")
      .locator("..")
      .locator(".flexlayout__tab_button_trailing")
      .click();
    await page.getByRole("button", { name: "Panels", exact: true }).click();
    await page.getByRole("menuitem", { name: "Packages", exact: true }).click();
    await expect(panel.getByLabel("Search Packages")).toHaveValue(
      "rhoStudioFixture",
    );
  } finally {
    await invokeNative(
      ".libPaths(.rho_packages_original); unlink(.rho_packages_dir, recursive = TRUE); rm(.rho_packages_original, .rho_packages_dir, .rho_packages_libs)",
    );
  }
});

test("checkpoint startup and reconnect consume an external burst beyond recent history and event pages", async ({ page, context }, testInfo) => {
  test.setTimeout(180000);
  const recordReads = new Set<string>(), eventPages: number[] = [], checkpoints: number[] = [];
  let browserInvokes = 0, inserted: any = null, injected = false;
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/host")) return;
    const call = request.postDataJSON()?.frame?.request;
    if (call?.method === "get_operation") recordReads.add(call.params.operation_id);
    if (call?.method === "invoke") browserInvokes++;
  });
  page.on("response", async (response) => {
    if (!response.url().endsWith("/api/host") || response.request().postDataJSON()?.frame?.request?.method !== "subscribe") return;
    try { const reply = await response.json(); if (Array.isArray(reply.result)) eventPages.push(reply.result.length); } catch { /* The deliberate disconnect can cancel a response body. */ }
  });
  await page.route("**/api/host", async (route) => {
    const call = route.request().postDataJSON()?.frame?.request, capability = call?.params?.capability?.id;
    if (capability === "operation.events_checkpoint") {
      const response = await route.fetch(), reply = await response.json();
      checkpoints.push(reply.result.data.sequence);
      await route.fulfill({ response, json: reply });
    } else if (!injected && capability === "operation.list_recent" && call.params.arguments?.before_cursor == null && !call.params.arguments?.operation_id && !call.params.arguments?.client_request_id) {
      injected = true;
      const response = await route.fetch(), reply = await response.json();
      expect(checkpoints).toHaveLength(1);
      inserted = await invokeNative('cat("rho_checkpoint_inserted\\n")');
      expect(reply.result.data.operations.some((summary: any) => summary.operation_id === inserted.operation.operation_id)).toBe(false);
      await route.fulfill({ response, json: reply });
    } else await route.continue();
  });
  await page.goto(url);
  await expect.poll(() => inserted && recordReads.has(inserted.operation.operation_id)).toBe(true);
  await resetLayout(page);
  // A prior scenario may have retained a scrolled-back Console. Deliberately
  // follow the live end before asserting text in CodeMirror's visible viewport.
  await page.locator(".console-transcript:visible .cm-scroller").evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(page.locator(".console-transcript:visible")).toContainText("rho_checkpoint_inserted");
  await invokeNative("rho_burst_count <- 0L");
  const ids: string[] = [];
  await context.setOffline(true);
  try {
    for (let index = 0; index < 105; index++) {
      const record = await invokeNative(`rho_burst_count <- rho_burst_count + 1L; cat("rho_event_burst_${String(index).padStart(3, "0")}\\n")`);
      expect(record.status).toBe("succeeded"); ids.push(record.operation.operation_id);
    }
  } finally { await context.setOffline(false); }
  await expect.poll(() => ids.every((id) => recordReads.has(id)), { timeout: 60000 }).toBe(true);
  await expect.poll(() => eventPages.includes(100), { timeout: 60000 }).toBe(true);
  await page.locator(".console-panel:visible").getByRole("button", { name: "Run Details", exact: true }).click();
  const details = page.getByRole("dialog");
  await expect.poll(async () => {
    const text = (await details.locator("summary").allTextContents()).join("\n");
    return ids.every((id) => text.includes(id));
  }, { timeout: 60000 }).toBe(true);
  await details.getByRole("button", { name: "Close", exact: true }).click();
  expect((await queryNative("workspace.inspect_object", { name: "rho_burst_count", max_items: 1 })).data.preview).toEqual([105]);
  expect(browserInvokes).toBe(0);
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  recordReads.clear();
  await page.reload();
  await expect.poll(() => checkpoints.length).toBe(2);
  await page.locator(".console-panel:visible").getByRole("button", { name: "Run Details", exact: true }).click();
  await expect.poll(async () => details.locator("summary").count()).toBeGreaterThanOrEqual(30);
  expect((await details.locator("summary").allTextContents()).some((text) => text.includes(ids[0]))).toBe(false);
  let historicalPages = 0;
  const historicalSummaryIds = new Set<string>();
  while (!(await details.locator("summary").allTextContents()).some((text) => text.includes(ids[0])) && historicalPages < 5) {
    const response = page.waitForResponse((response) => {
      if (!response.url().endsWith("/api/host")) return false;
      const call = response.request().postDataJSON()?.frame?.request;
      return call?.method === "query_snapshot" && call.params.capability.id === "operation.list_recent" && call.params.arguments?.before_cursor != null;
    });
    await details.getByRole("button", { name: "Load Earlier Runs", exact: true }).click();
    const summaries = (await (await response).json()).result.data.operations as { operation_id: string; capability: { id: string } }[];
    await expect.poll(() => summaries.every((summary) => recordReads.has(summary.operation_id))).toBe(true);
    for (const summary of summaries) historicalSummaryIds.add(summary.operation_id);
    await expect.poll(async () => {
      const text = (await details.locator("summary").allTextContents()).join("\n");
      return summaries.filter((summary) => summary.capability.id === "workspace.run_r")
        .every((summary) => text.includes(summary.operation_id));
    }).toBe(true);
    historicalPages++;
  }
  expect((await details.locator("summary").allTextContents()).some((text) => text.includes(ids[0]))).toBe(true);
  expect(browserInvokes).toBe(0);
  await testInfo.attach("event-reliability", { body: JSON.stringify({ externalOperations: ids.length, eventPages, checkpoints, historicalPages, historicalOperationsRead: historicalSummaryIds.size, browserInvokes, counter: 105 }, null, 2), contentType: "application/json" });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("terminal output transport failures recover while failed execution refreshes Objects Packages and Plots", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await page.goto(url); await resetLayout(page);
  await invokeNative('rho_terminal_effect <- 0L; if ("package:ggplot2" %in% search()) detach("package:ggplot2", unload=FALSE)');
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: "Packages", exact: true }).click();
  const packages = page.locator(".packages-panel:visible");
  await packages.getByRole("button", { name: /^All \d/ }).click();
  await packages.getByLabel("Search Packages").fill("ggplot2");
  const ggplot2 = packages.getByRole("button", { name: /^ggplot2, / });
  await expect(ggplot2).toHaveCount(1);
  await expect(ggplot2).not.toHaveAttribute("aria-label", /Attached/);
  await page.getByRole("button", { name: "Plot Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Go to Latest", exact: true }).click();
  let operationId = "", terminalSeen = false, terminalFailures = 0, browserInvokes = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/host") && request.postDataJSON()?.frame?.request?.method === "invoke") browserInvokes++; });
  await page.route("**/api/host", async (route) => {
    const call = route.request().postDataJSON()?.frame?.request;
    if (call?.method === "query_snapshot" && call.params.capability.id === "workspace.output_events" && call.params.arguments.operation_id === operationId && (!terminalSeen || terminalFailures < 2)) {
      if (terminalSeen) terminalFailures++;
      await route.abort("connectionreset");
    } else await route.continue();
  });
  const record = await invokeNative('Sys.sleep(0.4); rho_terminal_effect <- rho_terminal_effect + 1L; rho_recovery_object <- data.frame(value=41L); library(ggplot2); plot(1:3); cat("rho_terminal_recovery\\n"); stop("rho_recovery_expected")', true);
  operationId = record.operation.operation_id;
  await expect.poll(async () => (await queryNative("operation.list_recent", { operation_id: operationId, limit: 1 })).data.operations[0].status).toBe("failed");
  terminalSeen = true;
  await expect.poll(() => terminalFailures).toBe(2);
  const newOutput = page.locator(".console-panel:visible").getByRole("button", { name: "New Output ↓", exact: true });
  if (await newOutput.isVisible()) await newOutput.click();
  await expect(page.locator(".console-transcript:visible")).toContainText("rho_terminal_recovery", { timeout: 20000 });
  await expect(page.locator('[data-plot-view="plots"] .plot-original img')).toHaveAttribute("data-operation-id", operationId, { timeout: 20000 });
  await expect(ggplot2).toHaveAttribute("aria-label", /Attached/);
  await page.getByRole("tab", { name: "Objects", exact: true }).click();
  await page.getByLabel("Filter Objects").fill("rho_recovery_object");
  await page.getByRole("button", { name: /^› rho_recovery_object$/ }).click();
  await expect(page.locator(".objects-panel table")).toContainText("41");
  expect((await queryNative("workspace.inspect_object", { name: "rho_terminal_effect", max_items: 1 })).data.preview).toEqual([1]);
  expect(browserInvokes).toBe(0);
  await testInfo.attach("terminal-output-recovery", { body: JSON.stringify({ operationId, terminalFailures, browserInvokes, counter: 1 }, null, 2), contentType: "application/json" });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("same-name previews retain independent demand and closed Packages restores after a cold refresh", async ({ page }, testInfo) => {
  await page.goto(url); await resetLayout(page);
  await invokeNative("rho_dual_preview <- data.frame(value=11L)");
  await page.getByLabel("Filter Objects").fill("rho_dual_preview");
  await page.getByRole("button", { name: /^› rho_dual_preview$/ }).click();
  await expect(page.locator(".objects-panel table")).toContainText("11");
  await page.getByRole("button", { name: "Open rho_dual_preview in New Tab", exact: true }).click();
  await moveVisibleView(page, "rho_dual_preview", "workspace", "Left");
  await expect(page.locator(".objects-panel:visible table")).toContainText("11");
  await expect(page.locator(".object-viewer:visible table")).toContainText("11");
  let inspections = 0;
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/host")) return;
    const call = request.postDataJSON()?.frame?.request;
    if (call?.method === "query_snapshot" && call.params.capability.id === "workspace.observe_object" && call.params.arguments.name === "rho_dual_preview") inspections++;
  });
  await invokeNative("rho_dual_preview$value <- 22L");
  await expect(page.locator(".objects-panel:visible table")).toContainText("22");
  await expect(page.locator(".object-viewer:visible table")).toContainText("22");
  expect(inspections).toBe(1);
  await page.getByRole("tab", { name: "rho_dual_preview", exact: true }).locator(".flexlayout__tab_button_trailing").click();
  await invokeNative("rho_dual_preview$value <- 33L");
  await expect(page.locator(".objects-panel:visible table")).toContainText("33");
  expect(inspections).toBe(2);
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: "Packages", exact: true }).click();
  await page.locator(".packages-panel:visible").getByLabel("Search Packages").fill("stats");
  await page.getByRole("tab", { name: "Packages", exact: true }).locator(".flexlayout__tab_button_trailing").click();
  await expect(page.getByText("Draft synced", { exact: true })).toBeVisible();
  // Hold a real registration response so the command necessarily competes
  // with restoration; waiting for restoration before clicking would hide it.
  let registered!: () => void, releaseRestore!: () => void;
  const registration = new Promise<void>((resolve) => { registered = resolve; });
  const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
  const bridgeRoute = async (route: import("@playwright/test").Route) => {
    const request = route.request().postDataJSON()?.frame?.request;
    if (request?.method === "application_bridge" && request.params.kind === "register") {
      const response = await route.fetch(); registered(); await restoreGate; await route.fulfill({ response });
    } else await route.continue();
  };
  await page.route("**/api/application/bridge", bridgeRoute);
  try {
    await page.reload(); await registration;
    await page.getByRole("button", { name: "Commands", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Show Packages", exact: true }).click();
    const preserved = page.waitForResponse((response) => {
      if (!response.url().endsWith("/api/application/bridge")) return false;
      const request = response.request().postDataJSON()?.frame?.request;
      return request?.method === "application_bridge" && request.params.kind === "sync" &&
        request.params.changes.context?.context.views.some((view: { view_id: string }) => view.view_id === "packages") === true;
    });
    releaseRestore(); expect((await (await preserved).json()).ok).toBe(true);
  } finally { releaseRestore(); await page.unroute("**/api/application/bridge", bridgeRoute); }
  await expect(page.locator(".packages-panel:visible").getByLabel("Search Packages")).toHaveValue("stats");
  await page.getByRole("tab", { name: "Objects", exact: true }).click();
  await page.getByLabel("Filter Objects").fill("rho_dual_preview");
  await expect(page.locator(".objects-panel:visible table")).toContainText("33");
  const cancellation = await invokeNative('rho_dual_preview$value <- 44L; cat("rho_cancel_ready\\n"); Sys.sleep(8)', true);
  await expect.poll(async () => (await queryNative("workspace.console_state")).data.current?.operation_id).toBe(cancellation.operation.operation_id);
  await expect.poll(async () => (await queryNative("workspace.output_events", { operation_id: cancellation.operation.operation_id, after_sequence: 0, limit: 100 })).data.events.some((event: { text?: string }) => event.text?.includes("rho_cancel_ready"))).toBe(true);
  const info = await (await api("/api/info")).json();
  const reply = await (await api("/api/host", { project_root: info.project_root, frame: { id: crypto.randomUUID(), request: { method: "request_cancellation", params: { operation_id: cancellation.operation.operation_id, only_if_pending: false } } } })).json();
  expect(reply.ok, reply.error).toBe(true);
  await expect.poll(async () => (await queryNative("operation.list_recent", { operation_id: cancellation.operation.operation_id, limit: 1 })).data.operations[0].status).toBe("cancelled");
  await expect(page.locator(".objects-panel:visible table")).toContainText("44");
  await testInfo.attach("view-demand", { body: JSON.stringify({ queriesForTwoViews: 1, queriesAfterClosingViewer: 1, cancelledOperation: cancellation.operation.operation_id, closedPackagesRestored: true }, null, 2), contentType: "application/json" });
});

test("Agent settings share the current Host, protect setup credentials and preserve drafts", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/agents/discover", route => route.fulfill({ json: nativeAgentCatalog(route.request().postDataJSON()) }));
  await page.route("**/api/agents/sessions", route => route.fulfill({ json: [] }));
  await writeFile(join(directory, "中文项目", "02_explore.R"), "agent_draft <- 1\n");
  await page.goto(url);
  await openFile(page, "02_explore.R");
  const editor = page.locator(".document-panel:visible .cm-content");
  await editor.fill("agent_draft <- 2\n# unsaved 分析\n");
  const textBefore = await editor.innerText();
  const runtimeBefore = (await queryNative("workspace.runtime_status")).data.session_id;
  const checkpointBefore = (await queryNative("operation.events_checkpoint")).data.sequence;
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await settings.getByText("Advanced: manual MCP setup", { exact: true }).click();
  const manual = settings.locator(".native-manual");
  await expect(manual.getByRole("button", { name: "Connect Codex", exact: true })).toBeEnabled();
  await expect(manual.getByText("This window · 02_explore.R", { exact: true })).toBeVisible();
  await expect(manual.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../target/studio-browser/agents-settings-normal.png" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: "../target/studio-browser/agents-settings-wide.png" });
  await page.setViewportSize({ width: 768, height: 760 });
  await page.screenshot({ path: "../target/studio-browser/agents-settings-compact.png" });
  expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await manual.getByRole("button", { name: "Connect Codex", exact: true }).click();
  await expect(manual.getByRole("region", { name: "Codex setup" })).toBeVisible();
  await manual.getByText("Configuration preview", { exact: true }).click();
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get("token")!;
  expect(await settings.innerText()).not.toContain(token);
  await manual.getByRole("button", { name: "Copy Codex configuration", exact: true }).click();
  await expect(manual.getByRole("status")).toContainText("Configuration copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`url = "${new URL(url).origin}/mcp"`);
  expect(copied).toContain(`Authorization = "Bearer ${token}"`);
  await expect(manual.getByText("Not connected", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../target/studio-browser/agents-setup.png" });
  await manual.getByRole("button", { name: "Copy connection check", exact: true }).click();
  await expect(manual.getByRole("status")).toContainText("Workspace check copied");
  const check = await page.evaluate(() => navigator.clipboard.readText());
  const windowId = await page.evaluate(() => sessionStorage.getItem("rho-window-id"));
  const windows = (await queryNative("application.windows")).data.windows;
  const windowRef = windows.find((w: any) => w.window.window_id === windowId).window;
  expect(check).toContain(JSON.stringify(windowRef));
  expect(check).not.toContain(token);
  const { McpClient } = await import("../../scripts/agent-interface/runtime.mjs");
  const mcp = new McpClient(`${new URL(url).origin}/mcp`, token);
  try {
    await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Codex fixture", version: "1" } });
    await fetch(mcp.url, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": mcp.session }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).then(r => r.arrayBuffer());
    await mcp.query("host.overview");
    await mcp.query("application.context", { window: windowRef, limit: 1 });
    await settings.getByRole("tab", { name: "Connections" }).click();
    await expect(settings.getByText("Session open", { exact: true })).toBeVisible();
    await expect(settings.getByText(/Window context served at/)).toBeVisible();
    await page.screenshot({ path: "../target/studio-browser/agents-connections.png" });
    await page.route("**/api/agent-connection", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture connection unavailable" }) }));
    await settings.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(settings.getByRole("alert")).toContainText("Fixture connection unavailable");
    await expect(settings.getByText("Session open", { exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Copy workspace context", exact: true })).toBeDisabled();
    await page.unroute("**/api/agent-connection");
    await settings.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(settings.getByText("Session open", { exact: true })).toBeVisible();
  } finally { await mcp.close(); }
  await expect(settings.getByText(/Closed at/)).toBeVisible();
  await settings.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(settings.getByRole("combobox", { name: "Code Font Size" })).toBeVisible();
  await settings.getByRole("button", { name: "R session", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Check Configuration", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect.poll(() => editor.innerText()).toBe(textBefore);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("menuitem", { name: "Undo Code Edit", exact: true }).click();
  await expect.poll(() => editor.innerText()).not.toBe(textBefore);
  expect((await queryNative("workspace.runtime_status")).data.session_id).toBe(runtimeBefore);
  expect((await queryNative("operation.events_checkpoint")).data.sequence).toBe(checkpointBefore);
  expect(errors).toEqual([]);
});

test("Native Agent settings select CLI models, test and send tasks without copying setup", async ({ page }) => {
  const errors: string[] = [], connections: ConnectAgent[] = [], actions: AgentClientAction[] = [];
  const clients = new Map<string, AgentClientSession>();
  const project = (await (await api("/api/info")).json()).project_root as string;
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText: () => { throw new Error("Native setup must not write the clipboard"); },
      readText: () => { throw new Error("Native setup must not read the clipboard"); },
    } });
  });
  await page.route("**/api/agents/discover", route => {
    const request = route.request().postDataJSON() as DiscoverAgent;
    expect(request.project_root).toBe(project);
    return route.fulfill({ json: nativeAgentCatalog(request) });
  });
  await page.route("**/api/agents/sessions", route => route.fulfill({ json: [...clients.values()] }));
  await page.route("**/api/agents/connect", route => {
    const request = route.request().postDataJSON() as ConnectAgent;
    expect(request.project_root).toBe(project);
    expect(route.request().headers()["x-rho-studio-window"]).toBe(request.window.window_id);
    expect(request.window.incarnation).toBeTruthy();
    connections.push(request);
    const client: AgentClientSession = {
      id: `fixture-${request.provider}`, provider: request.provider, native_session_id: `native-${request.provider}`,
      project_root: project, window: request.window, model: request.model, effort: request.effort, state: "ready",
      messages: [], activity: [], decisions: [], error: null, truncated: false, elapsed_ms: null, last_request_id: null,
    };
    clients.set(client.id, client);
    return route.fulfill({ json: client });
  });
  await page.route("**/api/agents/action", route => {
    const request = route.request().postDataJSON() as AgentClientAction;
    expect(request.project_root).toBe(project);
    expect(route.request().headers()["x-rho-studio-window"]).toBe(request.window.window_id);
    const client = clients.get(request.session_id)!;
    expect(client.window).toEqual(request.window);
    actions.push(request);
    switch (request.action.kind) {
      case "test":
        client.last_request_id = request.action.request_id;
        client.state = "running";
        client.messages = [{ role: "user", text: "Reply with exactly ok. Do not call tools or read files." }];
        client.activity = ["Waiting for the native model"];
        break;
      case "prompt":
        client.last_request_id = request.action.request_id;
        client.state = "waiting_for_permission";
        client.messages.push({ role: "user", text: request.action.text });
        client.messages.push({ role: "assistant", text: "I will read the current workspace overview." });
        client.decisions = [{ id: 42, title: "mcp__rho__rho_host_overview_v1", details: "Read this workspace overview", options: [{ id: "approve_once", label: "Allow once" }, { id: "reject_once", label: "Decline" }] }];
        break;
      case "decision":
        expect(request.action).toEqual({ kind: "decision", id: 42, option: "approve_once" });
        client.decisions = []; client.state = "running"; client.activity = ["Reading the current workspace"];
        break;
      case "disconnect": client.state = "disconnected"; break;
      default: throw new Error(`Unexpected native action ${request.action.kind}`);
    }
    return route.fulfill({ json: client });
  });
  await page.goto(url);
  await expect(page.locator(".console-status > span").first()).toHaveText("Ready");
  const checkpoint = (await queryNative("operation.events_checkpoint")).data.sequence;
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const codex = settings.getByRole("article", { name: "Codex connection", exact: true });
  const kimi = settings.getByRole("article", { name: "Kimi CLI connection", exact: true });
  await expect(codex.getByRole("combobox", { name: "Codex model", exact: true })).toHaveValue("native-balanced");
  await expect(kimi.getByRole("combobox", { name: "Kimi CLI model", exact: true })).toHaveValue("configured/flash");
  await expect(kimi.getByRole("combobox", { name: /reasoning effort/ })).toHaveCount(0);
  await expect(codex.getByText("From your CLI", { exact: true })).toBeVisible();
  await expect(kimi.getByText("Moonshot · Local CLI · 0.41.0", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Connect Codex", exact: true })).toBeEnabled();
  await expect(kimi.getByRole("button", { name: "Connect Kimi CLI", exact: true })).toBeEnabled();
  await expect(settings.getByRole("button", { name: /Copy/ })).toHaveCount(0);
  expect(connections).toHaveLength(0); expect(actions).toHaveLength(0);
  await page.screenshot({ path: "../target/studio-browser/agents-native-models-normal.png" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: "../target/studio-browser/agents-native-models-wide.png" });
  await page.setViewportSize({ width: 600, height: 760 });
  expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await settings.locator(".settings-main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: "../target/studio-browser/agents-native-models-compact.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await codex.getByRole("combobox", { name: "Codex model", exact: true }).selectOption("native-detailed");
  await expect(codex.getByRole("combobox", { name: "Codex reasoning effort", exact: true })).toHaveValue("medium");
  await codex.getByRole("combobox", { name: "Codex reasoning effort", exact: true }).selectOption("high");
  await codex.getByRole("button", { name: "Test", exact: true }).click();
  await expect(codex.getByRole("status")).toHaveText("Agent working");
  expect(connections).toHaveLength(1);
  expect(connections[0]).toMatchObject({ provider: "codex", model: "native-detailed", effort: "high", project_root: project });
  expect(actions.map(r => r.action.kind)).toEqual(["test"]);
  const codexClient = clients.get("fixture-codex")!;
  codexClient.messages.push({ role: "assistant", text: "ok" }); codexClient.state = "ready"; codexClient.elapsed_ms = 1300;
  await expect(codex.getByRole("status")).toHaveText("Session ready");
  await expect(codex.locator(".native-message.assistant pre")).toHaveText("ok");
  await expect(codex.getByText("Responded in 1.3s", { exact: true })).toBeVisible();
  await kimi.getByRole("button", { name: "Connect Kimi CLI", exact: true }).click();
  await expect(kimi.getByRole("status")).toHaveText("Session ready");
  await kimi.getByRole("textbox", { name: "Ask about this workspace" }).fill("Read the current workspace overview.");
  await kimi.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kimi.getByRole("status")).toHaveText("Your Agent is waiting for permission");
  await expect(kimi.getByRole("textbox", { name: "Ask about this workspace" })).toHaveValue("");
  await expect(kimi.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(kimi.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(kimi.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
  await kimi.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../target/studio-browser/agents-native-permission.png" });
  await kimi.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(kimi.getByRole("status")).toHaveText("Agent working");
  const kimiClient = clients.get("fixture-kimi")!;
  kimiClient.messages.push({ role: "assistant", text: "Workspace ready · 中文项目" }); kimiClient.state = "ready"; kimiClient.elapsed_ms = 2200;
  await expect(kimi.getByRole("status")).toHaveText("Session ready");
  await expect(kimi.locator(".native-message.assistant pre").last()).toHaveText("Workspace ready · 中文项目");
  await page.screenshot({ path: "../target/studio-browser/agents-native-response.png" });
  kimiClient.state = "uncertain"; kimiClient.error = "The native Agent did not confirm completion.";
  await expect(kimi.getByRole("status")).toHaveText("Outcome not confirmed");
  await expect(kimi.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(kimi.getByRole("button", { name: "Disconnect", exact: true })).toBeEnabled();
  await kimi.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(kimi.getByRole("status")).toHaveText("Agent disconnected");
  await expect(kimi.getByRole("alert")).toContainText("The native Agent did not confirm completion.");
  await expect(kimi.locator(".native-message.assistant pre").last()).toHaveText("Workspace ready · 中文项目");
  await expect(kimi.getByRole("textbox", { name: "Ask about this workspace" })).toBeDisabled();
  await expect(kimi.getByRole("button", { name: "Connect Kimi CLI", exact: true })).toBeEnabled();
  await kimi.getByText("Session details", { exact: true }).click();
  await expect(kimi.getByText("native-kimi", { exact: true })).toBeVisible();
  const windowId = await page.evaluate(() => sessionStorage.getItem("rho-window-id"));
  expect(connections.every(request => request.window.window_id === windowId)).toBe(true);
  expect(actions.map(request => request.action.kind)).toEqual(["test", "prompt", "decision", "disconnect"]);
  expect(JSON.stringify({ connections, actions })).not.toContain("Bearer");
  expect((await queryNative("operation.events_checkpoint")).data.sequence).toBe(checkpoint);
  expect(errors).toEqual([]);
});
