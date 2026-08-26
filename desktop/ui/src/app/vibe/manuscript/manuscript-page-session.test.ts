import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "../../../contracts/generated/rsr-contract-fixtures.json";
import type { ProjectUiProfileSnapshot, VibePage, VibeSection } from "../../../transport";
import { ManuscriptPageSession } from "./manuscript-page-session";
import type { ManuscriptSaveState } from "./manuscript-types";

const profileFixture = fixture.project_ui_profile_snapshot as unknown as ProjectUiProfileSnapshot;

function basePage(): VibePage {
  return structuredClone(profileFixture.profile.vibe_pages[0]!);
}

function pageWithRevision(
  source: VibePage,
  revision: number,
  sections: readonly VibeSection[] = source.sections,
): VibePage {
  return { ...source, page_revision: revision, sections };
}

function snapshotWithPage(page: VibePage, profileRevision: number): ProjectUiProfileSnapshot {
  const snapshot = structuredClone(profileFixture);
  const mutable = snapshot as unknown as {
    profile: {
      project_id: string;
      revision: number;
      active_vibe_page_id: string;
      vibe_pages: VibePage[];
    };
  };
  mutable.profile.project_id = page.project_id;
  mutable.profile.revision = profileRevision;
  mutable.profile.active_vibe_page_id = page.page_id;
  mutable.profile.vibe_pages = [page];
  return snapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("exact-CAS manuscript page session", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports dirty, saving and saved around one exactly targeted draft", async () => {
    vi.useFakeTimers();
    const page = basePage();
    const states: ManuscriptSaveState[] = [];
    const commitPage = vi.fn(async (request) => snapshotWithPage(
      pageWithRevision(page, 2, request.mutation.sections),
      8,
    ));
    const session = new ManuscriptPageSession({
      page,
      profileRevision: 7,
      commitPage,
      restoreDurable: vi.fn(),
      reportError: vi.fn(),
      setSaveState: (state) => states.push(state),
    });

    const sections = structuredClone(page.sections);
    session.enqueue(sections, "block:narrative");
    expect(states.at(-1)).toEqual({ kind: "dirty" });
    await vi.advanceTimersByTimeAsync(180);

    expect(commitPage).toHaveBeenCalledWith({
      target: {
        project_id: page.project_id,
        expected_profile_revision: 7,
      },
      page_id: page.page_id,
      expected_page_revision: 1,
      mutation: {
        kind: "replace_sections",
        sections,
        focused_block_id: "block:narrative",
      },
    });
    expect(states.map((state) => state.kind)).toEqual(["dirty", "saving", "saved"]);
  });

  it("serializes an edit made during a save onto that save's exact response revision", async () => {
    const page = basePage();
    const first = deferred<ProjectUiProfileSnapshot>();
    const second = deferred<ProjectUiProfileSnapshot>();
    const commitPage = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const session = new ManuscriptPageSession({
      page,
      profileRevision: 7,
      commitPage,
      restoreDurable: vi.fn(),
      reportError: vi.fn(),
      setSaveState: vi.fn(),
    });

    const firstSections = structuredClone(page.sections) as VibeSection[];
    const secondSections = structuredClone(page.sections) as VibeSection[];
    secondSections[0] = { ...secondSections[0]!, heading: "Updated while saving" };
    session.enqueue(firstSections, null);
    const flushing = session.flush();
    await Promise.resolve();
    session.enqueue(secondSections, null);

    first.resolve(snapshotWithPage(pageWithRevision(page, 2, firstSections), 8));
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(commitPage).toHaveBeenCalledTimes(2);
    expect(commitPage.mock.calls[1]?.[0]).toMatchObject({
      target: { expected_profile_revision: 8 },
      expected_page_revision: 2,
      mutation: { sections: secondSections },
    });

    second.resolve(snapshotWithPage(pageWithRevision(page, 3, secondSections), 9));
    await flushing;
    expect(session.state).toEqual({ kind: "saved" });
  });

  it("restores the latest durable page after rejection without reporting saved", async () => {
    const page = basePage();
    const pending = deferred<ProjectUiProfileSnapshot>();
    const restoreDurable = vi.fn();
    const reportError = vi.fn();
    const states: ManuscriptSaveState[] = [];
    const session = new ManuscriptPageSession({
      page,
      profileRevision: 7,
      commitPage: () => pending.promise,
      restoreDurable,
      reportError,
      setSaveState: (state) => states.push(state),
    });

    session.enqueue(structuredClone(page.sections), null);
    const flushing = session.flush();
    const latest = pageWithRevision(page, 2);
    session.updateDurable(latest, 8);
    pending.reject(new Error("Vibe Page rejected: Page revision is stale."));
    await flushing;

    expect(restoreDurable).toHaveBeenLastCalledWith(latest);
    expect(reportError).toHaveBeenCalledOnce();
    expect(states.at(-1)).toEqual({
      kind: "error",
      message: "Save failed; restored the last saved manuscript.",
    });
    session.updateDurable(latest, 8);
    expect(states.at(-1)?.kind).toBe("error");
  });

  it("discards a late save response after the project or page generation changes", async () => {
    const page = basePage();
    const pending = deferred<ProjectUiProfileSnapshot>();
    const restoreDurable = vi.fn();
    const reportError = vi.fn();
    const states: ManuscriptSaveState[] = [];
    const session = new ManuscriptPageSession({
      page,
      profileRevision: 7,
      commitPage: () => pending.promise,
      restoreDurable,
      reportError,
      setSaveState: (state) => states.push(state),
    });

    session.enqueue(structuredClone(page.sections), null);
    const oldFlush = session.flush();
    const replacement: VibePage = {
      ...page,
      project_id: "project:replacement",
      page_id: "page:replacement",
      label: "Replacement manuscript",
      page_revision: 1,
    };
    session.updateDurable(replacement, 1);
    pending.resolve(snapshotWithPage(pageWithRevision(page, 2), 8));
    await oldFlush;

    expect(restoreDurable).toHaveBeenLastCalledWith(replacement);
    expect(reportError).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ kind: "saved" });
  });
});
