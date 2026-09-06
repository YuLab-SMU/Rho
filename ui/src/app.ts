import type { HostRequest } from "./generated/HostRequest";
import type { SessionReply } from "./generated/SessionReply";
import type { WorkbenchInfo } from "./generated/WorkbenchInfo";
import type { WorkbenchFrame } from "./generated/WorkbenchFrame";
import type { SelectProject } from "./generated/SelectProject";
import type { CapabilityDescriptor } from "./generated/CapabilityDescriptor";
import type { Invocation } from "./generated/Invocation";
import type { Precondition } from "./generated/Precondition";
import type { OperationRecord } from "./generated/OperationRecord";
import type { QuerySnapshot } from "./generated/QuerySnapshot";
import type { OutboxRecord } from "./generated/OutboxRecord";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing client element: ${id}`);
  return element as T;
}
function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string"
    ? value
    : value == null
      ? "—"
      : JSON.stringify(value);
}
function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
function display(id: string, value: unknown): void {
  const element = el(id);
  const content = text(value);
  if (element.textContent !== content) element.textContent = content;
}
function notice(value: unknown): void {
  el("notice").hidden = !value;
  display("notice", value instanceof Error ? value.message : value);
}
function handle(action: () => Promise<unknown>): void {
  void action().catch(notice);
}
function button(id: string, action: () => Promise<unknown>): void {
  el(id).addEventListener("click", () => handle(action));
}

const fragment = new URLSearchParams(location.hash.slice(1)).get("token");
if (fragment) sessionStorage.setItem("rho.local.token", fragment);
history.replaceState(null, "", location.pathname);
const token = fragment ?? sessionStorage.getItem("rho.local.token");
let info: WorkbenchInfo = {
  project_root: null,
  runtime: "unknown",
  capabilities: [],
};
let epoch = 0;
let session: string | null = null;
let cursor = 0;
let polling = false;
let selectedOperation: string | null = null;
let consoleOperation: string | null = null;
let renderedOperations = "";
const records = new Map<string, OperationRecord>();
let pending: { project: string; invocation: Invocation } | null = null;
try {
  pending = JSON.parse(sessionStorage.getItem("rho.pending") ?? "null");
  if (
    pending &&
    (typeof pending.project !== "string" ||
      typeof pending.invocation?.client_request_id !== "string" ||
      typeof pending.invocation.capability?.id !== "string")
  )
    throw new Error("invalid pending request");
} catch {
  pending = null;
  sessionStorage.removeItem("rho.pending");
}

async function http<T>(path: string, body?: unknown): Promise<T> {
  if (!token)
    throw new Error(
      "缺少本机访问凭证。请使用启动命令给出的完整私有 URL 打开工作台。",
    );
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    display("connection", "连接中断 · 状态未知");
    throw new Error(
      "连接中断。已接受的操作可能仍在执行；不要用新请求 ID 重复执行同一动作。",
    );
  }
  const raw = await response.text();
  let result: unknown;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`Host 返回 ${response.status}：${raw.slice(0, 500)}`);
  }
  if (!response.ok)
    throw new Error(text(obj(result).error ?? `Host 返回 ${response.status}`));
  display("connection", "本机已连接");
  return result as T;
}

async function rpc<T>(request: HostRequest): Promise<T> {
  if (!info.project_root) throw new Error("请先选择项目。");
  const frame: WorkbenchFrame = {
    project_root: info.project_root,
    frame: { id: crypto.randomUUID(), request },
  };
  const reply = await http<SessionReply>("/api/host", frame);
  if (!reply.ok)
    throw new Error(reply.error ?? "Host 未返回成功回执；请检查操作记录。");
  if (reply.id !== frame.frame.id) throw new Error("Host 回执关联不匹配。");
  return reply.result as T;
}

function capability(id: string): CapabilityDescriptor | undefined {
  return info.capabilities.find((c) => c.capability.id === id);
}
function query(
  id: string,
  args: Invocation["arguments"] = {},
): Promise<QuerySnapshot> {
  const descriptor = capability(id);
  if (!descriptor || descriptor.kind !== "query")
    throw new Error(`当前 Host 未注册查询 ${id}`);
  return rpc({
    method: "query_snapshot",
    params: { capability: descriptor.capability, arguments: args },
  });
}
function observationLabel(snapshot: QuerySnapshot): string {
  return `${snapshot.status} · ${snapshot.completeness} · ${new Date(snapshot.observed_at_ms).toLocaleTimeString()} · ${snapshot.source}`;
}
function updateControls(): void {
  el<HTMLButtonElement>("run-code").disabled =
    !capability("workspace.run_r") || pending !== null || session === null;
  el<HTMLButtonElement>("invoke-capability").disabled =
    !info.project_root || pending !== null;
  el("pending-request").hidden = pending === null;
  if (pending)
    display(
      "pending-label",
      `未确认请求 ${pending.invocation.client_request_id} · ${pending.invocation.capability.id}。重发会保留原请求 ID，不创建新的动作。`,
    );
}
function setPending(value: typeof pending): void {
  pending = value;
  if (value) sessionStorage.setItem("rho.pending", JSON.stringify(value));
  else sessionStorage.removeItem("rho.pending");
  updateControls();
}

async function refreshInfo(): Promise<void> {
  const next = await http<WorkbenchInfo>("/api/info");
  // A poll is not a UI change. Preserve open selectors and accessibility focus
  // when the Host's project/runtime/registry description has not changed.
  if (JSON.stringify(next) === JSON.stringify(info)) return;
  if (next.project_root !== info.project_root) {
    epoch += 1;
    session = null;
    cursor = 0;
    records.clear();
    selectedOperation = null;
    consoleOperation = null;
    display("console-output", "新项目会话。执行后显示真实 R 输出。");
    display("console-state", "等待执行");
    display("object-detail", "选择一个对象以读取有界预览。");
    display("operation-detail", "选择一条操作。");
    display("capability-result", "");
    el("operation-actions").replaceChildren();
    el("objects").replaceChildren();
    display("workspace-meta", "尚无当前项目的运行时观察");
    display("environment-meta", "尚无当前项目的环境观察");
    el("environment-summary").replaceChildren();
    display("environment-detail", "");
    renderOperations();
  }
  info = next;
  display(
    "project-title",
    next.project_root?.split(/[\\/]/).filter(Boolean).at(-1) ??
      "打开一个科学项目",
  );
  display(
    "project-path",
    next.project_root ?? "选择本机目录，连接真实运行环境。",
  );
  display(
    "runtime-status",
    next.runtime === "ark" ? "Ark / R" : "未启用交互式 R",
  );
  display("mcp-address", `同一 Host 的 MCP：${location.origin}/mcp`);
  const select = el<HTMLSelectElement>("capability");
  const previous = select.value;
  select.replaceChildren(
    ...next.capabilities.map((c) => {
      const option = document.createElement("option");
      option.value = c.capability.id;
      option.textContent = `${c.capability.id}@${c.capability.version} · ${c.kind}`;
      return option;
    }),
  );
  if (capability(previous)) select.value = previous;
  renderCapability();
  updateControls();
}

async function refreshWorkspace(): Promise<void> {
  if (!capability("workspace.snapshot")) {
    display(
      "workspace-meta",
      "当前 Host 未启用交互式 R。使用 --ark 和 --r-home 启动可连接真实会话。",
    );
    return;
  }
  const current = epoch;
  const snapshot = await query("workspace.snapshot", { limit: 100 });
  if (current !== epoch) return;
  session = snapshot.target.identity;
  display("workspace-meta", observationLabel(snapshot));
  display(
    "runtime-status",
    snapshot.status === "ready"
      ? "Ark / R · 可观察"
      : `Ark / R · ${snapshot.status}`,
  );
  updateControls();
  const list = el("objects");
  list.replaceChildren();
  if (!snapshot.data) {
    display(
      "object-detail",
      snapshot.notices.join("\n") || "当前没有可用观察；未推断对象状态。",
    );
    return;
  }
  const data = obj(snapshot.data);
  const objects = Array.isArray(data.objects) ? data.objects : [];
  for (const value of objects) {
    const binding = obj(value);
    const row = document.createElement("button");
    row.className = "object-row";
    const name = document.createElement("code");
    name.textContent = text(binding.name);
    const meta = document.createElement("span");
    meta.textContent = `${text(binding.object_type ?? binding.kind)} · ${text(binding.length)}`;
    row.append(name, meta);
    row.addEventListener("click", () =>
      handle(async () => {
        const preview = await query("workspace.inspect_object", {
          name: text(binding.name),
          max_items: 20,
          expected_session: session,
        });
        if (current === epoch) {
          display("object-detail", pretty(preview));
          el("object-detail").closest("details")!.open = true;
        }
      }),
    );
    list.append(row);
  }
  const count = document.createElement("p");
  count.className = "hint";
  count.textContent = `${objects.length} / ${text(data.total_bindings)} 个绑定${data.truncated ? " · 已截断" : ""}`;
  list.append(count);
}

async function refreshEnvironment(): Promise<void> {
  if (!capability("environment.observe")) {
    display(
      "environment-meta",
      "当前 Host 未启用环境工具。可使用 --rscript 或 --ark 启动。",
    );
    return;
  }
  const current = epoch;
  const snapshot = await query("environment.observe", { limit: 100 });
  if (current !== epoch) return;
  display("environment-meta", observationLabel(snapshot));
  display("environment-detail", pretty(snapshot));
  const data = obj(snapshot.data);
  const summary = document.createElement("dl");
  if (!snapshot.data) {
    display(
      "environment-summary",
      snapshot.notices.join("\n") || "当前没有可用观察；没有推断环境状态。",
    );
    return;
  }
  for (const [label, value] of [
    ["R", data.r_version],
    ["平台", data.platform],
    ["绑定包库", data.active_workspace_library ?? "未显式绑定隔离库"],
  ]) {
    const term = document.createElement("dt");
    term.textContent = text(label);
    const detail = document.createElement("dd");
    detail.textContent = text(value);
    summary.append(term, detail);
  }
  el("environment-summary").replaceChildren(summary);
}

function renderOperations(): void {
  const list = el("operation-list");
  const visible = [...records.values()]
    .sort((a, b) => b.operation.accepted_at_ms - a.operation.accepted_at_ms)
    .slice(0, 200);
  // Results are immutable after their terminal outcome. These native record
  // fields identify changes to the rendered list/detail without copying output
  // payloads or replacing focused controls on every empty event page.
  const signature = JSON.stringify(visible.map((record) => [
    record.operation.operation_id,
    record.updated_at_ms,
    record.status,
    record.cancellation_requested,
  ]));
  if (signature === renderedOperations) return;
  renderedOperations = signature;
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "尚未读取到操作。刷新面板本身不会创建 Operation。";
    list.append(empty);
  }
  for (const record of visible) {
    const row = document.createElement("button");
    row.className = "operation-row";
    const label = document.createElement("span");
    label.textContent = record.operation.capability.id;
    const meta = document.createElement("small");
    meta.textContent = `  ${record.operation.caller.kind} · ${new Date(record.operation.accepted_at_ms).toLocaleTimeString()} · ${record.operation.operation_id.slice(0, 12)}`;
    label.append(meta);
    const status = document.createElement("span");
    status.className = "status";
    status.dataset.status = record.status;
    status.textContent = record.status;
    row.append(label, status);
    row.addEventListener("click", () =>
      showOperation(record.operation.operation_id),
    );
    list.append(row);
  }
  if (selectedOperation) showOperation(selectedOperation, false);
}

function showOperation(id: string, open = true): void {
  const record = records.get(id);
  if (!record) return;
  selectedOperation = id;
  display("operation-detail", pretty(record));
  el<HTMLDetailsElement>("operation-detail-panel").open ||= open;
  const actions = el("operation-actions");
  actions.replaceChildren();
  if (record.outcome === null) {
    const cancel = document.createElement("button");
    cancel.className = "secondary";
    cancel.textContent = record.cancellation_requested
      ? "已请求取消 · 再次查询"
      : "请求取消";
    cancel.addEventListener("click", () =>
      handle(async () => {
        await rpc({
          method: "request_cancellation",
          params: { operation_id: id },
        });
        notice(
          `已收到取消请求回执 · ${id}。请以操作后续终态为准。`,
        );
        await loadOperation(id);
        renderOperations();
      }),
    );
    actions.append(cancel);
  }
}

async function loadOperation(id: string): Promise<void> {
  const current = epoch;
  const record = await rpc<OperationRecord | null>({
    method: "get_operation",
    params: { operation_id: id },
  });
  if (current !== epoch || !record) return;
  // This journal can contain more than one project. The view is not an owner.
  if (
    record.operation.idempotency_scope &&
    record.operation.idempotency_scope !== info.project_root
  )
    return;
  records.set(id, record);
  if (
    id === consoleOperation ||
    (pending?.invocation.capability.id === "workspace.run_r" &&
      record.operation.caller.kind === "human" &&
      record.operation.client_request_id ===
        pending.invocation.client_request_id)
  )
    renderConsole(record);
}

async function pollEvents(): Promise<void> {
  if (polling || !info.project_root) return;
  polling = true;
  const current = epoch;
  try {
    const events = await rpc<OutboxRecord[]>({
      method: "subscribe",
      params: { after_sequence: cursor, limit: 100 },
    });
    if (current !== epoch) return;
    let previous = cursor;
    for (const event of events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous)
        throw new Error("事件游标超出安全整数范围或顺序异常；停止消费。");
      previous = event.sequence;
    }
    const completed = new Set(
      [...records.values()]
        .filter((r) => r.outcome !== null)
        .map((r) => r.operation.operation_id),
    );
    const ids = new Set(events.map((e) => e.operation_id));
    for (const record of records.values())
      if (record.outcome === null) ids.add(record.operation.operation_id);
    for (const id of ids) await loadOperation(id);
    if (current !== epoch) return;
    if (events.length) cursor = events.at(-1)!.sequence;
    // The page cursor advances only after all results were read successfully.
    if (records.size > 300) {
      const old = [...records.values()]
        .filter(
          (r) =>
            r.outcome !== null &&
            r.operation.operation_id !== selectedOperation,
        )
        .sort((a, b) => a.updated_at_ms - b.updated_at_ms);
      for (const record of old.slice(0, records.size - 300))
        records.delete(record.operation.operation_id);
    }
    display(
      "events-meta",
      `持久化事件游标 ${cursor} · 当前显示最多 200 项${events.length === 100 ? " · 历史尚未读完" : " · 已读取到当前页末尾"}`,
    );
    renderOperations();
    if (
      [...records.values()].some(
        (r) => r.outcome !== null && !completed.has(r.operation.operation_id),
      )
    ) {
      await refreshWorkspace();
      await refreshEnvironment();
    }
  } finally {
    polling = false;
  }
}

function renderConsole(record: OperationRecord): void {
  consoleOperation = record.operation.operation_id;
  display(
    "console-state",
    `${record.status} · ${record.operation.operation_id}`,
  );
  const output = obj(record.output);
  const parts = [
    output.stdout,
    output.stderr,
    output.conditions && pretty(output.conditions),
    output.value === undefined ? undefined : pretty(output.value),
    record.error,
    record.recovery && `恢复材料\n${pretty(record.recovery)}`,
  ].filter(
    (value) =>
      value !== undefined && value !== null && value !== "" && value !== "[]",
  );
  display("console-output", parts.map(text).join("\n") || pretty(record));
}

async function executePending(): Promise<void> {
  if (!pending) return;
  if (pending.project !== info.project_root)
    throw new Error(
      "未确认请求属于另一项目；请先切回该项目，或仅关闭本地重试提示。",
    );
  const current = epoch;
  const submitted = pending;
  el<HTMLButtonElement>("retry-request").disabled = true;
  display(
    submitted.invocation.capability.id === "workspace.run_r"
      ? "console-state"
      : "capability-result",
    "等待 Host 回执 · 不推断执行结果",
  );
  try {
    const record = await rpc<OperationRecord>({
      method: "invoke",
      params: submitted.invocation,
    });
    if (pending === submitted) setPending(null);
    if (current !== epoch) return;
    records.set(record.operation.operation_id, record);
    renderOperations();
    if (record.operation.capability.id === "workspace.run_r")
      renderConsole(record);
    else display("capability-result", pretty(record));
    await refreshWorkspace();
    await refreshEnvironment();
    await pollEvents();
  } finally {
    el<HTMLButtonElement>("retry-request").disabled = false;
  }
}

async function invoke(
  descriptor: CapabilityDescriptor,
  arguments_: Invocation["arguments"],
  preconditions: Precondition[],
): Promise<void> {
  if (pending) throw new Error("先核对未确认请求，或关闭其本地重试提示。");
  if (!info.project_root) throw new Error("请选择项目。");
  setPending({
    project: info.project_root,
    invocation: {
      client_request_id: crypto.randomUUID(),
      capability: descriptor.capability,
      arguments: arguments_,
      preconditions,
    },
  });
  await executePending();
}

function renderCapability(): void {
  const descriptor = capability(el<HTMLSelectElement>("capability").value);
  display(
    "capability-kind",
    descriptor
      ? `${descriptor.kind} · retry: ${descriptor.retry} · ${descriptor.potential_effects.join(", ") || "无声明效果"}`
      : "当前没有能力",
  );
  display(
    "capability-schema",
    descriptor
      ? pretty(descriptor.input_schema)
      : "选择项目后显示真实 Registry。",
  );
}

async function runCode(): Promise<void> {
  const descriptor = capability("workspace.run_r");
  if (!descriptor || !session)
    throw new Error("当前没有可用的 R session 观察。");
  const code = el<HTMLTextAreaElement>("code").value;
  if (!code.trim()) throw new Error("请输入 R 代码。");
  notice("");
  await invoke(descriptor, { code }, [
    { kind: "workspace.session", subject: "active", expected: session },
  ]);
}

button("run-code", runCode);
button("refresh-workspace", refreshWorkspace);
button("refresh-environment", refreshEnvironment);
button("load-events", pollEvents);
button("retry-request", executePending);
button("dismiss-request", async () => {
  setPending(null);
  notice(
    "仅清除了本地重试提示，没有取消或撤销任何执行。请在 Operations 中核对真实结果。",
  );
});
button("choose-project", async () => {
  el<HTMLInputElement>("project-input").value = info.project_root ?? "";
  el<HTMLDialogElement>("project-dialog").showModal();
});
button("close-project-dialog", async () =>
  el<HTMLDialogElement>("project-dialog").close(),
);
el<HTMLSelectElement>("capability").addEventListener(
  "change",
  renderCapability,
);
button("invoke-capability", async () => {
  const descriptor = capability(el<HTMLSelectElement>("capability").value);
  if (!descriptor) throw new Error("选择一个已注册能力。");
  const args: Invocation["arguments"] = JSON.parse(
    el<HTMLTextAreaElement>("arguments").value,
  );
  if (descriptor.kind === "query")
    display(
      "capability-result",
      pretty(await query(descriptor.capability.id, args)),
    );
  else
    await invoke(
      descriptor,
      args,
      JSON.parse(el<HTMLTextAreaElement>("preconditions").value),
    );
});
el("code").addEventListener("keydown", (event) => {
  if (
    event instanceof KeyboardEvent &&
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey)
  ) {
    event.preventDefault();
    handle(runCode);
  }
});
el("project-form").addEventListener("submit", (event) => {
  event.preventDefault();
  handle(async () => {
    el<HTMLButtonElement>("open-project").disabled = true;
    try {
      const request: SelectProject = {
        project_root: el<HTMLInputElement>("project-input").value.trim(),
      };
      await http<WorkbenchInfo>("/api/project", request);
      el<HTMLDialogElement>("project-dialog").close();
      notice("");
    } finally {
      await refreshInfo();
      el<HTMLButtonElement>("open-project").disabled = false;
    }
    await refreshWorkspace();
    await refreshEnvironment();
    await pollEvents();
  });
});

async function start(): Promise<void> {
  updateControls();
  await refreshInfo();
  if (!info.project_root) el<HTMLDialogElement>("project-dialog").showModal();
  else {
    await refreshWorkspace();
    await refreshEnvironment();
    await pollEvents();
  }
  // One sequential poll; no overlapping fetches or automatic command retries.
  async function tick(): Promise<void> {
    try {
      if (!document.hidden) {
        await refreshInfo();
        await pollEvents();
      }
    } catch (error) {
      notice(error);
    } finally {
      window.setTimeout(() => void tick(), 1500);
    }
  }
  window.setTimeout(() => void tick(), 1500);
}
handle(start);
