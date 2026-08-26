import { useEffect, useId, useState } from "react";

import type { CheckEvidence, CheckResult } from "../../../transport/check";
import type { ArtifactRecordSummary, RunSummary } from "../../../transport/history";
import type { VerificationAdapter } from "./verification-adapter";
import {
  artifactStudioTarget,
  checkNeedsCoverageWarning,
  evidenceStudioTarget,
  plotStudioTarget,
  runNeedsAttention,
  verificationFocusKey,
  type VerificationCheckRecord,
  type VerificationExactReference,
  type VerificationFocus,
  type VerificationLayout,
  type VerificationSnapshot,
  type VerificationSourceProjection,
  type VerificationStudioTarget,
} from "./verification-model";

type PaneLoadState =
  | { readonly status: "idle"; readonly requestKey: null }
  | { readonly status: "loading"; readonly requestKey: string }
  | { readonly status: "ready"; readonly requestKey: string; readonly snapshot: VerificationSnapshot }
  | { readonly status: "failed"; readonly requestKey: string };

export interface VerificationPaneProps {
  readonly focus: VerificationFocus | null;
  readonly adapter: VerificationAdapter;
  readonly layout?: VerificationLayout;
  readonly onOpenStudio: (target: VerificationStudioTarget) => Promise<void>;
  readonly className?: string;
}

function referenceLabel(references: readonly VerificationExactReference[]): string {
  return references[0]?.label ?? "未命名引用";
}

function sourceFailureCopy(source: VerificationSourceProjection<unknown>): string {
  return source.failure?.code === "contract-mismatch"
    ? "返回的记录与精确引用不一致，已停止展示该部分。"
    : "暂时无法读取这部分记录；其他已加载内容仍可查阅。";
}

function SourceFailure({
  source,
  onRetry,
}: {
  readonly source: VerificationSourceProjection<unknown>;
  readonly onRetry: () => void;
}) {
  if (source.status !== "failed") return null;
  return (
    <div className="rho-vibe-verification-source-failure" role="alert">
      <p>{sourceFailureCopy(source)}</p>
      <button type="button" onClick={onRetry}>重新读取</button>
    </div>
  );
}

function UnresolvedReferences({
  references,
}: {
  readonly references: readonly VerificationExactReference[];
}) {
  if (references.length === 0) return null;
  return (
    <div className="rho-vibe-verification-unresolved" role="status">
      <strong>引用尚未解析</strong>
      <ul>
        {references.map((reference, index) => (
          <li key={`${reference.kind}:${reference.id}:${index}`}>{reference.label}</li>
        ))}
      </ul>
      <p>没有改用最近记录或相似名称进行替代。</p>
    </div>
  );
}

function artifactTone(artifact: ArtifactRecordSummary): "normal" | "warning" {
  return artifact.provenance_complete ? "normal" : "warning";
}

function runTone(run: RunSummary): "normal" | "busy" | "warning" | "error" {
  if (run.status === "completed") return "normal";
  if (run.status === "running" || run.status === "queued" || run.status === "waiting") {
    return "busy";
  }
  if (run.status === "failed") return "error";
  return "warning";
}

function runStatusLabel(status: string): string {
  switch (status) {
    case "completed": return "执行已结束";
    case "running": return "正在执行";
    case "queued": return "等待执行";
    case "waiting": return "等待外部条件";
    case "failed": return "执行失败";
    case "cancelled": return "执行已取消";
    case "interrupted": return "执行已中断";
    default: return `执行状态：${status}`;
  }
}

function checkStatusLabel(result: CheckResult): string {
  switch (result.status) {
    case "clean": return "项目检查未发现问题";
    case "findings": return "项目检查有待处理项";
    case "incomplete": return "项目检查覆盖不完整";
    case "failed": return "项目检查失败";
  }
}

function checkEvidenceLabel(evidence: CheckEvidence): string {
  switch (evidence.kind) {
    case "source_range":
      return `${evidence.path}:${evidence.line}${evidence.column == null ? "" : `:${evidence.column}`}`;
    case "project_file":
      return evidence.path;
    case "run_ref":
      return "关联执行记录";
    case "environment_ref":
      return "关联环境快照";
    case "note":
      return evidence.text;
  }
}

function uniqueLimitations(result: CheckResult): readonly string[] {
  return [...new Set([
    ...result.limitations,
    ...result.snapshot.limitations,
    ...result.findings.flatMap((finding) => finding.limitations),
  ])];
}

function StudioAction({
  target,
  opening,
  onOpen,
}: {
  readonly target: VerificationStudioTarget;
  readonly opening: boolean;
  readonly onOpen: (target: VerificationStudioTarget) => void;
}) {
  return (
    <button
      type="button"
      className="rho-vibe-verification-studio-action"
      aria-busy={opening || undefined}
      onClick={() => onOpen(target)}
    >
      {opening ? "正在打开 Studio…" : "在 Studio 中查看"}
    </button>
  );
}

function CandidateOutputs({
  snapshot,
  openingTarget,
  onOpen,
  onRetry,
}: {
  readonly snapshot: VerificationSnapshot;
  readonly openingTarget: string | null;
  readonly onOpen: (target: VerificationStudioTarget) => void;
  readonly onRetry: () => void;
}) {
  const visible = snapshot.artifacts.status !== "unlinked"
    || snapshot.plots.status !== "unlinked";
  if (!visible) return null;
  return (
    <section className="rho-vibe-verification-section rho-vibe-verification-candidates" aria-labelledby="rho-vibe-verification-candidates-heading">
      <h3 id="rho-vibe-verification-candidates-heading">候选产物</h3>
      <p className="rho-vibe-verification-scope-note">图表与文件是待查验的输出，不是验证结论。</p>
      <SourceFailure source={snapshot.artifacts} onRetry={onRetry} />
      <SourceFailure source={snapshot.plots} onRetry={onRetry} />
      <UnresolvedReferences references={snapshot.artifacts.unresolved} />
      <UnresolvedReferences references={snapshot.plots.unresolved} />
      <div className="rho-vibe-verification-records">
        {snapshot.artifacts.items.map(({ record, references }) => {
          const target = artifactStudioTarget(record);
          const targetKey = `${target.kind}:${target.id}`;
          return (
            <article
              className="rho-vibe-verification-record rho-vibe-verification-artifact"
              data-tone={artifactTone(record)}
              key={record.artifact_id}
            >
              <header>
                <strong>{referenceLabel(references)}</strong>
                <span>{record.artifact_kind}</span>
              </header>
              <p className="rho-vibe-verification-path">{record.output_path}</p>
              {record.provenance_complete
                ? <p className="rho-vibe-verification-boundary">谱系字段已记录；这不表示产物内容有效。</p>
                : (
                    <p className="rho-vibe-verification-warning" role="status">
                      谱系信息不完整：{record.incomplete_reason ?? "记录未提供具体原因。"}
                    </p>
                  )}
              <details>
                <summary>产物记录</summary>
                <dl>
                  <div><dt>媒体类型</dt><dd>{record.media_type}</dd></div>
                  <div><dt>创建时间</dt><dd>{record.created_at}</dd></div>
                </dl>
              </details>
              <StudioAction target={target} opening={openingTarget === targetKey} onOpen={onOpen} />
            </article>
          );
        })}
        {snapshot.plots.items.map((item) => {
          const { record, references, preview } = item;
          const target = isNonEmptyRunId(record.run_id) ? plotStudioTarget(record) : null;
          const targetKey = target == null ? null : `${target.kind}:${target.id}`;
          const label = referenceLabel(references);
          return (
            <article
              className="rho-vibe-verification-record rho-vibe-verification-plot"
              data-tone={record.provenance_complete && preview.status === "ready" ? "normal" : "warning"}
              key={record.plot_id}
            >
              <header><strong>{label}</strong><span>图形产物</span></header>
              {preview.status === "ready"
                ? (
                    <img
                      className="rho-vibe-verification-plot-preview"
                      src={`data:${preview.view.media_type};base64,${preview.view.data_base64}`}
                      alt={`${label}的候选图形预览`}
                      loading="lazy"
                    />
                  )
                : (
                    <div className="rho-vibe-verification-preview-failure" role="status">
                      <p>{preview.status === "stale" ? "项目变化后预览已失效。" : "图形记录存在，但预览不可用或格式不匹配。"}</p>
                      <button type="button" onClick={onRetry}>重试预览</button>
                    </div>
                  )}
              {record.provenance_complete
                ? <p className="rho-vibe-verification-boundary">谱系字段已记录；图形仍只是候选输出。</p>
                : <p className="rho-vibe-verification-warning" role="status">图形谱系信息不完整。</p>}
              {target != null && targetKey != null && (
                <StudioAction target={target} opening={openingTarget === targetKey} onOpen={onOpen} />
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function isNonEmptyRunId(runId: string): boolean {
  return runId.trim().length > 0;
}

function ExecutionRecords({
  snapshot,
  openingTarget,
  onOpen,
  onRetry,
}: {
  readonly snapshot: VerificationSnapshot;
  readonly openingTarget: string | null;
  readonly onOpen: (target: VerificationStudioTarget) => void;
  readonly onRetry: () => void;
}) {
  if (snapshot.runs.status === "unlinked") return null;
  return (
    <section className="rho-vibe-verification-section rho-vibe-verification-runs" aria-labelledby="rho-vibe-verification-runs-heading">
      <h3 id="rho-vibe-verification-runs-heading">执行记录</h3>
      <p className="rho-vibe-verification-scope-note">这里只陈述运行状态；执行结束不代表科学判断成立。</p>
      <SourceFailure source={snapshot.runs} onRetry={onRetry} />
      <UnresolvedReferences references={snapshot.runs.unresolved} />
      <div className="rho-vibe-verification-records">
        {snapshot.runs.items.map(({ record, references }) => {
          const target: VerificationStudioTarget = { kind: "run", id: record.run_id };
          const targetKey = `${target.kind}:${target.id}`;
          return (
            <article
              className="rho-vibe-verification-record rho-vibe-verification-run"
              data-tone={runTone(record)}
              key={record.run_id}
            >
              <header>
                <strong>{referenceLabel(references)}</strong>
                <span>{runStatusLabel(record.status)}</span>
              </header>
              {record.source_path != null && <p className="rho-vibe-verification-path">{record.source_path}</p>}
              {runNeedsAttention(record) && record.error_message != null && (
                <p className="rho-vibe-verification-warning" role="status">{record.error_message}</p>
              )}
              <p className="rho-vibe-verification-boundary">
                {record.status === "completed"
                  ? "该记录只确认执行过程已经结束。"
                  : "该执行尚不能作为稳定产物的依据。"}
              </p>
              <StudioAction target={target} opening={openingTarget === targetKey} onOpen={onOpen} />
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CheckRecord({
  item,
  openingTarget,
  onOpen,
}: {
  readonly item: VerificationCheckRecord;
  readonly openingTarget: string | null;
  readonly onOpen: (target: VerificationStudioTarget) => void;
}) {
  const label = referenceLabel(item.references);
  if (item.status !== "ready") {
    return (
      <article className="rho-vibe-verification-record rho-vibe-verification-check" data-tone="warning">
        <header><strong>{label}</strong><span>检查记录不可用</span></header>
        <p role="alert">{item.status === "stale" ? "项目已变化，需要重新确认该检查。" : "当前进程无法读取这条项目检查。"}</p>
      </article>
    );
  }
  const { result } = item;
  const limitations = uniqueLimitations(result);
  const target: VerificationStudioTarget = { kind: "check", id: result.result_id };
  const targetKey = `${target.kind}:${target.id}`;
  return (
    <article
      className="rho-vibe-verification-record rho-vibe-verification-check"
      data-tone={checkNeedsCoverageWarning(result) || result.findings.length > 0 ? "warning" : "normal"}
    >
      <header><strong>{label}</strong><span>{checkStatusLabel(result)}</span></header>
      <p className="rho-vibe-verification-boundary">
        这是当前进程中的项目规则检查，不判断科学解释是否成立，也不是持久化结论。
      </p>
      {checkNeedsCoverageWarning(result) && (
        <div className="rho-vibe-verification-warning" role="status">
          <strong>检查覆盖有限</strong>
          <p>跳过 {result.coverage.files_skipped} 个文件；规则包失败 {result.coverage.plugin_rule_failures} 个。</p>
        </div>
      )}
      {limitations.length > 0 && (
        <details open className="rho-vibe-verification-limitations">
          <summary>限制</summary>
          <ul>{limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        </details>
      )}
      {result.findings.length > 0 && (
        <div className="rho-vibe-verification-findings">
          <h4>项目检查项</h4>
          {result.findings.map((finding, index) => (
            <article key={`${finding.rule_id}:${index}`} data-severity={finding.severity}>
              <header><strong>{finding.title}</strong><span>{finding.severity}</span></header>
              <p>{finding.summary}</p>
              <p><strong>下一步：</strong>{finding.remediation}</p>
              {finding.evidence.length > 0 && (
                <ul>{finding.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex}>{checkEvidenceLabel(evidence)}</li>)}</ul>
              )}
            </article>
          ))}
        </div>
      )}
      {result.findings.length === 0 && (
        <p>在这次捕获的项目修订中，已执行规则没有报告问题。</p>
      )}
      <StudioAction target={target} opening={openingTarget === targetKey} onOpen={onOpen} />
    </article>
  );
}

function ProjectChecks({
  snapshot,
  openingTarget,
  onOpen,
  onRetry,
}: {
  readonly snapshot: VerificationSnapshot;
  readonly openingTarget: string | null;
  readonly onOpen: (target: VerificationStudioTarget) => void;
  readonly onRetry: () => void;
}) {
  if (snapshot.checks.status === "unlinked") return null;
  return (
    <section className="rho-vibe-verification-section rho-vibe-verification-checks" aria-labelledby="rho-vibe-verification-checks-heading">
      <h3 id="rho-vibe-verification-checks-heading">项目检查</h3>
      <SourceFailure source={snapshot.checks} onRetry={onRetry} />
      <UnresolvedReferences references={snapshot.checks.unresolved} />
      <div className="rho-vibe-verification-records">
        {snapshot.checks.items.map((item, index) => (
          <CheckRecord
            item={item}
            openingTarget={openingTarget}
            onOpen={onOpen}
            key={`${referenceLabel(item.references)}:${index}`}
          />
        ))}
      </div>
    </section>
  );
}

function EvidenceLinks({
  snapshot,
  openingTarget,
  onOpen,
  onRetry,
}: {
  readonly snapshot: VerificationSnapshot;
  readonly openingTarget: string | null;
  readonly onOpen: (target: VerificationStudioTarget) => void;
  readonly onRetry: () => void;
}) {
  if (snapshot.evidence.status === "unlinked") return null;
  return (
    <section className="rho-vibe-verification-section rho-vibe-verification-evidence" aria-labelledby="rho-vibe-verification-evidence-heading">
      <h3 id="rho-vibe-verification-evidence-heading">证据链接与边界</h3>
      <p className="rho-vibe-verification-scope-note">链接状态只描述结构是否可审计，不说明语义上支持某个结论。</p>
      <SourceFailure source={snapshot.evidence} onRetry={onRetry} />
      <UnresolvedReferences references={snapshot.evidence.unresolved} />
      <div className="rho-vibe-verification-records">
        {snapshot.evidence.items.map(({ record, references }) => {
          const target = evidenceStudioTarget(record);
          const targetKey = target == null ? null : `${target.kind}:${target.id}`;
          return (
            <article
              className="rho-vibe-verification-record rho-vibe-verification-evidence-record"
              data-tone={record.linked_evidence_ids.length === 0 ? "warning" : "normal"}
              key={record.claim_id}
            >
              <header><strong>{referenceLabel(references)}</strong><span>结构化证据记录</span></header>
              <p>{record.summary}</p>
              {record.source_path != null && (
                <p className="rho-vibe-verification-path">
                  {record.source_path}{record.start_line == null ? "" : `:${record.start_line}`}
                </p>
              )}
              {record.linked_evidence_ids.length === 0
                ? <p className="rho-vibe-verification-warning" role="status">尚未建立可审计的证据链接。</p>
                : <p className="rho-vibe-verification-boundary">已记录 {record.linked_evidence_ids.length} 个结构化链接；这不等于语义支持。</p>}
              {target != null && targetKey != null && (
                <StudioAction target={target} opening={openingTarget === targetKey} onOpen={onOpen} />
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function WorkingBoundary() {
  return (
    <section className="rho-vibe-verification-section rho-vibe-verification-working-boundary" aria-labelledby="rho-vibe-verification-boundary-heading" data-state="draft">
      <h3 id="rho-vibe-verification-boundary-heading">当前还不能声称什么</h3>
      <p>
        当前记录可以帮助核对执行、产物、项目规则与结构化链接，但 Rho 尚未建立可持久化的科学决定状态。
        手稿中的解释仍是工作解释。
      </p>
    </section>
  );
}

export function VerificationPane({
  focus,
  adapter,
  layout = "overview",
  onOpenStudio,
  className = "",
}: VerificationPaneProps) {
  const headingId = useId();
  const [refresh, setRefresh] = useState(0);
  const [loadState, setLoadState] = useState<PaneLoadState>({ status: "idle", requestKey: null });
  const [openingTarget, setOpeningTarget] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const focusKey = focus == null ? null : verificationFocusKey(focus);
  const requestKey = focusKey == null ? null : `${focusKey}:${refresh}`;

  useEffect(() => adapter.subscribe(() => setRefresh((value) => value + 1)), [adapter]);

  useEffect(() => {
    if (focus == null || focusKey == null || requestKey == null) {
      setLoadState({ status: "idle", requestKey: null });
      return;
    }
    let current = true;
    setOpeningTarget(null);
    setOpenFailed(false);
    setLoadState({ status: "loading", requestKey });
    void adapter.load(focus).then((snapshot) => {
      if (!current || snapshot.focusKey !== focusKey) return;
      setLoadState({ status: "ready", requestKey, snapshot });
    }).catch(() => {
      if (!current) return;
      setLoadState({ status: "failed", requestKey });
    });
    return () => { current = false; };
  }, [adapter, focusKey, requestKey]);

  const retry = () => setRefresh((value) => value + 1);
  const open = (target: VerificationStudioTarget) => {
    if (openingTarget != null) return;
    const targetKey = `${target.kind}:${target.id}`;
    setOpeningTarget(targetKey);
    setOpenFailed(false);
    void onOpenStudio(target).then(() => {
      setOpeningTarget(null);
    }).catch(() => {
      setOpeningTarget(null);
      setOpenFailed(true);
    });
  };

  const currentState = loadState.requestKey === requestKey ? loadState : null;
  const rootClassName = ["rho-vibe-verification", className].filter(Boolean).join(" ");

  return (
    <section
      className={rootClassName}
      data-layout={layout}
      aria-labelledby={headingId}
    >
      <header className="rho-vibe-verification-header">
        <div>
          <h2 id={headingId}>查验与结论</h2>
          <p>只汇集当前手稿位置明确引用的记录。</p>
        </div>
        {openingTarget != null && <span role="status">正在切换到 Studio…</span>}
      </header>
      {openFailed && (
        <div className="rho-vibe-verification-open-failure" role="alert">
          未能打开精确目标；Vibe 中的当前查验位置保持不变。
        </div>
      )}
      {focus == null && (
        <div className="rho-vibe-verification-empty" role="status">
          <strong>选择手稿中的方法、结果或结论</strong>
          <p>这里会显示与该位置精确关联的产物、执行记录、项目检查和证据链接。</p>
        </div>
      )}
      {focus != null && (currentState == null || currentState.status === "loading") && (
        <div className="rho-vibe-verification-loading" role="status" aria-busy="true">
          正在读取精确引用…
        </div>
      )}
      {focus != null && currentState?.status === "failed" && (
        <div className="rho-vibe-verification-failed" role="alert">
          <strong>查验记录暂时不可用</strong>
          <p>没有使用其他项目或最近记录进行替代。</p>
          <button type="button" onClick={retry}>重新读取</button>
        </div>
      )}
      {focus != null && currentState?.status === "ready" && currentState.snapshot.stale && (
        <div className="rho-vibe-verification-stale" role="alert">
          <strong>项目记录已变化</strong>
          <p>当前证据尚未在新的项目修订中重新确认，旧内容已停止展示。</p>
          <button type="button" onClick={retry}>读取当前修订</button>
        </div>
      )}
      {focus != null && currentState?.status === "ready" && !currentState.snapshot.stale && (
        <>
          {focus.references.length === 0 && (
            <div className="rho-vibe-verification-unlinked" role="status">
              <strong>当前手稿位置尚无精确关联</strong>
              <p>不会把同一项目中的最近执行或相似名称产物自动归到这里。</p>
            </div>
          )}
          <UnresolvedReferences references={currentState.snapshot.invalidReferences} />
          <CandidateOutputs
            snapshot={currentState.snapshot}
            openingTarget={openingTarget}
            onOpen={open}
            onRetry={retry}
          />
          <ExecutionRecords
            snapshot={currentState.snapshot}
            openingTarget={openingTarget}
            onOpen={open}
            onRetry={retry}
          />
          <ProjectChecks
            snapshot={currentState.snapshot}
            openingTarget={openingTarget}
            onOpen={open}
            onRetry={retry}
          />
          <EvidenceLinks
            snapshot={currentState.snapshot}
            openingTarget={openingTarget}
            onOpen={open}
            onRetry={retry}
          />
          <WorkingBoundary />
        </>
      )}
    </section>
  );
}
