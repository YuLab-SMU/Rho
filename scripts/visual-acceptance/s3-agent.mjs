// S3: one bounded, read-only Agent turn through the current agent.chat route.
//
// Agent availability is detected through the product path, not an operator
// assertion or a secret-bearing environment dump. The scenario first renders
// the Agent surface, then submits one read-only prompt through a canonical V6
// config and agent.chat route. The fixture's
// declared credential environment name is deliberately absent, so only a
// precise missing-credential / unavailable-credential-source outcome becomes
// an auditable SKIP with bounded, redacted product evidence. Authentication
// rejection, quota, network, endpoint, malformed configuration, and other
// product errors stay failures. Absence never becomes a fabricated pass.
//
// This module is intentionally self-contained (no helpers.mjs import) because
// helpers.mjs is owned by another parallel lane.

import path from "node:path";

class AssertionFailure extends Error {}

function truncate(value, max = 300) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function redactEvidence(value) {
  return truncate(String(value)
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/([?&](?:api[_-]?key|key|token|secret|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b((?:api[_ -]?key|token|secret|authorization)\s*[:=])\s*\S+/gi, "$1 [redacted]"), 500);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new AssertionFailure(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new AssertionFailure(`${label} request timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function waitUntil(label, probe, { timeoutMs = 30_000, intervalMs = 400 } = {}) {
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

async function openProject(ctx, projectPath, timeoutMs = 90_000) {
  await ctx.act({ kind: "open_project", path: projectPath });
  const expectedName = path.basename(projectPath);
  return waitUntil(`project ${expectedName} active`, async () => {
    const ready = await withTimeout(ctx.ready(), 10_000, "ready");
    if (ready.rsrReady !== true || ready.projectPath == null) return null;
    return ready.projectPath.endsWith(expectedName) ? ready : null;
  }, { timeoutMs });
}

async function openSurface(ctx, surfaceId, timeoutMs = 20_000) {
  await ctx.act({ kind: "open_surface", surface_id: surfaceId });
  return waitUntil(`surface ${surfaceId} mounted`, async () => {
    const matches = await ctx.query(`[data-surface-id="${surfaceId}"]`);
    return matches.length > 0 ? true : null;
  }, { timeoutMs });
}

async function isolateSurface(ctx, surfaceId, timeoutMs = 30_000) {
  const before = await ctx.snapshot();
  const retained = before.surfaces.filter((surface) => surface.surface_id === surfaceId);
  if (retained.length === 0) {
    throw new AssertionFailure(`cannot isolate unavailable surface ${surfaceId}`);
  }
  const closed = before.surfaces.filter((surface) => surface.surface_id !== surfaceId);
  for (const surface of closed) {
    await ctx.act({ kind: "close_instance", instance_id: surface.instance_id });
  }
  const after = await waitUntil(`surface ${surfaceId} isolated`, async () => {
    const snapshot = await ctx.snapshot();
    const mounted = await ctx.query("[data-surface-id]", {
      all: true,
      attribute: "data-surface-id",
    });
    const mountedIds = mounted.map((surface) => surface.value).filter(Boolean);
    return mountedIds.length > 0 && mountedIds.every((id) => id === surfaceId)
      ? { snapshot, mountedIds }
      : null;
  }, { timeoutMs });
  return {
    snapshot: after.snapshot,
    closed: closed.map((surface) => ({
      instance_id: surface.instance_id,
      surface_id: surface.surface_id,
    })),
    retained: after.snapshot.surfaces
      .filter((surface) => surface.surface_id === surfaceId)
      .map((surface) => ({
      instance_id: surface.instance_id,
      surface_id: surface.surface_id,
      lifecycle_state: surface.lifecycle_state,
    })),
    mountedIds: after.mountedIds,
  };
}

const AGENT_SURFACE = '[data-surface-id="rho.agent"]';
const COMPOSER = `${AGENT_SURFACE} .rho-agent-composer textarea`;
const SEND_BUTTON = `${AGENT_SURFACE} .rho-agent-composer-actions .rho-primary-action`;
const STREAM_ITEMS = `${AGENT_SURFACE} .rho-agent-stream-item`;
const ACTION_ERROR = ".rho-action-error";
const PROMPT = "Reply with exactly RHO_AGENT_OK. Do not call tools, run code, or modify files.";

async function queriedText(ctx, selector) {
  const records = await ctx.query(selector);
  return records[0]?.text?.trim() ?? "";
}

async function streamItems(ctx) {
  const records = await ctx.query(STREAM_ITEMS, { all: true, attribute: "class" });
  return records.map((record) => ({ className: record.value ?? "", text: record.text ?? "" }));
}

function itemIdentity(item) {
  return `${item.className}\u001f${item.text}`;
}

function itemsOfKind(items, kind) {
  return items.filter((item) => item.className.includes(`rho-agent-stream-${kind}`));
}

function unavailableCredentialReason(message) {
  const text = String(message);
  const missing = [
    // The rendered failed-turn detail is length-bounded and can end mid-word;
    // match the stable product prefix without requiring the clipped suffix.
    /credential was not received from the system credent/i,
    /system credential store is unavailable/i,
    /provider credential is missing/i,
    /no api key is available/i,
    /api key (?:is )?(?:missing|not configured|not available|not detected)/i,
    /credential (?:is )?(?:missing|not configured|not available|not detected)/i,
  ].find((pattern) => pattern.test(text));
  if (missing != null) {
    return {
      category: "credential_not_available",
      credential_state: "not_available",
      configuration_state: "available",
      evidence: redactEvidence(text),
    };
  }
  return null;
}

function unavailableDetection(message, evidenceSource, extra = {}) {
  const reason = unavailableCredentialReason(message);
  if (reason == null) return null;
  return {
    agent_state: "not_available",
    credential_state: reason.credential_state,
    configuration_state: reason.configuration_state,
    unavailable_category: reason.category,
    evidence_source: evidenceSource,
    terminal_status: "not_started",
    product_error: reason.evidence,
    ...extra,
  };
}

async function waitForRestrictedTurn(ctx, beforeItemKeys, previousActionError) {
  return waitUntil("restricted Agent turn terminal state", async () => {
    const actionError = await queriedText(ctx, ACTION_ERROR);
    if (actionError && actionError !== previousActionError) {
      return { kind: "submission_error", message: actionError };
    }
    const items = await streamItems(ctx);
    const failed = itemsOfKind(items, "failure")
      .find((item) => !beforeItemKeys.has(itemIdentity(item)));
    if (failed != null) return { kind: "terminal", status: "failed", item: failed };
    const answered = itemsOfKind(items, "answer")
      .find((item) => !beforeItemKeys.has(itemIdentity(item)));
    if (answered != null) return { kind: "terminal", status: "completed", item: answered };
    return null;
  }, { timeoutMs: 300_000, intervalMs: 1_000 });
}

async function runCredentialDetection(ctx) {
  const beforeItemKeys = new Set((await streamItems(ctx)).map(itemIdentity));
  const previousActionError = await queriedText(ctx, ACTION_ERROR);

  await ctx.act({ kind: "type", selector: COMPOSER, text: PROMPT });
  await waitUntil("Agent send enabled", async () => {
    const matches = await ctx.query(SEND_BUTTON, { attribute: "disabled" });
    return matches.length > 0 && matches[0].value == null ? true : null;
  }, { timeoutMs: 60_000 });
  await ctx.act({ kind: "click", selector: SEND_BUTTON });

  const outcome = await waitForRestrictedTurn(ctx, beforeItemKeys, previousActionError);
  if (outcome.kind === "submission_error") {
    const unavailable = unavailableDetection(
      outcome.message,
      "current agent.chat turn admission",
    );
    if (unavailable != null) return unavailable;
    throw new AssertionFailure(`Agent turn submission failed: ${redactEvidence(outcome.message)}`);
  }

  if (outcome.status === "completed") {
    const finalAnswer = outcome.item.text.trim();
    if (!finalAnswer) {
      throw new AssertionFailure("restricted Agent turn completed but rendered no final answer");
    }
    return {
      agent_state: "usable",
      credential_state: "usable",
      configuration_state: "available",
      evidence_source: "completed restricted turn on current agent.chat route",
      terminal_status: outcome.status,
      final_answer: truncate(finalAnswer, 500),
    };
  }
  const unavailable = unavailableDetection(
    outcome.item.text,
    "current agent.chat terminal turn",
    { terminal_status: outcome.status },
  );
  if (unavailable != null) return unavailable;
  throw new AssertionFailure(
    `restricted Agent turn ended ${outcome.status}: ${redactEvidence(outcome.item.text)}`,
  );
}

export default async function s3(ctx) {
  await ctx.gate("s3", "agent-surface", async () => {
    const ready = await openProject(ctx, ctx.fixtures.workingProject);
    await openSurface(ctx, "rho.agent");
    const isolation = await isolateSurface(ctx, "rho.agent");
    const snapshot = isolation.snapshot;
    assertEqual(snapshot.kernel?.agent_health, "ready", "Agent runtime health");
    const composer = await waitUntil("Agent composer", async () => {
      const found = await ctx.query(COMPOSER);
      return found.length > 0 ? found : null;
    }, { timeoutMs: 20_000 });
    const send = await ctx.query(SEND_BUTTON);
    if (send.length === 0) {
      throw new AssertionFailure(`Agent Send control not found via ${SEND_BUTTON}`);
    }
    const loopHint = await queriedText(ctx, `${AGENT_SURFACE} .rho-agent-composer-hint`);
    const streamItemCount = (await ctx.query(STREAM_ITEMS, { all: true })).length;
    // Rho exposes and executes; the Agent owns its permission model. The surface
    // must therefore offer no approval, permission, or workflow-mode control.
    const gatingControls = (await ctx.query(`${AGENT_SURFACE} button`, { all: true }))
      .map((button) => (button.text ?? "").trim().toLowerCase())
      .filter((label) => ["approve", "deny", "allow", "reject", "ask", "plan", "act"].includes(label));
    assertEqual(gatingControls.length, 0, "Agent surface gating controls");
    return {
      projectPath: ready.projectPath,
      agentHealth: snapshot.kernel?.agent_health,
      composerPresent: composer.length > 0,
      sendPresent: true,
      loopHint,
      streamItemCount,
      gatingControls,
      closedPlacements: isolation.closed,
      retainedPlacements: isolation.retained,
      mountedSurfaceIds: isolation.mountedIds,
    };
  }, {
    screenshot: "s3-agent-surface",
    criteria: [
      "Agent 只呈现一条连续时间线和一个 composer，没有模式切换、审批或权限控件",
      "独立 Agent 组件充分使用工作区；时间线、composer 与 Send 控件边界清楚，无重叠或裁切",
      "空会话状态（若展示）与当前 working-project 上下文一致，页面无凭据或密钥文本泄漏",
      "画面只保留 Agent placement，未残留 Navigator、Console、Environment 等默认三栏组件，且没有页级横向滚动条",
    ],
  });

  let detection = null;
  await ctx.gate("s3", "agent-credential-detection", async () => {
    detection = await runCredentialDetection(ctx);
    return {
      ...detection,
      detection_contract: "fresh isolated Rho home with a canonical V6 agent.chat route and an intentionally absent declared credential; one read-only prompt; no tools, code execution, file mutation, credential value, or ambient environment inspection",
    };
  });

  if (detection?.agent_state !== "usable") {
    const reason = [
      "current agent.chat credential is not available in the hermetic acceptance home",
      `category=${detection?.unavailable_category ?? "unknown"}`,
      `configuration=${detection?.configuration_state ?? "unknown"}`,
      `credential=${detection?.credential_state ?? "unknown"}`,
      `source=${detection?.evidence_source ?? "unknown"}`,
      `terminal=${detection?.terminal_status ?? "unknown"}`,
      `evidence=${detection?.product_error ?? "no credential evidence returned"}`,
    ].join("; ");
    ctx.skipGate("s3", "agent-turn", reason);
    return;
  }

  await ctx.gate("s3", "agent-turn", async () => {
    assertEqual(detection.terminal_status, "completed", "restricted Agent turn status");
    if (!detection.final_answer?.trim()) {
      throw new AssertionFailure("restricted Agent turn has no rendered final answer");
    }
    if (!detection.final_answer.includes("RHO_AGENT_OK")) {
      throw new AssertionFailure(
        `restricted Agent answer did not contain RHO_AGENT_OK: ${redactEvidence(detection.final_answer)}`,
      );
    }
    const running = await ctx.query(`${AGENT_SURFACE} .rho-agent-running`, { all: true });
    assertEqual(running.length, 0, "restricted Agent turn still marked running");
    const failures = itemsOfKind(await streamItems(ctx), "failure");
    assertEqual(failures.length, 0, "restricted Agent turn failure items");
    const gatingControls = (await ctx.query(`${AGENT_SURFACE} button`, { all: true }))
      .map((button) => (button.text ?? "").trim().toLowerCase())
      .filter((label) => ["approve", "deny", "allow", "reject"].includes(label));
    assertEqual(gatingControls.length, 0, "restricted Agent approval controls");
    return {
      prompt: PROMPT,
      outcome: detection.terminal_status,
      answer: truncate(detection.final_answer, 300),
      runningIndicatorCount: running.length,
      failureItemCount: failures.length,
      approvalControlCount: gatingControls.length,
    };
  }, {
    screenshot: "s3-agent-turn",
    criteria: [
      "时间线按发生顺序呈现该 turn，完成的回答与 composer 分区清楚",
      "最终回答完整显示 RHO_AGENT_OK，且没有失败项、错误文案或运行中指示器",
      "该只读 turn 没有任何审批、授权或权限控件",
      "时间线正文不被挤压或裁切，与 composer 无重叠",
    ],
  });
}
