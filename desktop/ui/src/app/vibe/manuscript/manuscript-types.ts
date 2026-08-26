import type {
  ProjectUiProfileSnapshot,
  VibePage,
  VibeSection,
} from "../../../transport";

export type ManuscriptSaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "dirty" }
  | { readonly kind: "saving" }
  | { readonly kind: "error"; readonly message: string };

export interface ManuscriptCommitRequest {
  readonly target: {
    readonly project_id: string;
    readonly expected_profile_revision: number;
  };
  readonly page_id: string;
  readonly expected_page_revision: number;
  readonly mutation: {
    readonly kind: "replace_sections";
    readonly sections: readonly VibeSection[];
    readonly focused_block_id: string | null;
  };
}

export type ManuscriptCommit = (
  request: ManuscriptCommitRequest,
) => Promise<ProjectUiProfileSnapshot>;

export interface ManuscriptBlockIntent {
  readonly pageId: string;
  readonly blockId: string | null;
}

interface ManuscriptLoadingProps {
  readonly status: "loading";
  readonly label?: string;
}

interface ManuscriptErrorProps {
  readonly status: "error";
  readonly message: string;
  readonly retry?: () => void | Promise<void>;
}

export interface ManuscriptReadyProps {
  readonly status: "ready";
  readonly busy?: boolean;
  readonly page: VibePage;
  readonly profileRevision: number;
  readonly commitPage: ManuscriptCommit;
  readonly reportError: (error: unknown) => void;
  /**
   * This is an exact current Vibe block identity. It is deliberately not
   * called an anchor: VIBE-1 has no durable manuscript-anchor authority.
   */
  readonly activeBlockId?: string | null | undefined;
  readonly onActiveBlockChange?: ((intent: ManuscriptBlockIntent) => void) | undefined;
  readonly onSaveStateChange?: ((state: ManuscriptSaveState) => void) | undefined;
}

export type VibeManuscriptLaneProps =
  | ManuscriptLoadingProps
  | ManuscriptErrorProps
  | ManuscriptReadyProps;

export interface VibeManuscriptLaneHandle {
  readonly flushPendingEdits: () => Promise<void>;
  readonly focusEditor: () => void;
}
