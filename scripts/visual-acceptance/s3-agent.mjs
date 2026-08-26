// S3: one bounded, read-only Agent Ask through the current agent.chat route.
//
// Credential availability is detected through the product path, not an
// operator assertion or a secret-bearing environment dump. The scenario first
// renders the Agent surface, reviews the context for one Ask-mode prompt, and
// submits that prompt. A precise missing-credential / unavailable-credential-
// store outcome becomes an auditable SKIP with the terminal status and bounded,
// redacted product error. Authentication rejection, quota, network, endpoint,
// model, and other product errors stay failures. A usable credential therefore
// exercises one real restricted turn; an absent credential never becomes a
// fabricated pass.
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
const MODE_BUTTONS = `${AGENT_SURFACE} .rho-agent-mode button`;
const COMPOSER = `${AGENT_SURFACE} .rho-agent-composer textarea`;
const REVIEW_BUTTON = `${AGENT_SURFACE} .rho-agent-context-controls button:first-child`;
const SEND_BUTTON = `${AGENT_SURFACE} .rho-agent-context-controls .rho-primary-action`;
const CONTEXT_PREVIEW = `${AGENT_SURFACE} .rho-agent-context-preview`;
const TURNS = `${AGENT_SURFACE} .rho-agent-turn`;
const ACTION_ERROR = ".rho-action-error";
const PROMPT = "Reply with exactly RHO_AGENT_OK. Do not call tools, run code, or modify files.";

async function queriedText(ctx, selector) {
  const records = await ctx.query(selector);
  return records[0]?.text?.trim() ?? "";
}

async function agentTurns(ctx) {
  const records = await ctx.query(TURNS, { all: true, attribute: "class" });
  return records.map((record) => ({ className: record.value ?? "", text: record.text ?? "" }));
}

function terminalTurns(turns) {
  return turns.filter((turn) => /rho-agent-turn-(completed|failed|cancelled)/.test(turn.className));
}

function turnIdentity(turn) {
  return `${turn.className}\u001f${turn.text}`;
}

function terminalStatus(turn) {
  const matched = turn.className.match(/rho-agent-turn-(completed|failed|cancelled)/);
  return matched?.[1] ?? "unknown";
}

function missingCredentialReason(message) {
  const text = String(message);
  const missing = [
    /credential was not received from the system credential store/i,
    /system credential store is unavailable/i,
    /provider credential is missing/i,
    /no api key is available/i,
    /api key (?:is )?(?:missing|not configured|not available|not detected)/i,
    /credential (?:is )?(?:missing|not configured|not available|not detected)/i,
  ].find((pattern) => pattern.test(text));
  return missing == null ? null : redactEvidence(text);
}

async function waitForRestrictedAsk(ctx, beforeTurnKeys, previousActionError) {
  return waitUntil("restricted Agent Ask terminal state", async () => {
    const actionError = await queriedText(ctx, ACTION_ERROR);
    if (actionError && actionError !== previousActionError) {
      return { kind: "submission_error", message: actionError };
    }
    const turns = terminalTurns(await agentTurns(ctx));
    const terminal = turns.find((turn) => !beforeTurnKeys.has(turnIdentity(turn)));
    return terminal == null ? null : { kind: "terminal", terminal };
  }, { timeoutMs: 300_000, intervalMs: 1_000 });
}

async function runCredentialDetection(ctx) {
  const beforeTurnKeys = new Set(terminalTurns(await agentTurns(ctx)).map(turnIdentity));
  const previousActionError = await queriedText(ctx, ACTION_ERROR);

  await ctx.act({ kind: "type", selector: COMPOSER, text: PROMPT });
  await waitUntil("Agent context review enabled", async () => {
    const matches = await ctx.query(REVIEW_BUTTON, { attribute: "disabled" });
    return matches.length > 0 && matches[0].value == null ? true : null;
  }, { timeoutMs: 60_000 });
  await ctx.act({ kind: "click", selector: REVIEW_BUTTON });

  const context = await waitUntil("Agent context preview", async () => {
    const preview = await queriedText(ctx, CONTEXT_PREVIEW);
    if (preview) return { preview };
    const actionError = await queriedText(ctx, ACTION_ERROR);
    if (actionError && actionError !== previousActionError) return { error: actionError };
    return null;
  }, { timeoutMs: 60_000 });
  if (context.error) {
    const missing = missingCredentialReason(context.error);
    if (missing != null) {
      return {
        credential_state: "not_available",
        evidence_source: "current agent.chat context resolution",
        terminal_status: "not_started",
        product_error: missing,
      };
    }
    throw new AssertionFailure(`Agent context review failed: ${redactEvidence(context.error)}`);
  }

  await waitUntil("Agent send enabled", async () => {
    const matches = await ctx.query(SEND_BUTTON, { attribute: "disabled" });
    return matches.length > 0 && matches[0].value == null ? true : null;
  }, { timeoutMs: 60_000 });
  await ctx.act({ kind: "click", selector: SEND_BUTTON });

  const outcome = await waitForRestrictedAsk(ctx, beforeTurnKeys, previousActionError);
  if (outcome.kind === "submission_error") {
    const missing = missingCredentialReason(outcome.message);
    if (missing != null) {
      return {
        credential_state: "not_available",
        evidence_source: "current agent.chat turn admission",
        terminal_status: "not_started",
        context_preview: truncate(context.preview, 300),
        product_error: missing,
      };
    }
    throw new AssertionFailure(`Agent Ask submission failed: ${redactEvidence(outcome.message)}`);
  }

  const status = terminalStatus(outcome.terminal);
  if (status === "completed") {
    const answers = await ctx.query(`${AGENT_SURFACE} .rho-agent-answer`, { all: true });
    const finalAnswer = answers.map((answer) => answer.text?.trim() ?? "").filter(Boolean).at(-1) ?? "";
    if (!finalAnswer) {
      throw new AssertionFailure("restricted Agent Ask completed but rendered no final answer");
    }
    return {
      credential_state: "usable",
      evidence_source: "completed restricted Ask on current agent.chat route",
      terminal_status: status,
      context_preview: truncate(context.preview, 300),
      terminal_text: truncate(outcome.terminal.text, 500),
      final_answer: truncate(finalAnswer, 500),
    };
  }
  const missing = missingCredentialReason(outcome.terminal.text);
  if (missing != null) {
    return {
      credential_state: "not_available",
      evidence_source: "current agent.chat terminal turn",
      terminal_status: status,
      context_preview: truncate(context.preview, 300),
      product_error: missing,
    };
  }
  throw new AssertionFailure(
    `restricted Agent Ask ended ${status}: ${redactEvidence(outcome.terminal.text)}`,
  );
}

export default async function s3(ctx) {
  await ctx.gate("s3", "agent-surface", async () => {
    const ready = await openProject(ctx, ctx.fixtures.workingProject);
    await openSurface(ctx, "rho.agent");
    const isolation = await isolateSurface(ctx, "rho.agent");
    const snapshot = isolation.snapshot;
    assertEqual(snapshot.kernel?.agent_health, "ready", "Agent runtime health");
    const buttons = await waitUntil("Agent mode controls", async () => {
      const found = await ctx.query(MODE_BUTTONS, { all: true, attribute: "aria-pressed" });
      const labels = found.map((button) => (button.text ?? "").trim().toLowerCase());
      return ["ask", "plan", "act"].every((mode) => labels.includes(mode)) ? found : null;
    }, { timeoutMs: 20_000 });
    const composer = await ctx.query(COMPOSER);
    if (composer.length === 0) {
      throw new AssertionFailure(`Agent composer not found via ${COMPOSER}`);
    }
    const ask = buttons.find((button) => (button.text ?? "").trim().toLowerCase() === "ask");
    if (ask?.value !== "true") {
      await ctx.act({ kind: "click", selector: `${MODE_BUTTONS}:first-child` });
    }
    await waitUntil("Ask mode selected", async () => {
      const found = await ctx.query(MODE_BUTTONS, { all: true, attribute: "aria-pressed" });
      const current = found.find((button) => (button.text ?? "").trim().toLowerCase() === "ask");
      return current?.value === "true" ? true : null;
    }, { timeoutMs: 10_000 });
    const hint = await queriedText(ctx, `${AGENT_SURFACE} .rho-agent-mode-hint`);
    return {
      projectPath: ready.projectPath,
      agentHealth: snapshot.kernel?.agent_health,
      modes: buttons.map((button) => (button.text ?? "").trim().toLowerCase()),
      askSelected: true,
      modeHint: hint,
      composerPresent: true,
      closedPlacements: isolation.closed,
      retainedPlacements: isolation.retained,
      mountedSurfaceIds: isolation.mountedIds,
    };
  }, {
    screenshot: "s3-agent-surface",
    criteria: [
      "Ask/Plan/Act 模式控件均可见，Ask 的选中态明确，模式提示文案可读",
      "独立 Agent 组件充分使用工作区；时间线、composer、Review context 与 Send 控件边界清楚，无重叠或裁切",
      "空会话状态（若展示）与当前 working-project 上下文一致，页面无凭据或密钥文本泄漏",
      "画面只保留 Agent placement，未残留 Navigator、Console、Environment 等默认三栏组件，且没有页级横向滚动条",
    ],
  });

  let detection = null;
  await ctx.gate("s3", "agent-credential-detection", async () => {
    detection = await runCredentialDetection(ctx);
    return {
      ...detection,
      detection_contract: "one Ask-mode prompt; no tools, code execution, file mutation, credential value, or ambient environment inspection",
    };
  });

  if (detection?.credential_state !== "usable") {
    const reason = [
      "current agent.chat credential is not available",
      `source=${detection?.evidence_source ?? "unknown"}`,
      `terminal=${detection?.terminal_status ?? "unknown"}`,
      `evidence=${detection?.product_error ?? "no credential evidence returned"}`,
    ].join("; ");
    ctx.skipGate("s3", "agent-ask-turn", reason);
    return;
  }

  await ctx.gate("s3", "agent-ask-turn", async () => {
    assertEqual(detection.terminal_status, "completed", "restricted Agent turn status");
    if (!detection.final_answer?.trim()) {
      throw new AssertionFailure("restricted Agent turn has no rendered final answer");
    }
    if (!detection.final_answer.includes("RHO_AGENT_OK")) {
      throw new AssertionFailure(
        `restricted Agent answer did not contain RHO_AGENT_OK: ${redactEvidence(detection.final_answer)}`,
      );
    }
    const proposals = await ctx.query(`${AGENT_SURFACE} .rho-agent-file-proposal`, { all: true });
    const approvals = await ctx.query(`${AGENT_SURFACE} .rho-agent-approval`, { all: true });
    assertEqual(proposals.length, 0, "restricted Agent file proposals");
    assertEqual(approvals.length, 0, "restricted Agent approval requests");
    return {
      prompt: PROMPT,
      outcome: detection.terminal_status,
      answer: truncate(detection.final_answer, 300),
      fileProposalCount: proposals.length,
      approvalCount: approvals.length,
    };
  }, {
    screenshot: "s3-agent-ask-turn",
    criteria: [
      "Ask 模式仍有明确选中态，完成的 turn 与 composer 分区清楚",
      "turn 的最终回答完整显示 RHO_AGENT_OK，且未显示 failed/cancelled 状态或错误文案",
      "该只读 Ask 没有文件修改提案、审批卡片或运行中指示器",
      "模型元信息在 Details 区域内不挤压正文，时间线与 composer 无重叠或裁切",
    ],
  });
}
