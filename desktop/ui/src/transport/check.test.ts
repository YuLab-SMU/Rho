import { describe, expect, it } from "vitest";

import {
  createTauriCheckTransport,
  type CheckResult,
  type CheckTransport,
} from "./check";
import type { CheckResultV1 } from "./generated/check";
import { createMockUiKernelTransport } from "./mock";

function cleanResult(): CheckResultV1 {
  return {
    contract: "rho.ui.check-result.v1",
    result_id: "check-result:fixture",
    project_id: "project:fixture",
    project_revision: 7,
    snapshot: {
      contract: "rho.ui.check-project.snapshot.v1",
      snapshot_id: "check-snapshot:fixture",
      project_id: "project:fixture",
      project_revision: 7,
      captured_at: "2026-08-25T00:00:00Z",
      files: [],
      source_bytes: 0,
      renv_lock_sha256: null,
      truncated: false,
      limitations: [],
    },
    ruleset_digest: "a".repeat(64),
    generated_at: "2026-08-25T00:00:01Z",
    status: "clean",
    findings: [],
    coverage: {
      files_scanned: 0,
      files_skipped: 0,
      core_rules: 22,
      plugin_rule_packs: 0,
      plugin_rule_failures: 0,
    },
    truncated: false,
    limitations: [],
  };
}

describe("Check generated transport", () => {
  it("owns the exact run and result commands", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const result = cleanResult();
    const transport = createTauriCheckTransport(
      async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push(args === undefined ? { command } : { command, args });
        return (command === "check_project_run" ? { result } : result) as T;
      },
    );
    const runRequest = {
      project_id: result.project_id,
      expected_project_revision: result.project_revision,
    };
    const resultRequest = { ...runRequest, result_id: result.result_id };

    await expect(transport.runCheckProject(runRequest)).resolves.toStrictEqual({ result });
    await expect(transport.loadCheckResult(resultRequest)).resolves.toStrictEqual(result);
    expect(calls).toEqual([
      { command: "check_project_run", args: { request: runRequest } },
      { command: "check_result", args: { request: resultRequest } },
    ]);
  });

  it("fails closed on unsupported result or nested snapshot identity", async () => {
    const result = cleanResult();
    const wrongResult = { ...result, contract: "rho.ui.check-result.v2" };
    const wrongSnapshot = {
      ...result,
      snapshot: { ...result.snapshot, contract: "rho.ui.check-project.snapshot.v2" },
    };
    await expect(
      createTauriCheckTransport(async <T,>() => wrongResult as T).loadCheckResult({
        project_id: result.project_id,
        expected_project_revision: result.project_revision,
        result_id: result.result_id,
      }),
    ).rejects.toThrow("Unsupported Check result contract");
    await expect(
      createTauriCheckTransport(async <T,>() => wrongSnapshot as T).loadCheckResult({
        project_id: result.project_id,
        expected_project_revision: result.project_revision,
        result_id: result.result_id,
      }),
    ).rejects.toThrow("Unsupported Check snapshot contract");
  });

  it("keeps the browser mock assignable to the narrow generated facet", async () => {
    const mock = createMockUiKernelTransport();
    const transport: CheckTransport = mock;
    const snapshot = await mock.loadSnapshot();
    const response = await transport.runCheckProject({
      project_id: snapshot.project.project_id,
      expected_project_revision: snapshot.context.project_revision,
    });
    const result: CheckResult = await transport.loadCheckResult({
      project_id: snapshot.project.project_id,
      expected_project_revision: snapshot.context.project_revision,
      result_id: response.result.result_id,
    });
    expect(result).toMatchObject({
      contract: "rho.ui.check-result.v1",
      project_id: snapshot.project.project_id,
      project_revision: snapshot.context.project_revision,
    });
  });
});
