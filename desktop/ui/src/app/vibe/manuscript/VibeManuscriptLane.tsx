import {
  forwardRef,
  useId,
  useRef,
  useState,
} from "react";

import { ManuscriptEditor } from "./ManuscriptEditor";
import type {
  ManuscriptReadyProps,
  ManuscriptSaveState,
  VibeManuscriptLaneHandle,
  VibeManuscriptLaneProps,
} from "./manuscript-types";

function saveCopy(state: ManuscriptSaveState): string {
  switch (state.kind) {
    case "saved": return "Saved";
    case "dirty": return "Unsaved changes";
    case "saving": return "Saving…";
    case "error": return state.message;
  }
}

const ReadyManuscriptLane = forwardRef<VibeManuscriptLaneHandle, ManuscriptReadyProps & {
  readonly headingId: string;
  readonly saveStatusId: string;
}>(function ReadyManuscriptLane({
  page,
  profileRevision,
  commitPage,
  reportError,
  activeBlockId,
  onActiveBlockChange,
  onSaveStateChange,
  headingId,
  saveStatusId,
}, ref) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [saveState, setSaveState] = useState<ManuscriptSaveState>({ kind: "saved" });
  const updateSaveState = (state: ManuscriptSaveState) => {
    setSaveState(state);
    onSaveStateChange?.(state);
  };

  return (
    <section
      className="rho-vibe-manuscript"
      data-region-role="manuscript"
      data-region-state={saveState.kind}
      aria-labelledby={headingId}
    >
      <header className="rho-vibe-manuscript-header">
        <div>
          <h2 ref={heading} id={headingId} tabIndex={-1}>手稿</h2>
          <p><span>Working manuscript</span><strong>{page.label}</strong></p>
        </div>
        <span
          id={saveStatusId}
          className="rho-vibe-manuscript-save-state"
          role={saveState.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >{saveCopy(saveState)}</span>
      </header>
      <ManuscriptEditor
        ref={ref}
        page={page}
        profileRevision={profileRevision}
        commitPage={commitPage}
        reportError={reportError}
        activeBlockId={activeBlockId}
        onActiveBlockChange={onActiveBlockChange}
        saveState={saveState}
        onSaveStateChange={updateSaveState}
        editorLabel={`${page.label} working manuscript`}
        describedBy={saveStatusId}
        onExitEditor={() => heading.current?.focus()}
      />
    </section>
  );
});

export const VibeManuscriptLane = forwardRef<VibeManuscriptLaneHandle, VibeManuscriptLaneProps>(
  function VibeManuscriptLane(props, ref) {
    const headingId = useId();
    const saveStatusId = useId();

    if (props.status === "loading") {
      return (
        <section
          className="rho-vibe-manuscript rho-vibe-manuscript-state"
          data-region-role="manuscript"
          data-region-state="loading"
          aria-labelledby={headingId}
          aria-busy="true"
        >
          <header className="rho-vibe-manuscript-header">
            <h2 id={headingId}>手稿</h2>
            <p>Working manuscript</p>
          </header>
          <p role="status">{props.label ?? "Loading manuscript…"}</p>
        </section>
      );
    }

    if (props.status === "error") {
      return (
        <section
          className="rho-vibe-manuscript rho-vibe-manuscript-state"
          data-region-role="manuscript"
          data-region-state="error"
          aria-labelledby={headingId}
        >
          <header className="rho-vibe-manuscript-header">
            <h2 id={headingId}>手稿</h2>
            <p>Working manuscript unavailable</p>
          </header>
          <p role="alert">{props.message}</p>
          {props.retry != null && (
            <button type="button" onClick={() => void props.retry?.()}>Try again</button>
          )}
        </section>
      );
    }

    return (
      <ReadyManuscriptLane
        key={`${props.page.project_id}:${props.page.page_id}`}
        ref={ref}
        {...props}
        headingId={headingId}
        saveStatusId={saveStatusId}
      />
    );
  },
);
