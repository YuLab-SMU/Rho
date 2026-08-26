import type { VibePage, VibeSection } from "../../../transport";

import type {
  ManuscriptCommit,
  ManuscriptSaveState,
} from "./manuscript-types";

interface Draft {
  readonly sections: readonly VibeSection[];
  readonly focusedBlockId: string | null;
  readonly generation: number;
}

interface SessionTarget {
  readonly projectId: string;
  readonly pageId: string;
  readonly profileRevision: number;
  readonly pageRevision: number;
}

interface DurablePage {
  readonly page: VibePage;
  readonly profileRevision: number;
}

interface Drain {
  readonly generation: number;
  readonly promise: Promise<void>;
}

export interface ManuscriptPageSessionOptions {
  readonly page: VibePage;
  readonly profileRevision: number;
  readonly commitPage: ManuscriptCommit;
  readonly restoreDurable: (page: VibePage) => void;
  readonly reportError: (error: unknown) => void;
  readonly setSaveState: (state: ManuscriptSaveState) => void;
  readonly debounceMs?: number;
}

const SAVE_FAILURE_COPY = "Save failed; restored the last saved manuscript.";

function sameIdentity(page: VibePage, target: SessionTarget): boolean {
  return page.project_id === target.projectId && page.page_id === target.pageId;
}

export class ManuscriptPageSession {
  #commitPage: ManuscriptCommit;
  #restoreDurable: (page: VibePage) => void;
  #reportError: (error: unknown) => void;
  #setSaveState: (state: ManuscriptSaveState) => void;
  readonly #debounceMs: number;
  #target: SessionTarget;
  #durable: DurablePage;
  #desired: Draft | null = null;
  #timer: number | null = null;
  #drain: Drain | null = null;
  #generation = 1;
  #disposed = false;
  #state: ManuscriptSaveState = { kind: "saved" };

  constructor(options: ManuscriptPageSessionOptions) {
    this.#commitPage = options.commitPage;
    this.#restoreDurable = options.restoreDurable;
    this.#reportError = options.reportError;
    this.#setSaveState = options.setSaveState;
    this.#debounceMs = options.debounceMs ?? 180;
    this.#target = {
      projectId: options.page.project_id,
      pageId: options.page.page_id,
      profileRevision: options.profileRevision,
      pageRevision: options.page.page_revision,
    };
    this.#durable = { page: options.page, profileRevision: options.profileRevision };
  }

  get state(): ManuscriptSaveState {
    return this.#state;
  }

  setHandlers(options: Pick<
    ManuscriptPageSessionOptions,
    "commitPage" | "restoreDurable" | "reportError" | "setSaveState"
  >): void {
    this.#commitPage = options.commitPage;
    this.#restoreDurable = options.restoreDurable;
    this.#reportError = options.reportError;
    this.#setSaveState = options.setSaveState;
  }

  updateDurable(page: VibePage, profileRevision: number): void {
    if (this.#disposed) return;
    if (!sameIdentity(page, this.#target)) {
      this.#advanceGeneration();
      this.#target = {
        projectId: page.project_id,
        pageId: page.page_id,
        profileRevision,
        pageRevision: page.page_revision,
      };
      this.#durable = { page, profileRevision };
      this.#restoreDurable(page);
      this.#emit({ kind: "saved" });
      return;
    }

    const previous = this.#durable;
    const pageAdvanced = page.page_revision > previous.page.page_revision;
    const profileAdvanced = profileRevision > previous.profileRevision;
    if (pageAdvanced || (page.page_revision === previous.page.page_revision && profileAdvanced)) {
      this.#durable = { page, profileRevision };
    }

    const busy = this.#desired != null || this.#drain?.generation === this.#generation;
    if (!busy) {
      this.#target = {
        projectId: page.project_id,
        pageId: page.page_id,
        profileRevision,
        pageRevision: page.page_revision,
      };
      if (pageAdvanced) this.#restoreDurable(page);
    }
  }

  enqueue(sections: readonly VibeSection[], focusedBlockId: string | null): void {
    if (this.#disposed) return;
    this.#desired = { sections, focusedBlockId, generation: this.#generation };
    this.#emit({ kind: "dirty" });
    if (this.#timer != null) window.clearTimeout(this.#timer);
    if (this.#drain?.generation === this.#generation) return;
    const generation = this.#generation;
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      if (this.#generation === generation) void this.flush();
    }, this.#debounceMs);
  }

  flush(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#timer != null) {
      window.clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#drain?.generation === this.#generation) return this.#drain.promise;
    if (this.#desired?.generation !== this.#generation) return Promise.resolve();

    const generation = this.#generation;
    const promise = this.#drainGeneration(generation);
    const drain = { generation, promise };
    this.#drain = drain;
    void promise.finally(() => {
      if (this.#drain !== drain) return;
      this.#drain = null;
      if (this.#desired?.generation === this.#generation) void this.flush();
    });
    return promise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#advanceGeneration();
  }

  async #drainGeneration(generation: number): Promise<void> {
    while (!this.#disposed && generation === this.#generation) {
      const draft = this.#desired;
      if (draft == null || draft.generation !== generation) return;
      this.#desired = null;
      const target = this.#target;
      this.#emit({ kind: "saving" });
      try {
        const snapshot = await this.#commitPage({
          target: {
            project_id: target.projectId,
            expected_profile_revision: target.profileRevision,
          },
          page_id: target.pageId,
          expected_page_revision: target.pageRevision,
          mutation: {
            kind: "replace_sections",
            sections: draft.sections,
            focused_block_id: draft.focusedBlockId,
          },
        });
        if (this.#disposed || generation !== this.#generation) return;
        if (snapshot.profile.project_id !== target.projectId) {
          throw new Error("Saved manuscript returned a different project.");
        }
        const saved = snapshot.profile.vibe_pages.find((page) => page.page_id === target.pageId);
        if (saved == null) throw new Error("Saved manuscript disappeared from its UI Profile.");

        this.#target = {
          projectId: target.projectId,
          pageId: target.pageId,
          profileRevision: snapshot.profile.revision,
          pageRevision: saved.page_revision,
        };
        if (saved.page_revision >= this.#durable.page.page_revision) {
          this.#durable = { page: saved, profileRevision: snapshot.profile.revision };
        }

        if (this.#hasDesired(generation)) continue;

        if (this.#durable.page.page_revision > saved.page_revision) {
          this.#target = {
            projectId: this.#durable.page.project_id,
            pageId: this.#durable.page.page_id,
            profileRevision: this.#durable.profileRevision,
            pageRevision: this.#durable.page.page_revision,
          };
          this.#restoreDurable(this.#durable.page);
        }
        this.#emit({ kind: "saved" });
      } catch (error: unknown) {
        if (this.#disposed || generation !== this.#generation) return;
        this.#desired = null;
        this.#target = {
          projectId: this.#durable.page.project_id,
          pageId: this.#durable.page.page_id,
          profileRevision: this.#durable.profileRevision,
          pageRevision: this.#durable.page.page_revision,
        };
        this.#restoreDurable(this.#durable.page);
        this.#emit({ kind: "error", message: SAVE_FAILURE_COPY });
        this.#reportError(error);
        return;
      }
    }
  }

  #advanceGeneration(): void {
    this.#generation += 1;
    if (this.#timer != null) window.clearTimeout(this.#timer);
    this.#timer = null;
    this.#desired = null;
    this.#drain = null;
  }

  #hasDesired(generation: number): boolean {
    return this.#desired != null && this.#desired.generation === generation;
  }

  #emit(state: ManuscriptSaveState): void {
    if (this.#disposed) return;
    this.#state = state;
    this.#setSaveState(state);
  }
}
