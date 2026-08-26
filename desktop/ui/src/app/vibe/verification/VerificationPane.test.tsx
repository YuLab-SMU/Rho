import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VerificationPane, type VerificationPaneProps } from "./VerificationPane";
import type { VerificationAdapter } from "./verification-adapter";
import type { VerificationSnapshot } from "./verification-model";
import {
  makeArtifact,
  makeCheck,
  makeEvidence,
  makeFocus,
  makePlot,
  makePlotView,
  makeReference,
  makeRun,
  makeSnapshot,
  source,
} from "./verification-test-fixtures";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function staticAdapter(snapshot: VerificationSnapshot): VerificationAdapter {
  return {
    load: async () => snapshot,
    subscribe: () => () => undefined,
  };
}

async function renderPane(props: VerificationPaneProps): Promise<{
  readonly host: HTMLDivElement;
  readonly root: Root;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(<VerificationPane {...props} />); });
  return { host, root };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function exactReferences() {
  return {
    run: makeReference("run", "run-18", "Cluster contrast execution"),
    artifact: makeReference(
      "artifact",
      "artifact-differential-expression",
      "Differential-expression table",
    ),
    plot: makeReference("plot", "plot-donor-consistency", "Donor consistency plot"),
    check: makeReference("check", "check-result-7", "Project check for the contrast"),
    evidence: makeReference("evidence", "claim-cluster-identity", "Cluster identity evidence link"),
  };
}

function completeProjection() {
  const references = exactReferences();
  const focus = makeFocus(Object.values(references));
  const snapshot = makeSnapshot(focus, {
    runs: source([{ record: makeRun(), references: [references.run] }]),
    artifacts: source([{
      record: makeArtifact({
        provenance_complete: false,
        incomplete_reason: "The environment snapshot was not retained.",
      }),
      references: [references.artifact],
    }]),
    plots: source([{
      record: makePlot(),
      references: [references.plot],
      preview: { status: "ready", view: makePlotView() },
    }]),
    checks: source([{
      status: "ready",
      result: makeCheck(),
      references: [references.check],
    }]),
    evidence: source([{
      record: makeEvidence(),
      references: [references.evidence],
    }]),
  });
  return { focus, snapshot, references };
}

describe("Vibe verification region", () => {
  it("renders an honest empty state before a manuscript focus exists", async () => {
    const focus = makeFocus([]);
    const { host } = await renderPane({
      focus: null,
      adapter: staticAdapter(makeSnapshot(focus)),
      onOpenStudio: async () => undefined,
    });

    expect(host.querySelector("section")?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(host.textContent).toContain("选择手稿中的方法、结果或结论");
    expect(host.textContent).not.toContain("候选产物");
  });

  it("marks pending exact-reference reads busy without retaining old content", async () => {
    const focus = makeFocus([makeReference("artifact", "artifact-a", "DE table")]);
    const pending = deferred<VerificationSnapshot>();
    const adapter: VerificationAdapter = {
      load: () => pending.promise,
      subscribe: () => () => undefined,
    };
    const { host } = await renderPane({
      focus,
      adapter,
      onOpenStudio: async () => undefined,
    });

    expect(host.querySelector("[aria-busy='true']")?.textContent).toContain("正在读取精确引用");
    await act(async () => { pending.resolve(makeSnapshot(focus)); });
  });

  it("renders exact outputs and mandatory scientific-meaning boundaries", async () => {
    const { focus, snapshot } = completeProjection();
    const { host } = await renderPane({
      focus,
      adapter: staticAdapter(snapshot),
      onOpenStudio: async () => undefined,
    });
    const copy = host.textContent ?? "";

    expect(copy).toContain("候选产物");
    expect(copy).toContain("outputs/cluster-3-vs-7/differential-expression.csv");
    expect(copy).toContain("谱系信息不完整");
    expect(copy).toContain("执行结束不代表科学判断成立");
    expect(copy).toContain("项目检查未发现问题");
    expect(copy).toContain("不说明语义上支持某个结论");
    expect(copy).toContain("当前还不能声称什么");
    expect(copy).not.toContain("结论已验证");
    expect(copy).not.toContain("支持该结论");
    expect(copy).not.toContain("artifact-differential-expression");
    expect(copy).not.toContain("check-result-7");
    expect(host.querySelector<HTMLImageElement>("img")?.alt).toBe(
      "Donor consistency plot的候选图形预览",
    );
    const actionCopy = [...host.querySelectorAll("button")].map((button) => button.textContent).join(" ");
    expect(actionCopy).not.toMatch(/accept|qualify|reject|接受|限定|拒绝/i);
  });

  it("isolates a failed evidence source while retaining resolved candidate output", async () => {
    const artifactReference = makeReference(
      "artifact",
      "artifact-differential-expression",
      "DE table",
    );
    const evidenceReference = makeReference(
      "evidence",
      "claim-cluster-identity",
      "Evidence link",
    );
    const focus = makeFocus([artifactReference, evidenceReference]);
    const snapshot = makeSnapshot(focus, {
      artifacts: source([{ record: makeArtifact(), references: [artifactReference] }]),
      evidence: {
        status: "failed",
        items: [],
        unresolved: [evidenceReference],
        failure: { code: "unavailable" },
      },
    });
    const { host } = await renderPane({
      focus,
      adapter: staticAdapter(snapshot),
      onOpenStudio: async () => undefined,
    });

    expect(host.textContent).toContain("differential-expression.csv");
    expect(host.querySelector("[role='alert']")?.textContent).toContain("暂时无法读取这部分记录");
  });

  it("shows operational, coverage and link-health warnings without scientific promotion", async () => {
    const runReference = makeReference("run", "run-18", "Failed contrast execution");
    const checkReference = makeReference("check", "check-result-7", "Incomplete project check");
    const evidenceReference = makeReference("evidence", "claim-cluster-identity", "Unlinked evidence record");
    const focus = makeFocus([runReference, checkReference, evidenceReference]);
    const snapshot = makeSnapshot(focus, {
      runs: source([{
        record: makeRun({ status: "failed", error_message: "The model matrix was singular." }),
        references: [runReference],
      }]),
      checks: source([{
        status: "ready",
        result: makeCheck({
          status: "incomplete",
          coverage: {
            files_scanned: 7,
            files_skipped: 1,
            core_rules: 12,
            plugin_rule_packs: 1,
            plugin_rule_failures: 1,
          },
          limitations: ["One generated file was outside the snapshot budget."],
        }),
        references: [checkReference],
      }]),
      evidence: source([{
        record: makeEvidence({ linked_evidence_ids: [] }),
        references: [evidenceReference],
      }]),
    });
    const { host } = await renderPane({
      focus,
      adapter: staticAdapter(snapshot),
      onOpenStudio: async () => undefined,
    });

    expect(host.querySelector(".rho-vibe-verification-run")?.getAttribute("data-tone")).toBe("error");
    expect(host.textContent).toContain("The model matrix was singular.");
    expect(host.textContent).toContain("检查覆盖有限");
    expect(host.textContent).toContain("One generated file was outside the snapshot budget.");
    expect(host.textContent).toContain("尚未建立可审计的证据链接");
    expect(host.textContent).not.toContain("结论已验证");
  });

  it("does not echo an unknown backend Run status into the Vibe correspondence", async () => {
    const runReference = makeReference("run", "run-18", "Run with a future status");
    const focus = makeFocus([runReference]);
    const snapshot = makeSnapshot(focus, {
      runs: source([{
        record: makeRun({ status: "vendor_internal_state" }),
        references: [runReference],
      }]),
    });
    const { host } = await renderPane({
      focus,
      adapter: staticAdapter(snapshot),
      onOpenStudio: async () => undefined,
    });

    expect(host.textContent).toContain("执行状态未知");
    expect(host.textContent).not.toContain("vendor_internal_state");
  });

  it("hides formerly loaded records when the project revision is stale", async () => {
    const artifactReference = makeReference(
      "artifact",
      "artifact-differential-expression",
      "DE table",
    );
    const focus = makeFocus([artifactReference]);
    const snapshot = makeSnapshot(focus, {
      artifacts: source([{ record: makeArtifact(), references: [artifactReference] }]),
      stale: true,
    });
    const { host } = await renderPane({
      focus,
      adapter: staticAdapter(snapshot),
      onOpenStudio: async () => undefined,
    });

    expect(host.textContent).toContain("项目记录已变化");
    expect(host.textContent).not.toContain("differential-expression.csv");
  });

  it("discards a late response after project and epoch change", async () => {
    const firstFocus = makeFocus(
      [makeReference("artifact", "artifact-first", "First project table")],
      { projectId: "/projects/first", epoch: 1 },
    );
    const secondFocus = makeFocus(
      [makeReference("artifact", "artifact-second", "Second project table")],
      { projectId: "/projects/second", epoch: 2 },
    );
    const first = deferred<VerificationSnapshot>();
    const second = deferred<VerificationSnapshot>();
    const adapter: VerificationAdapter = {
      load: (focus) => focus.projectId === firstFocus.projectId ? first.promise : second.promise,
      subscribe: () => () => undefined,
    };
    const onOpenStudio = async () => undefined;
    const { host, root } = await renderPane({ focus: firstFocus, adapter, onOpenStudio });
    await act(async () => {
      root.render(<VerificationPane focus={secondFocus} adapter={adapter} onOpenStudio={onOpenStudio} />);
    });
    const firstReference = firstFocus.references[0]!;
    first.resolve(makeSnapshot(firstFocus, {
      artifacts: source([{
        record: makeArtifact({
          artifact_id: "artifact-first",
          project_root: "/projects/first",
          output_path: "outputs/first-project.csv",
        }),
        references: [firstReference],
      }]),
    }));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain("first-project.csv");
    expect(host.textContent).toContain("正在读取精确引用");

    const secondReference = secondFocus.references[0]!;
    await act(async () => {
      second.resolve(makeSnapshot(secondFocus, {
        artifacts: source([{
          record: makeArtifact({
            artifact_id: "artifact-second",
            project_root: "/projects/second",
            output_path: "outputs/second-project.csv",
          }),
          references: [secondReference],
        }]),
      }));
    });
    expect(host.textContent).toContain("second-project.csv");
  });

  it("keeps semantic DOM order in the narrow presentation", async () => {
    const { focus, snapshot } = completeProjection();
    const { host } = await renderPane({
      focus,
      adapter: staticAdapter(snapshot),
      layout: "narrow",
      onOpenStudio: async () => undefined,
    });

    expect(host.querySelector(".rho-vibe-verification")?.getAttribute("data-layout")).toBe("narrow");
    expect([...host.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "候选产物",
      "执行记录",
      "项目检查",
      "证据链接与边界",
      "当前还不能声称什么",
    ]);
  });

  it("uses native keyboard-focusable buttons and emits the exact Studio target", async () => {
    const reference = makeReference(
      "artifact",
      "artifact-differential-expression",
      "DE table",
    );
    const focus = makeFocus([reference]);
    const snapshot = makeSnapshot(focus, {
      artifacts: source([{ record: makeArtifact(), references: [reference] }]),
    });
    const onOpenStudio = vi.fn(async () => undefined);
    const { host } = await renderPane({ focus, adapter: staticAdapter(snapshot), onOpenStudio });
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "在 Studio 中查看")!;
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.tagName).toBe("BUTTON");
    await act(async () => { button.click(); });

    expect(onOpenStudio).toHaveBeenCalledWith({
      kind: "artifact",
      id: "artifact-differential-expression",
    });
    expect(document.activeElement).toBe(button);
  });

  it("reports a failed Studio transition without moving focus", async () => {
    const reference = makeReference("run", "run-18", "Contrast execution");
    const focus = makeFocus([reference]);
    const snapshot = makeSnapshot(focus, {
      runs: source([{ record: makeRun(), references: [reference] }]),
    });
    const { host } = await renderPane({
      focus,
      adapter: staticAdapter(snapshot),
      onOpenStudio: async () => { throw new Error("Studio transition failed"); },
    });
    const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "在 Studio 中查看")!;
    button.focus();
    await act(async () => { button.click(); });

    expect(host.querySelector(".rho-vibe-verification-open-failure")?.getAttribute("role")).toBe("alert");
    expect(host.textContent).toContain("Vibe 中的当前查验位置保持不变");
    expect(document.activeElement).toBe(button);
  });

  it("offers a retry when a validated Plot record has no usable preview", async () => {
    const reference = makeReference("plot", "plot-donor-consistency", "Donor consistency plot");
    const focus = makeFocus([reference]);
    const snapshot = makeSnapshot(focus, {
      plots: source([{
        record: makePlot(),
        references: [reference],
        preview: { status: "failed", reason: "media-mismatch" },
      }]),
    });
    const load = vi.fn(async () => snapshot);
    const adapter: VerificationAdapter = { load, subscribe: () => () => undefined };
    const { host } = await renderPane({
      focus,
      adapter,
      onOpenStudio: async () => undefined,
    });
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "重试预览")!;
    await act(async () => { retry.click(); });

    expect(load).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("预览不可用或格式不匹配");
  });
});
