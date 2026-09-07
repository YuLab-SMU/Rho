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
test("real R Console, settings and docking shell", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await expect(page.getByText("中文项目", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "执行", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "R Console 输入" })
    .fill('cat("Studio R ready\\n")');
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await expect(page.getByText("Studio R ready", { exact: true })).toBeVisible();
  await expect(page.locator(".run[data-status=succeeded]")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText("jsonlite 可用 · rlang 可用 · Ark 可用"),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: "../target/studio-browser/m1-shell.png" });
  expect(errors).toEqual([]);
});

test("incremental output precedes completion and plots keep their identity", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  const input = page.getByRole("textbox", { name: "R Console 输入" });
  await input.fill(
    'cat("first-live\\n"); Sys.sleep(3); cat("second-live\\n"); plot(1:4)',
  );
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await expect(
    page.locator(".stream-output").getByText("first-live", { exact: true }),
  ).toBeVisible({ timeout: 2500 });
  await expect(page.locator(".run[data-status=running]")).toBeVisible();
  await expect(
    page.locator(".stream-output").getByText("second-live", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".media-card img").last()).toBeVisible();
  await page.locator(".media-card").last().click();
  await expect(page.locator(".plot-image img")).toBeVisible();
  const original = await page.locator(".plot-image img").getAttribute("src");
  await input.fill(
    'plot(4:1); cat("before failure\\n"); stop("expected studio failure")',
  );
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await expect(page.locator(".run[data-status=failed]")).toBeVisible();
  await expect(
    page.locator(".stream-output").getByText("before failure", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".media-card")).toHaveCount(2);
  await expect(page.locator(".plot-image img")).toHaveAttribute(
    "src",
    original!,
  );
  await page.getByRole("button", { name: "下一张图" }).click();
  await expect(page.locator(".plot-image img")).not.toHaveAttribute(
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
  await page
    .getByRole("button", { name: "＋ 新建 R 文件", exact: true })
    .click();
  const editor = page.locator(".document-panel .cm-content");
  await editor.fill(
    'studio_data <- data.frame(组别 = c("甲", "乙"), value = c(1, 2))\ncat("saved file ran\\n")\nplot(studio_data$value)\n',
  );
  await page.getByRole("button", { name: "运行文件", exact: true }).click();
  await page.getByLabel("文件路径", { exact: true }).fill("分析脚本.R");
  await page.getByRole("button", { name: "保存并运行", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator(".stream-output").getByText("saved file ran", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".save-status")).toHaveText("✓ 已保存");
  await expect(
    page
      .getByRole("button")
      .filter({ has: page.locator("code", { hasText: "studio_data" }) }),
  ).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.locator("code", { hasText: "studio_data" }) })
    .click();
  await expect(page.locator(".object-viewer table")).toContainText("甲");
  await editor.fill(
    'studio_data$value <- c(3, 4)\ncat("modified file ran\\n")\nplot(studio_data$value)\n',
  );
  await editor.press("Meta+Shift+Enter");
  await expect(
    page
      .locator(".stream-output")
      .getByText("modified file ran", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".save-status")).toHaveText("✓ 已保存");
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
  await page.getByRole("button", { name: "项目文件", exact: true }).click();
  await page
    .getByRole("textbox", { name: "打开相对文件路径" })
    .fill("跨页 文件.R");
  await page.getByRole("button", { name: "打开", exact: true }).click();
  const editor = page.locator(".document-panel:visible .cm-content");
  await expect(editor).toContainText("x <- 1");
  await editor.press("Meta+End");
  await editor.press("End");
  await editor.press("Enter");
  await editor.press("x");
  await editor.press("Meta+s");
  await expect(page.locator(".document-panel:visible .save-status")).toHaveText(
    "✓ 已保存",
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
  await page.getByRole("button", { name: "运行文件", exact: true }).click();
  await expect(
    page.locator(".document-panel:visible [role=alert]"),
  ).toContainText(/precondition failed|patch does not apply/);
  expect(runs).toBe(0);
  expect(await readFile(file, "utf8")).toBe("# external disk edit\r\n");
  await expect(page.getByText("草稿已同步", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 新建 R 文件", exact: true })
    .click();
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
    .filter({ has: page.getByRole("tab", { name: /未命名/ }) });
  await group.getByRole("button", { name: "收起面板组" }).click();
  await expect
    .poll(async () => Math.round((await group.boundingBox())!.height))
    .toBe(38);
  await group.getByRole("button", { name: "展开面板组" }).click();
  await expect(editor).toContainText("# draft preserved!");
  await group.getByRole("button", { name: "Maximize tab set" }).click();
  await expect(editor).toBeVisible();
  await group.getByRole("button", { name: "Restore tab set" }).click();
  const tab = group.getByRole("tab", { name: /未命名/ });
  const target = page.getByRole("tab", { name: "R Console", exact: true });
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
    .getByRole("tab", { name: /未命名/ })
    .locator(".flexlayout__tab_button_trailing")
    .click();
  await expect(page.locator(".document-panel")).toHaveCount(0);
  await page.locator(".document-list button").last().click();
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
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 新建 R 文件", exact: true })
    .click();
  await page
    .locator(".document-panel:visible .cm-content")
    .fill("# 跨端口保留的草稿");
  await expect(page.getByText("草稿已同步", { exact: true })).toBeVisible();
  const previous = url;
  await stopHost();
  await startHost();
  expect(new URL(url).port).not.toBe(new URL(previous).port);
  await page.goto(url);
  await expect(
    page.locator(".document-panel:visible .cm-content"),
  ).toContainText("跨端口保留的草稿");
  await expect(page.getByText("草稿已同步", { exact: true })).toBeVisible();
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
    .getByRole("textbox", { name: "R Console 输入" })
    .fill(
      'cat("unconfirmed_once start\\n"); Sys.sleep(3); cat("unconfirmed_once end\\n")',
    );
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await expect(
    page
      .locator(".stream-output")
      .getByText("unconfirmed_once start", { exact: true }),
  ).toBeVisible({ timeout: 2500 });
  expect(requestId).not.toBe("");
  await page.reload();
  await expect(
    page
      .locator(".stream-output")
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
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 新建 R 文件", exact: true })
    .click();
  const editor = page.locator(".document-panel:visible .cm-content");
  await editor.fill("# initial");
  await expect(page.getByText("草稿已同步", { exact: true })).toBeVisible();
  await context.setOffline(true);
  await editor.fill("# 离线草稿必须保留");
  await expect(page.getByText("草稿待同步", { exact: true })).toBeVisible();
  await expect(page.locator(".notice")).toBeVisible();
  await expect(editor).toContainText("离线草稿必须保留");
  await context.setOffline(false);
  await expect(page.getByText("草稿已同步", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 新建 R 文件", exact: true })
    .click();
  await page
    .locator(".document-panel:visible .cm-content")
    .fill("# shared starting draft");
  await expect(page.getByText("草稿已同步", { exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto(url);
  await expect(
    second.locator(".document-panel:visible .cm-content"),
  ).toContainText("shared starting draft");
  await page
    .locator(".document-panel:visible .cm-content")
    .fill("# window one");
  await expect(page.getByText("草稿已同步", { exact: true })).toBeVisible();
  await second
    .locator(".document-panel:visible .cm-content")
    .fill("# window two retained");
  await expect(second.locator(".notice")).toContainText(
    /another window|另一个窗口/,
  );
  await expect(
    second.locator(".document-panel:visible .cm-content"),
  ).toContainText("window two retained");
  await page.reload();
  await expect(
    page.locator(".document-panel:visible .cm-content"),
  ).toContainText("window one");
  await second.getByRole("button", { name: "重试草稿同步" }).click();
  await second.getByRole("button", { name: "处理窗口冲突" }).click();
  await second
    .getByRole("button", { name: "确认使用当前窗口的草稿与布局" })
    .click();
  await expect(second.getByText("草稿已同步", { exact: true })).toBeVisible();
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
    .getByRole("textbox", { name: "R Console 输入" })
    .fill('cat("switch fence started\\n"); Sys.sleep(3)');
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await expect(
    page
      .locator(".stream-output")
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
  await expect(page.locator(".run[data-status=running]")).toHaveCount(0);
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
    .getByRole("textbox", { name: "R Console 输入" })
    .fill('dev_sentinel <- 123; cat("dev session ready\\n")');
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await expect(
    page
      .locator(".stream-output")
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
  await page
    .getByRole("textbox", { name: "R Console 输入" })
    .fill('plot(1:3); cat("<iframe onload=parent.__rhoAttack=3>\\n")');
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await expect(page.locator(".media-card img").last()).toBeVisible();
  await page.locator(".media-card").last().click();
  await expect(page.locator(".plot-image img")).toBeVisible();
  expect(await page.evaluate(() => "__rhoAttack" in window)).toBe(false);
  expect(await page.locator("iframe").count()).toBe(0);
  await expect(
    page
      .locator(".stream-output")
      .getByText("<iframe onload=parent.__rhoAttack=3>", { exact: true }),
  ).toBeVisible();
});

test("narrow and short containers keep essential controls and 38px groups", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 新建 R 文件", exact: true })
    .click();
  await page
    .locator(".document-panel:visible .cm-content")
    .fill("# size fixture");
  await page
    .getByRole("textbox", { name: "R Console 输入" })
    .fill("size_data <- data.frame(x=1:30, y=1:30); plot(1:3)");
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await expect(page.locator(".media-card img").last()).toBeVisible();
  await page.locator(".media-card").last().click();
  const bounds = await page.getByRole("separator").evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
  const vertical = bounds.find((r) => r.width <= 10 && r.height > 600)!;
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
  ).find((r) => r.width > 700 && r.height <= 10)!;
  await page.mouse.move(horizontal.x + 200, horizontal.y + 4);
  await page.mouse.down();
  await page.mouse.move(horizontal.x + 200, 756, { steps: 10 });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "运行文件", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".console-status")).toBeVisible();
  await expect(page.getByRole("link", { name: "↓ 导出" })).toBeVisible();
  await page.screenshot({ path: "../target/studio-browser/m4-h04.png" });
  const plotGroup = page
    .locator(".flexlayout__tabset")
    .filter({ has: page.getByRole("tab", { name: "图表", exact: true }) });
  await plotGroup.getByRole("button", { name: "收起面板组" }).click();
  await expect
    .poll(async () => Math.round((await plotGroup.boundingBox())!.height))
    .toBe(38);
  await plotGroup.getByRole("button", { name: "Maximize tab set" }).click();
  await expect(page.locator(".plot-image img")).toBeVisible();
  await expect
    .poll(async () => (await plotGroup.boundingBox())!.height)
    .toBeGreaterThan(700);
  await plotGroup.getByRole("button", { name: "Restore tab set" }).click();
  await expect
    .poll(async () => Math.round((await plotGroup.boundingBox())!.height))
    .toBe(38);
  await plotGroup.getByRole("button", { name: "展开面板组" }).click();
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page.locator(".document-list button").last().click();
  await page.setViewportSize({ width: 560, height: 300 });
  await expect(page.locator(".console-status")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "图形缩放" })).toBeVisible();
  await expect(page.getByRole("link", { name: "↓ 导出" })).toBeVisible();
  await page.screenshot({ path: "../target/studio-browser/m4-combined.png" });
});

test("editor preferences persist without executing code or losing document text", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 新建 R 文件", exact: true })
    .click();
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("combobox", { name: "代码字号" }).selectOption("16");
  await page.getByRole("combobox", { name: "缩进宽度" }).selectOption("2");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".document-panel:visible .cm-editor")).toHaveCSS(
    "font-size",
    "16px",
  );
  await expect(editor).toContainText("偏好不改变文档");
  await expect(page.getByText("草稿已同步", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".document-panel:visible .cm-editor")).toHaveCSS(
    "font-size",
    "16px",
  );
  expect(invokes).toBe(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("combobox", { name: "代码字号" }).selectOption("14");
  await page.getByRole("combobox", { name: "缩进宽度" }).selectOption("4");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
});

test("long streaming output does not remount the editor or move its focus", async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 新建 R 文件", exact: true })
    .click();
  const editor = page.locator(".document-panel:visible .cm-content");
  await editor.fill("# ");
  const handle = await editor.elementHandle();
  await page
    .getByRole("textbox", { name: "R Console 输入" })
    .fill(
      'for (i in 1:8) { cat(paste(rep("long output", 1200), collapse=" "), "\\n"); Sys.sleep(0.2) }',
    );
  await page.getByRole("button", { name: "执行", exact: true }).click();
  await editor.click();
  await editor.press("End");
  await page.keyboard.insertText("中文输入保持稳定");
  await expect(page.locator(".stream-output").last()).toContainText(
    "long output",
  );
  await expect(page.locator(".run[data-status=running]")).toHaveCount(0);
  expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(editor).toBeFocused();
  await expect(editor).toContainText("中文输入保持稳定");
});
