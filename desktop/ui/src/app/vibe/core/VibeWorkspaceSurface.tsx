import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type {
  SurfaceInstance,
  VibePage,
  VibePageExport,
} from "../../../transport";
import { VibeWorkspace } from "../../VibeWorkspace";
import {
  VibeExplorationPanel,
  type VibeExplorationSelection,
  type VibeExplorationTransport,
} from "../exploration";
import {
  VibeManuscriptLane,
  type ManuscriptCommit,
  type ManuscriptSaveState,
  type VibeManuscriptLaneHandle,
} from "../manuscript";
import {
  VerificationPane,
  type VerificationAdapter,
  type VerificationStudioTarget,
} from "../verification";
import { verificationFocusForVibe } from "./vibe-verification-focus";
import type { OpenVibeTargetInStudioIntent } from "./vibe-studio-target";
import {
  blockForId,
  correspondenceForFocus,
  focusForPage,
  initialVibeWorkspaceViewState,
  reduceVibeWorkspaceView,
  type VibeWorkspaceViewState,
} from "./vibe-workspace-model";

export type VibeReturnPoint = VibeWorkspaceViewState;

export interface VibeWorkspaceSurfaceHandle {
  readonly prepareToLeave: () => Promise<VibeReturnPoint>;
  readonly focusManuscript: () => void;
}

export interface VibeWorkspaceSurfaceProps {
  readonly page: VibePage;
  readonly profileRevision: number;
  readonly projectRoot: string;
  readonly projectRevision: number;
  readonly projectEpoch: number;
  readonly transitionBusy: boolean;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly restoredReturnPoint: VibeReturnPoint | null;
  readonly onReturnPointRestored: (point: VibeReturnPoint) => void;
  readonly commitPage: ManuscriptCommit;
  readonly exportCurrentPage: (pageId: string) => Promise<VibePageExport>;
  readonly explorationTransport: VibeExplorationTransport;
  readonly verificationAdapter: VerificationAdapter;
  readonly onOpenStudio: (
    intent: OpenVibeTargetInStudioIntent,
    returnPoint: VibeReturnPoint,
  ) => Promise<void>;
  readonly onOpenAgent: (
    selection: VibeExplorationSelection,
    compose: boolean,
    returnPoint: VibeReturnPoint,
  ) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}

type ExportState =
  | { readonly kind: "idle" }
  | { readonly kind: "exporting" }
  | { readonly kind: "ready"; readonly value: VibePageExport }
  | { readonly kind: "error" };

const SAVED: ManuscriptSaveState = Object.freeze({ kind: "saved" });

function initialViewState(
  page: VibePage,
  restored: VibeReturnPoint | null,
): VibeWorkspaceViewState {
  if (
    restored != null
    && restored.projectId === page.project_id
    && restored.pageId === page.page_id
  ) {
    return {
      ...restored,
      blockId: blockForId(page, restored.blockId)?.block_id ?? null,
    };
  }
  return initialVibeWorkspaceViewState(
    page.project_id,
    page.page_id,
    blockForId(page, page.focused_block_id)?.block_id ?? null,
  );
}

function studioTarget(target: VerificationStudioTarget): OpenVibeTargetInStudioIntent["target"] {
  switch (target.kind) {
    case "run": return { kind: "run", id: target.id };
    case "artifact": return { kind: "artifact", id: target.id };
    case "check": return { kind: "check", id: target.id };
  }
}

function transitionFailure(state: ManuscriptSaveState): Error {
  switch (state.kind) {
    case "error": return new Error("手稿保存失败；请处理保存问题后再离开 Vibe。");
    case "dirty": return new Error("手稿仍有未保存修改；已留在 Vibe。");
    case "saving": return new Error("手稿仍在保存；已留在 Vibe。");
    case "saved": return new Error("手稿状态无法确认；已留在 Vibe。");
  }
}

export const VibeWorkspaceSurface = forwardRef<
  VibeWorkspaceSurfaceHandle,
  VibeWorkspaceSurfaceProps
>(function VibeWorkspaceSurface({
  page,
  profileRevision,
  projectRoot,
  projectRevision,
  projectEpoch,
  transitionBusy,
  instances,
  restoredReturnPoint,
  onReturnPointRestored,
  commitPage,
  exportCurrentPage,
  explorationTransport,
  verificationAdapter,
  onOpenStudio,
  onOpenAgent,
  reportError,
}, ref) {
  const exportPreviewId = useId();
  const [viewState, dispatch] = useReducer(
    reduceVibeWorkspaceView,
    undefined,
    () => initialViewState(page, restoredReturnPoint),
  );
  const [explorationSelection, setExplorationSelection] = useState<VibeExplorationSelection>({
    conversationId: null,
    turnId: null,
  });
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const [handoffBusy, setHandoffBusy] = useState(false);
  const manuscript = useRef<VibeManuscriptLaneHandle>(null);
  const handoffBusyRef = useRef(false);
  const transitionBusyRef = useRef(transitionBusy);
  transitionBusyRef.current = transitionBusy;
  const saveState = useRef<ManuscriptSaveState>(SAVED);
  const restoredOnMount = useRef(restoredReturnPoint);
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;

  useEffect(() => {
    const point = restoredOnMount.current;
    if (point == null) return;
    restoredOnMount.current = null;
    onReturnPointRestored(point);
  }, [onReturnPointRestored]);

  useEffect(() => {
    dispatch({
      kind: "replace_page",
      projectId: page.project_id,
      pageId: page.page_id,
      blockId: blockForId(page, viewStateRef.current.blockId)?.block_id
        ?? blockForId(page, page.focused_block_id)?.block_id
        ?? null,
    });
  }, [page.project_id, page.page_id, page.page_revision, page.focused_block_id]);

  const focus = useMemo(
    () => focusForPage(page, viewState, instances),
    [instances, page, viewState],
  );
  const correspondence = useMemo(() => correspondenceForFocus(focus), [focus]);
  const verificationFocus = useMemo(() => verificationFocusForVibe({
    page,
    projectRoot,
    projectRevision,
    epoch: projectEpoch,
    focus,
    instances,
  }), [focus, instances, page, projectEpoch, projectRevision, projectRoot]);

  const exactConversationId = focus.exactRefs.conversationIds[0] ?? null;
  const exactTurnId = focus.exactRefs.taskIds[0] ?? null;
  useEffect(() => {
    if (exactConversationId == null && exactTurnId == null) return;
    setExplorationSelection({
      conversationId: exactConversationId,
      turnId: exactTurnId,
    });
  }, [exactConversationId, exactTurnId]);

  const currentReturnPoint = useCallback((): VibeReturnPoint => ({
    ...viewStateRef.current,
    blockId: blockForId(page, viewStateRef.current.blockId)?.block_id ?? null,
  }), [page]);

  const flushAndRequireSaved = useCallback(async (): Promise<void> => {
    await manuscript.current?.flushPendingEdits();
    if (saveState.current.kind !== "saved") throw transitionFailure(saveState.current);
  }, []);

  const prepareToLeave = useCallback(async (): Promise<VibeReturnPoint> => {
    await flushAndRequireSaved();
    return currentReturnPoint();
  }, [currentReturnPoint, flushAndRequireSaved]);

  const runHandoff = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    if (handoffBusyRef.current || transitionBusyRef.current) {
      throw new Error("Another Vibe transition is still in progress.");
    }
    handoffBusyRef.current = true;
    setHandoffBusy(true);
    try {
      await operation();
    } finally {
      handoffBusyRef.current = false;
      setHandoffBusy(false);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    prepareToLeave,
    focusManuscript: () => manuscript.current?.focusEditor(),
  }), [prepareToLeave]);

  const openStudio = useCallback(async (target: VerificationStudioTarget) => {
    try {
      await runHandoff(async () => {
        const returnPoint = await prepareToLeave();
        await onOpenStudio({
          projectId: page.project_id,
          pageId: page.page_id,
          blockId: focus.blockId,
          region: viewStateRef.current.activeRegion,
          sourceExactRefs: focus.exactRefs,
          target: studioTarget(target),
        }, returnPoint);
      });
    } catch (error: unknown) {
      reportError(error);
      throw error;
    }
  }, [
    focus.blockId,
    focus.exactRefs,
    onOpenStudio,
    page.page_id,
    page.project_id,
    prepareToLeave,
    reportError,
    runHandoff,
  ]);

  const openAgent = useCallback(async (
    selection: VibeExplorationSelection,
    compose: boolean,
  ) => {
    try {
      await runHandoff(async () => {
        const returnPoint = await prepareToLeave();
        await onOpenAgent(selection, compose, returnPoint);
      });
    } catch (error: unknown) {
      reportError(error);
    }
  }, [onOpenAgent, prepareToLeave, reportError, runHandoff]);

  const exportPage = async () => {
    if (exportState.kind === "exporting") return;
    setExportState({ kind: "exporting" });
    try {
      await flushAndRequireSaved();
      const value = await exportCurrentPage(page.page_id);
      if (value.project_id !== page.project_id || value.page_id !== page.page_id) {
        throw new Error("导出返回了另一个项目或手稿。当前导出已丢弃。");
      }
      setExportState({ kind: "ready", value });
    } catch (error: unknown) {
      setExportState({ kind: "error" });
      reportError(error);
    }
  };

  const footer = (
    <div className="rho-vibe-document-actions">
      <button
        type="button"
        disabled={exportState.kind === "exporting"}
        aria-controls={exportState.kind === "ready" ? exportPreviewId : undefined}
        onClick={() => void exportPage()}
      >{exportState.kind === "exporting" ? "正在导出…" : "导出只读手稿"}</button>
      {exportState.kind === "error" && <span role="status">导出未完成；手稿内容仍保留。</span>}
      {exportState.kind === "ready" && (
        <details id={exportPreviewId} className="rho-vibe-export">
          <summary>只读导出 · revision {exportState.value.page_revision}</summary>
          <pre>{exportState.value.markdown}</pre>
        </details>
      )}
    </div>
  );

  return (
    <VibeWorkspace
      label={page.label}
      layoutMode={viewState.layoutMode}
      activeRegion={viewState.activeRegion}
      correspondence={correspondence}
      onActivateRegion={(region) => dispatch({ kind: "activate_region", region })}
      onShowOverview={() => dispatch({ kind: "show_overview" })}
      manuscript={(
        <VibeManuscriptLane
          ref={manuscript}
          status="ready"
          busy={transitionBusy || handoffBusy}
          page={page}
          profileRevision={profileRevision}
          commitPage={commitPage}
          reportError={reportError}
          activeBlockId={focus.blockId}
          onActiveBlockChange={(intent) => {
            if (intent.pageId !== page.page_id) return;
            dispatch({ kind: "select_block", blockId: intent.blockId });
          }}
          onSaveStateChange={(state) => { saveState.current = state; }}
        />
      )}
      exploration={(
        <VibeExplorationPanel
          projectId={page.project_id}
          projectRoot={projectRoot}
          pageId={page.page_id}
          presentation={viewState.layoutMode === "focus-exploration" ? "focused" : "overview"}
          selection={explorationSelection}
          exactRefs={{
            conversationIds: focus.exactRefs.conversationIds,
            taskIds: focus.exactRefs.taskIds,
          }}
          transport={explorationTransport}
          onSelectionChange={setExplorationSelection}
          onOpenHost={() => dispatch({ kind: "activate_region", region: "exploration" })}
          onCompose={(selection) => { void openAgent(selection, true); }}
          onOpenAgent={(selection) => { void openAgent(selection, false); }}
          onError={reportError}
        />
      )}
      verification={(
        <VerificationPane
          focus={verificationFocus}
          adapter={verificationAdapter}
          layout={viewState.layoutMode === "focus-verification" ? "focused" : "overview"}
          onOpenStudio={openStudio}
        />
      )}
      footer={footer}
    />
  );
});
