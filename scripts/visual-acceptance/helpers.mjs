// Shared helpers for the visual acceptance scenario modules. Every helper
// only uses the fixed automation vocabulary exposed on `ctx`; nothing here
// reaches around the bridge.

import path from "node:path";

export class AssertionFailure extends Error {}

export function truncate(value, max = 300) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function assertIncludes(haystack, needle, label) {
  const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  if (!text.includes(needle)) {
    throw new AssertionFailure(`${label}: expected ${JSON.stringify(needle)} in ${truncate(text, 500)}`);
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new AssertionFailure(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(truncate(actual, 200))}`);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Client-side guard for one automation request. The bridge holds an
// unanswered eval for up to 300s (its own timeout), so a request emitted
// while the frontend listener is momentarily absent must be abandoned
// quickly and retried by the surrounding poll instead.
export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new AssertionFailure(`${label} request timed out after ${ms}ms`)), ms);
    }),
  ]);
}

export async function waitUntil(label, probe, { timeoutMs = 30_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new AssertionFailure(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

export async function waitReady(ctx, timeoutMs = 90_000) {
  return waitUntil("workbench ready", async () => {
    const ready = await withTimeout(ctx.ready(), 10_000, "ready");
    return ready.rsrReady === true ? ready : null;
  }, { timeoutMs });
}

// Opens a project and waits until the readiness probe reports it as the
// active project. `open_project` resolves on workbench ready, but the project
// path handoff can lag one refresh cycle, so this polls.
export async function openProject(ctx, projectPath, timeoutMs = 90_000) {
  await ctx.act({ kind: "open_project", path: projectPath });
  const expectedName = path.basename(projectPath);
  return waitUntil(`project ${expectedName} active`, async () => {
    const ready = await withTimeout(ctx.ready(), 10_000, "ready");
    if (ready.rsrReady !== true || ready.projectPath == null) return null;
    return ready.projectPath.endsWith(expectedName) ? ready : null;
  }, { timeoutMs });
}

export async function waitRuntimeReady(ctx, timeoutMs = 90_000) {
  return waitUntil("workspace runtime ready", async () => {
    const snapshot = await withTimeout(ctx.snapshot(), 10_000, "snapshot");
    return snapshot.runtimes.some((runtime) => runtime.status === "ready") ? snapshot : null;
  }, { timeoutMs });
}

// Runs one console submission and returns the {status, preview, execution_id}
// result. Fails the calling gate when the execution did not end in the
// expected terminal status.
export async function runConsole(ctx, code, { expect = "completed", timeoutMs = 120_000, label = code } = {}) {
  const result = await ctx.act({ kind: "console_submit", code, timeout_ms: timeoutMs });
  if (result.status !== expect) {
    throw new AssertionFailure(
      `${label}: expected status ${JSON.stringify(expect)}, got ${JSON.stringify(result.status)}; preview: ${truncate(result.preview, 400)}`,
    );
  }
  return result;
}

export async function sourceProjectFile(ctx, relativePath, options = {}) {
  return runConsole(ctx, `source(${JSON.stringify(relativePath)})`, { ...options, label: `source(${relativePath})` });
}

// Bounded record listing for one open surface. Each record text is capped at
// 500 characters by the automation surface, so assert on record-level facts
// rather than whole-surface text.
export async function surfaceRecords(ctx, surfaceId, { attribute = "data-domain-id", selector = `[data-${attribute.split("-").slice(1).join("-")}]` } = {}) {
  const css = `[data-surface-id="${surfaceId}"] ${selector}`;
  const records = await ctx.query(css, { all: true, attribute });
  return records.map((record) => ({ id: record.value ?? null, text: record.text ?? "" }));
}

export async function domainRecords(ctx, surfaceId) {
  return surfaceRecords(ctx, surfaceId, { attribute: "data-domain-id", selector: "[data-domain-id]" });
}

export async function environmentRecords(ctx) {
  return surfaceRecords(ctx, "rho.environment", { attribute: "data-environment-id", selector: "[data-environment-id]" });
}

export async function openSurface(ctx, surfaceId, timeoutMs = 20_000) {
  await ctx.act({ kind: "open_surface", surface_id: surfaceId });
  return waitUntil(`surface ${surfaceId} mounted`, async () => {
    const matches = await ctx.query(`[data-surface-id="${surfaceId}"]`);
    return matches.length > 0 ? true : null;
  }, { timeoutMs });
}

// Give one component a reviewable viewport by closing unrelated placements.
// This uses the same close command as the visible surface chrome and keeps
// scenario assertions independent from whichever panels a prior gate opened.
export async function isolateSurfaces(ctx, keepSurfaceIds) {
  const keep = new Set(keepSurfaceIds);
  const snapshot = await ctx.snapshot();
  for (const instance of snapshot.surfaces) {
    if (!keep.has(instance.surface_id)) {
      await ctx.act({ kind: "close_instance", instance_id: instance.instance_id });
    }
  }
}

export async function waitForText(ctx, text, timeoutMs = 30_000) {
  await ctx.act({ kind: "wait", until: { text }, timeout_ms: timeoutMs });
}

export async function waitForSelector(ctx, selector, timeoutMs = 30_000) {
  await ctx.act({ kind: "wait", until: { selector }, timeout_ms: timeoutMs });
}
