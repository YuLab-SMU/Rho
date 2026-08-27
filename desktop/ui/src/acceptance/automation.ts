import type {
  RuntimeExecution,
  RuntimeExecutionStartResponse,
  RuntimeExecuteRequest,
  RuntimeOutputPage,
  WorkbenchStoreSnapshot,
} from "../transport";
import type { Unsubscribe } from "../transport/types";
import { runtimeOutputChunkBlock } from "../app/runtime-output-presentation";

// Acceptance automation surface for the debug-only visual acceptance bridge
// (docs/plans/active-2026-08-26-visual-acceptance-automation-spec.md). The
// bridge forwards `rho://acceptance-eval` payloads whose `js` field is a JSON
// encoded AutomationRequest — never executable source. This module interprets
// a fixed command vocabulary only; the page CSP forbids eval and none is used.

export type AutomationWaitUntil = {
  readonly kernel_idle?: boolean;
  readonly no_active_executions?: boolean;
  readonly selector?: string;
  readonly text?: string;
};

export type AutomationAction =
  | { readonly kind: "open_project"; readonly path: string }
  | { readonly kind: "console_submit"; readonly code: string; readonly timeout_ms?: number }
  | { readonly kind: "open_surface"; readonly surface_id: string }
  | { readonly kind: "focus_instance"; readonly instance_id: string }
  | { readonly kind: "close_instance"; readonly instance_id: string }
  | { readonly kind: "set_mode"; readonly mode: "studio" | "vibe" }
  | { readonly kind: "click"; readonly selector: string }
  | { readonly kind: "type"; readonly selector: string; readonly text: string }
  | { readonly kind: "key"; readonly key: string; readonly selector?: string }
  | { readonly kind: "wait"; readonly until: AutomationWaitUntil; readonly timeout_ms?: number };

export type AutomationRequest =
  | { readonly command: "ready" }
  | { readonly command: "snapshot" }
  | { readonly command: "act"; readonly action: AutomationAction }
  | {
      readonly command: "query";
      readonly selector: string;
      readonly all?: boolean;
      readonly attribute?: string;
      readonly geometry?: boolean;
    };

export class AutomationRequestError extends Error {}

export interface AutomationStore {
  getSnapshot(): WorkbenchStoreSnapshot;
  subscribe(listener: () => void): Unsubscribe;
  settled(): Promise<void>;
  startExecution(request: RuntimeExecuteRequest): Promise<RuntimeExecutionStartResponse>;
  getExecution(executionId: string): Promise<RuntimeExecution>;
  listExecutions(limit?: number): Promise<readonly RuntimeExecution[]>;
  outputPage(executionId: string, afterSequence?: number): Promise<RuntimeOutputPage>;
  refresh(): Promise<void>;
}

export interface AutomationActions {
  openProject(path: string): Promise<void>;
  openSurface(surfaceId: string): Promise<void>;
  focusInstance(instanceId: string): Promise<void>;
  closeInstance(instanceId: string): Promise<void>;
  setMode(mode: "studio" | "vibe"): Promise<void>;
}

export type AutomationEvidence = Readonly<Record<string, unknown>>;

export interface AutomationHost {
  readonly store: AutomationStore;
  readonly actions: AutomationActions;
  getEvidence(): AutomationEvidence;
}

export interface AutomationReadyValue {
  readonly rsrReady: boolean;
  readonly kernelStatus: string | null;
  readonly projectPath: string | null;
  readonly activeMode: string | null;
  readonly editorReady: boolean;
  readonly evidence: AutomationEvidence;
}

export interface AutomationSnapshotValue {
  readonly evidence: AutomationEvidence;
  readonly kernel: {
    readonly project_id: string;
    readonly workspace_health: string;
    readonly agent_health: string;
    readonly active_operations: number;
  } | null;
  readonly surfaces: readonly {
    readonly instance_id: string;
    readonly surface_id: string;
    readonly mode_id: string | null;
    readonly lifecycle_state: string;
  }[];
  readonly focusedInstance: string | null;
  readonly runtimes: readonly {
    readonly runtime_instance_id: string;
    readonly status: string;
  }[];
  readonly profile: {
    readonly active_mode: string;
    readonly revision: number;
  } | null;
  readonly project: {
    readonly project_id: string;
    readonly display_path: string;
  } | null;
  readonly visibleText: string;
  readonly activeElement: string | null;
  readonly counts: Readonly<Record<string, number>>;
}

export interface RhoAutomationSurface {
  request(raw: unknown): Promise<unknown>;
  snapshot(): AutomationSnapshotValue;
  ready(): AutomationReadyValue;
}

declare global {
  interface Window {
    __rhoAutomation?: RhoAutomationSurface;
  }
}

const QUERY_MAX_ITEMS = 50;
const QUERY_MAX_TEXT = 500;
const VISIBLE_TEXT_MAX = 8_000;
const PREVIEW_MAX_CHARS = 2_000;
const ERROR_MAX_CHARS = 512;
const POLL_INTERVAL_MS = 100;
const EXECUTION_POLL_INTERVAL_MS = 150;
const WAIT_DEFAULT_TIMEOUT_MS = 10_000;
const CONSOLE_SUBMIT_DEFAULT_TIMEOUT_MS = 60_000;
const OPEN_PROJECT_READY_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MAX_MS = 240_000;
const TERMINAL_EXECUTION_STATUSES: readonly string[] = ["completed", "failed", "interrupted"];
const ACTIVE_EXECUTION_STATUSES: readonly string[] = ["admitted", "running"];

export function automationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() ? message.slice(0, ERROR_MAX_CHARS) : "Automation request failed.";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalTimeout(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value <= 0 || value > ACTION_TIMEOUT_MAX_MS
  ) {
    throw new AutomationRequestError(
      `${label} must be an integer between 1 and ${ACTION_TIMEOUT_MAX_MS}ms.`,
    );
  }
  return value;
}

function parseWaitUntil(value: unknown): AutomationWaitUntil {
  if (!isRecord(value)) throw new AutomationRequestError("act.wait requires an until object.");
  const until: {
    kernel_idle?: boolean;
    no_active_executions?: boolean;
    selector?: string;
    text?: string;
  } = {};
  if (value.kernel_idle === true) until.kernel_idle = true;
  if (value.no_active_executions === true) until.no_active_executions = true;
  const selector = optionalString(value.selector);
  if (selector != null) until.selector = selector;
  const text = optionalString(value.text);
  if (text != null) until.text = text;
  if (
    until.kernel_idle !== true && until.no_active_executions !== true &&
    until.selector == null && until.text == null
  ) {
    throw new AutomationRequestError("act.wait until must name at least one condition.");
  }
  return until;
}

function parseAction(value: unknown): AutomationAction {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new AutomationRequestError("act requires an action object with a kind.");
  }
  switch (value.kind) {
    case "open_project": {
      if (typeof value.path !== "string" || !value.path.trim()) {
        throw new AutomationRequestError("act.open_project requires a non-empty path.");
      }
      return { kind: "open_project", path: value.path };
    }
    case "console_submit": {
      if (typeof value.code !== "string" || !value.code.trim()) {
        throw new AutomationRequestError("act.console_submit requires non-empty code.");
      }
      const timeout = optionalTimeout(value.timeout_ms, "act.console_submit timeout_ms");
      return {
        kind: "console_submit",
        code: value.code,
        ...(timeout == null ? {} : { timeout_ms: timeout }),
      };
    }
    case "open_surface": {
      if (typeof value.surface_id !== "string" || !value.surface_id.trim()) {
        throw new AutomationRequestError("act.open_surface requires a surface_id.");
      }
      return { kind: "open_surface", surface_id: value.surface_id };
    }
    case "focus_instance": {
      if (typeof value.instance_id !== "string" || !value.instance_id.trim()) {
        throw new AutomationRequestError("act.focus_instance requires an instance_id.");
      }
      return { kind: "focus_instance", instance_id: value.instance_id };
    }
    case "close_instance": {
      if (typeof value.instance_id !== "string" || !value.instance_id.trim()) {
        throw new AutomationRequestError("act.close_instance requires an instance_id.");
      }
      return { kind: "close_instance", instance_id: value.instance_id };
    }
    case "set_mode": {
      if (value.mode !== "studio" && value.mode !== "vibe") {
        throw new AutomationRequestError("act.set_mode requires mode \"studio\" or \"vibe\".");
      }
      return { kind: "set_mode", mode: value.mode };
    }
    case "click": {
      if (typeof value.selector !== "string" || !value.selector.trim()) {
        throw new AutomationRequestError("act.click requires a selector.");
      }
      return { kind: "click", selector: value.selector };
    }
    case "type": {
      if (typeof value.selector !== "string" || !value.selector.trim() || typeof value.text !== "string") {
        throw new AutomationRequestError("act.type requires a selector and text.");
      }
      return { kind: "type", selector: value.selector, text: value.text };
    }
    case "key": {
      if (typeof value.key !== "string" || !value.key) {
        throw new AutomationRequestError("act.key requires a key.");
      }
      const selector = optionalString(value.selector);
      return { kind: "key", key: value.key, ...(selector == null ? {} : { selector }) };
    }
    case "wait": {
      const timeout = optionalTimeout(value.timeout_ms, "act.wait timeout_ms");
      return {
        kind: "wait",
        until: parseWaitUntil(value.until),
        ...(timeout == null ? {} : { timeout_ms: timeout }),
      };
    }
    default:
      throw new AutomationRequestError(`Unknown act kind "${value.kind}".`);
  }
}

export function parseAutomationRequest(raw: unknown): AutomationRequest {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new AutomationRequestError("Automation request is not valid JSON.");
    }
  }
  if (!isRecord(value) || typeof value.command !== "string") {
    throw new AutomationRequestError("Automation request requires a command.");
  }
  switch (value.command) {
    case "ready":
      return { command: "ready" };
    case "snapshot":
      return { command: "snapshot" };
    case "act":
      return { command: "act", action: parseAction(value.action) };
    case "query": {
      if (typeof value.selector !== "string" || !value.selector.trim()) {
        throw new AutomationRequestError("query requires a selector.");
      }
      const attribute = optionalString(value.attribute);
      return {
        command: "query",
        selector: value.selector,
        ...(value.all === true ? { all: true } : {}),
        ...(attribute == null ? {} : { attribute }),
        ...(value.geometry === true ? { geometry: true } : {}),
      };
    }
    default:
      throw new AutomationRequestError(`Unknown automation command "${value.command}".`);
  }
}

function truncateText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeElement(element: Element | null): string | null {
  if (element == null) return null;
  let description = element.tagName.toLowerCase();
  if (element.id) description += `#${element.id}`;
  const label = element.getAttribute("aria-label");
  if (label) description += `[aria-label="${truncateText(label, 80)}"]`;
  return description;
}

export interface AutomationSurfaceOptions {
  readonly doc?: Document;
}

export function createAutomationSurface(
  host: AutomationHost,
  options: AutomationSurfaceOptions = {},
): RhoAutomationSurface {
  const doc = options.doc ?? document;

  function readySnapshot() {
    const state = host.store.getSnapshot();
    return state.status === "ready" ? state.snapshot : null;
  }

  function ready(): AutomationReadyValue {
    const projection = readySnapshot();
    const evidence = host.getEvidence();
    return {
      rsrReady: evidence.ready === true,
      kernelStatus: projection?.kernel.context.workspace_health ?? null,
      projectPath: projection?.kernel.project.display_path ?? null,
      activeMode: projection?.profile.profile.active_mode ?? null,
      editorReady: doc.querySelector("[data-editor-ready]")?.getAttribute("data-editor-ready") === "true",
      evidence,
    };
  }

  function snapshot(): AutomationSnapshotValue {
    const projection = readySnapshot();
    const visibleText = truncateText(
      (doc.body?.textContent ?? "").replaceAll(/\s+/g, " ").trim(),
      VISIBLE_TEXT_MAX,
    );
    return {
      evidence: host.getEvidence(),
      kernel: projection == null ? null : {
        project_id: projection.kernel.project.project_id,
        workspace_health: projection.kernel.context.workspace_health,
        agent_health: projection.kernel.context.agent_health,
        active_operations: projection.kernel.context.active_operations.length,
      },
      surfaces: projection?.surfaces.catalog.instances.map((instance) => ({
        instance_id: instance.instance_id,
        surface_id: instance.surface_id,
        mode_id: instance.mode_id,
        lifecycle_state: instance.lifecycle_state,
      })) ?? [],
      focusedInstance: projection?.studio.scene.focused_surface_instance_id ?? null,
      runtimes: projection?.runtimes.instances.map((runtime) => ({
        runtime_instance_id: runtime.runtime_instance_id,
        status: runtime.status,
      })) ?? [],
      profile: projection == null ? null : {
        active_mode: projection.profile.profile.active_mode,
        revision: projection.profile.profile.revision,
      },
      project: projection == null ? null : {
        project_id: projection.kernel.project.project_id,
        display_path: projection.kernel.project.display_path,
      },
      visibleText,
      activeElement: describeElement(doc.activeElement),
      counts: {
        surfaces: projection?.surfaces.catalog.instances.length ?? 0,
        runtimes: projection?.runtimes.instances.length ?? 0,
        resources: projection?.resources.resources.length ?? 0,
        active_operations: projection?.kernel.context.active_operations.length ?? 0,
      },
    };
  }

  function query(request: Extract<AutomationRequest, { readonly command: "query" }>) {
    const matches = [...doc.querySelectorAll(request.selector)];
    const bounded = (request.all === true ? matches : matches.slice(0, 1)).slice(0, QUERY_MAX_ITEMS);
    return bounded.map((element) => {
      const text = truncateText((element.textContent ?? "").trim(), QUERY_MAX_TEXT);
      const geometry = request.geometry === true
        ? (() => {
            const rect = element.getBoundingClientRect();
            const style = doc.defaultView?.getComputedStyle(element);
            return {
              client_width: element.clientWidth,
              client_height: element.clientHeight,
              scroll_width: element.scrollWidth,
              scroll_height: element.scrollHeight,
              computed: {
                display: style?.display ?? "",
                overflow_x: style?.overflowX ?? "",
                overflow_y: style?.overflowY ?? "",
                text_overflow: style?.textOverflow ?? "",
                white_space: style?.whiteSpace ?? "",
                overflow_wrap: style?.overflowWrap ?? "",
                word_break: style?.wordBreak ?? "",
              },
              rect: {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              },
            };
          })()
        : null;
      if (request.attribute != null) {
        return {
          text,
          value: element.getAttribute(request.attribute),
          ...(geometry == null ? {} : { geometry }),
        };
      }
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        return { text, value: element.value, ...(geometry == null ? {} : { geometry }) };
      }
      return { text, ...(geometry == null ? {} : { geometry }) };
    });
  }

  async function waitForCondition(
    until: AutomationWaitUntil,
    timeoutMs: number,
  ): Promise<{ readonly satisfied: true }> {
    const deadline = Date.now() + timeoutMs;
    const conditionsMet = async (): Promise<boolean> => {
      if (until.kernel_idle === true) {
        const projection = readySnapshot();
        if (projection == null || projection.kernel.context.active_operations.length > 0) return false;
      }
      if (until.no_active_executions === true) {
        // Executions are not part of the Workbench projection; poll the
        // transport-level execution list, the projection-equivalent signal
        // for "no active executions".
        const executions = await host.store.listExecutions(50);
        if (executions.some((execution) => ACTIVE_EXECUTION_STATUSES.includes(execution.status))) {
          return false;
        }
      }
      if (until.selector != null && doc.querySelector(until.selector) == null) return false;
      if (until.text != null && !(doc.body?.textContent ?? "").includes(until.text)) return false;
      return true;
    };
    return new Promise((resolve, reject) => {
      let done = false;
      let checking = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: Unsubscribe = () => undefined;
      const cleanup = () => {
        unsubscribe();
        if (timer != null) clearTimeout(timer);
      };
      const succeed = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ satisfied: true });
      };
      const fail = (cause: unknown) => {
        if (done) return;
        done = true;
        cleanup();
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      };
      const check = () => {
        if (done || checking) return;
        checking = true;
        void conditionsMet().then((met) => {
          checking = false;
          if (met) {
            succeed();
            return;
          }
          if (Date.now() >= deadline) {
            fail(new Error(`act.wait conditions were not met within ${timeoutMs}ms.`));
            return;
          }
          timer = setTimeout(check, POLL_INTERVAL_MS);
        }, (cause: unknown) => {
          checking = false;
          fail(cause);
        });
      };
      unsubscribe = host.store.subscribe(check);
      check();
    });
  }

  async function waitForReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const projection = readySnapshot();
      if (projection != null && host.getEvidence().ready === true) return;
      if (Date.now() >= deadline) {
        throw new Error(`The Workbench did not become ready within ${timeoutMs}ms.`);
      }
      await delay(POLL_INTERVAL_MS);
    }
  }

  async function outputPreview(executionId: string): Promise<string> {
    try {
      const page = await host.store.outputPage(executionId, 0);
      const text = page.chunks
        .map((chunk) => runtimeOutputChunkBlock(chunk).text)
        .join("\n")
        .trim();
      return truncateText(text, PREVIEW_MAX_CHARS);
    } catch {
      return "";
    }
  }

  async function consoleSubmit(code: string, timeoutMs: number) {
    await host.store.settled();
    const state = host.store.getSnapshot();
    if (state.status !== "ready") throw new Error("The Workbench is not ready.");
    const { surfaces, studio, runtimes } = state.snapshot;
    const consoles = surfaces.catalog.instances.filter(
      (instance) => instance.surface_id === "rho.console" && instance.runtime_binding != null,
    );
    const focusedId = studio.scene.focused_surface_instance_id;
    const target =
      consoles.find((instance) => instance.instance_id === focusedId) ??
      consoles.find((instance) => runtimes.instances.some((runtime) =>
        runtime.primary_scientific_runtime &&
        runtime.runtime_instance_id === instance.runtime_binding?.runtime_instance_id
      )) ??
      consoles[0];
    if (target?.runtime_binding == null) {
      throw new Error("No Console with an attached Runtime is open; open rho.console first.");
    }
    const binding = target.runtime_binding;
    const runtime = runtimes.instances.find((candidate) =>
      candidate.runtime_instance_id === binding.runtime_instance_id &&
      candidate.activation_generation === binding.activation_generation
    );
    if (runtime == null) throw new Error("The Console Runtime is no longer registered.");
    if (runtime.status !== "ready") {
      throw new Error(`The Console Runtime is ${runtime.status} and cannot run code.`);
    }
    const started = await host.store.startExecution({
      runtime: {
        project_id: runtime.project_id,
        runtime_provider_id: runtime.runtime_provider_id,
        runtime_instance_id: runtime.runtime_instance_id,
        activation_generation: runtime.activation_generation,
        expected_project_revision: runtimes.project_revision,
        expected_state_revision: runtime.state_revision,
      },
      console_instance_id: target.instance_id,
      expected_console_revision: target.surface_revision,
      code,
    });
    const executionId = started.execution.execution_id;
    // Runtime executions are not projected into the Workbench store, so the
    // terminal-state wait polls the transport-level execution record (the
    // projection-equivalent of watching a run reach its terminal status).
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const execution = await host.store.getExecution(executionId);
      if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
        return {
          status: execution.status,
          preview: await outputPreview(executionId),
          execution_id: executionId,
        };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Execution ${executionId} did not reach a terminal state within ${timeoutMs}ms (last: ${execution.status}).`,
        );
      }
      await delay(EXECUTION_POLL_INTERVAL_MS);
    }
  }

  function clickElement(selector: string): void {
    const element = doc.querySelector(selector);
    if (element == null) throw new Error(`No element matches "${selector}".`);
    if (element instanceof HTMLElement) element.focus();
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  function typeInto(selector: string, text: string): void {
    const element = doc.querySelector(selector);
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
      throw new Error(`act.type target "${selector}" is not an input or textarea.`);
    }
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isSequentialFocusTarget(element: HTMLElement): boolean {
    if (element.tabIndex < 0 || element.matches(":disabled")) return false;
    if (element.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
    for (let current: HTMLElement | null = element; current != null; current = current.parentElement) {
      const style = doc.defaultView?.getComputedStyle(current);
      if (style?.display === "none" || style?.visibility === "hidden") return false;
    }
    return true;
  }

  function focusNextElement(current: Element): void {
    const focusable = [...doc.querySelectorAll<HTMLElement>([
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "[contenteditable='true']",
      "[tabindex]",
    ].join(", "))].filter(isSequentialFocusTarget);
    if (focusable.length === 0) return;
    const index = focusable.indexOf(current as HTMLElement);
    focusable[index < 0 || index === focusable.length - 1 ? 0 : index + 1]?.focus();
  }

  function pressKey(key: string, selector?: string): void {
    const target = selector != null
      ? doc.querySelector(selector)
      : doc.activeElement ?? doc.body;
    if (target == null) throw new Error(`No element matches "${selector ?? ""}".`);
    const continueDefault = target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    if (continueDefault && key === "Tab") focusNextElement(target);
    if (continueDefault && key === "Enter" && target instanceof HTMLButtonElement) target.click();
    (doc.activeElement ?? target).dispatchEvent(
      new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }),
    );
  }

  async function settleUiMutations(): Promise<void> {
    // React handlers can enqueue a controller task one microtask before that
    // task registers its underlying Store mutation. Drain both layers so a
    // later project switch cannot strand an old-project Surface update.
    await Promise.resolve();
    await host.store.settled();
    await Promise.resolve();
    await host.store.settled();
  }

  async function act(action: AutomationAction): Promise<unknown> {
    switch (action.kind) {
      case "open_project":
        await host.actions.openProject(action.path);
        await waitForReady(OPEN_PROJECT_READY_TIMEOUT_MS);
        return { project: action.path };
      case "console_submit":
        return consoleSubmit(action.code, action.timeout_ms ?? CONSOLE_SUBMIT_DEFAULT_TIMEOUT_MS);
      case "open_surface":
        await host.actions.openSurface(action.surface_id);
        return null;
      case "focus_instance":
        await host.actions.focusInstance(action.instance_id);
        return null;
      case "close_instance":
        await host.actions.closeInstance(action.instance_id);
        return null;
      case "set_mode":
        await host.actions.setMode(action.mode);
        return { active_mode: action.mode };
      case "click":
        clickElement(action.selector);
        return null;
      case "type":
        typeInto(action.selector, action.text);
        return null;
      case "key":
        pressKey(action.key, action.selector);
        await settleUiMutations();
        return null;
      case "wait":
        return waitForCondition(action.until, action.timeout_ms ?? WAIT_DEFAULT_TIMEOUT_MS);
    }
  }

  async function request(raw: unknown): Promise<unknown> {
    const parsed = parseAutomationRequest(raw);
    switch (parsed.command) {
      case "ready":
        return ready();
      case "snapshot":
        return snapshot();
      case "query":
        return query(parsed);
      case "act":
        return act(parsed.action);
    }
  }

  return { request, snapshot, ready };
}

export type AcceptanceBridgeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type AcceptanceBridgeListen = (
  event: string,
  handler: (event: { readonly payload: unknown }) => void,
) => Promise<() => void>;

export interface AcceptanceAutomationInstall {
  readonly host: () => AutomationHost | null;
  readonly listen: AcceptanceBridgeListen;
  readonly invoke: AcceptanceBridgeInvoke;
  readonly target?: Window;
}

export const ACCEPTANCE_EVAL_EVENT = "rho://acceptance-eval";

export function installAcceptanceAutomation(install: AcceptanceAutomationInstall): () => void {
  const target = install.target ?? window;
  const surface = (): RhoAutomationSurface => {
    const host = install.host();
    if (host == null) throw new Error("The Workbench automation host is not ready.");
    const doc = target.document;
    return createAutomationSurface(host, { doc });
  };
  const api: RhoAutomationSurface = {
    request: (raw) => surface().request(raw),
    snapshot: () => surface().snapshot(),
    ready: () => surface().ready(),
  };
  const onEval = (event: { readonly payload: unknown }) => {
    const payload = isRecord(event.payload) ? event.payload : {};
    const id = typeof payload.id === "number" && Number.isFinite(payload.id) ? payload.id : 0;
    const js = typeof payload.js === "string" ? payload.js : "";
    void api.request(js).then(
      (value) => install.invoke("acceptance_bridge_result", {
        id,
        ok: true,
        value: value ?? null,
        error: null,
      }),
      (error: unknown) => install.invoke("acceptance_bridge_result", {
        id,
        ok: false,
        value: null,
        error: automationErrorMessage(error),
      }),
    ).catch(() => undefined);
  };
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void install.listen(ACCEPTANCE_EVAL_EVENT, onEval).then((unregister) => {
    if (disposed) unregister();
    else unlisten = unregister;
  }).catch(() => undefined);
  target.__rhoAutomation = api;
  return () => {
    disposed = true;
    unlisten?.();
    if (target.__rhoAutomation === api) delete target.__rhoAutomation;
  };
}
