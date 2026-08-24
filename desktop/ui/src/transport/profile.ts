import {
  createProfileCommands,
  type PageExportRequest,
  type PageMutationRequest,
  type ProfileInvoke,
  type ProjectUiProfileSnapshotV1,
  type ProjectUiProfileV1,
  type RuntimeAttachmentIntentV1,
  type SceneLabelRequest,
  type SceneTargetRequest,
  type SelectPageRequest,
  type SelectSceneRequest,
  type SetModeRequest,
  type StudioScenePresetV1,
  type SurfaceInstanceSpecV1,
  type UiProfileLoadStatusV1,
  type UiProfileModeV1,
  type UiProfileRevisionRequestV1,
  type VibeBlockContentV1,
  type VibeBlockV1,
  type VibeCalloutToneV1,
  type VibeGridPlacementV1,
  type VibePageExportV1,
  type VibePageMutationV1,
  type VibePageV1,
  type VibeRichTextBlockV1,
  type VibeRichTextDocumentV1,
  type VibeRichTextInlineV1,
  type VibeRichTextMarkV1,
  type VibeSectionLayoutV1,
  type VibeSectionV1,
} from "./generated/profile";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type UiProfileMode = UiProfileModeV1;
export type UiProfileLoadStatus = UiProfileLoadStatusV1;
export type RuntimeAttachmentIntent = DeepReadonly<RuntimeAttachmentIntentV1>;
export type SurfaceInstanceSpec = DeepReadonly<SurfaceInstanceSpecV1>;
export type VibeCalloutTone = VibeCalloutToneV1;
export type VibeRichTextMark = DeepReadonly<VibeRichTextMarkV1>;
export type VibeRichTextInline = DeepReadonly<VibeRichTextInlineV1>;
export type VibeRichTextBlock = DeepReadonly<VibeRichTextBlockV1>;
export type VibeRichTextDocument = DeepReadonly<VibeRichTextDocumentV1>;
export type VibeBlockContent = DeepReadonly<VibeBlockContentV1>;
export type VibeBlock = DeepReadonly<VibeBlockV1>;
export type VibeGridPlacement = DeepReadonly<VibeGridPlacementV1>;
export type VibeSectionLayout = DeepReadonly<VibeSectionLayoutV1>;
export type VibeSection = DeepReadonly<VibeSectionV1>;
export type VibePage = DeepReadonly<VibePageV1>;

export type ProjectUiProfile = Omit<
  DeepReadonly<ProjectUiProfileV1>,
  "schema_version"
> & {
  readonly schema_version: 3;
};

export type StudioScenePreset = DeepReadonly<StudioScenePresetV1>;

export type ProjectUiProfileSnapshot = Omit<
  DeepReadonly<ProjectUiProfileSnapshotV1>,
  "contract" | "contract_major" | "profile"
> & {
  readonly contract: "rho.ui.project-profile.snapshot.v1";
  readonly contract_major: 1;
  readonly profile: ProjectUiProfile;
};

export type UiProfileRevisionRequest = DeepReadonly<UiProfileRevisionRequestV1>;
export type UiProfileSetModeRequest = DeepReadonly<SetModeRequest>;
export type UiProfileSelectSceneRequest = DeepReadonly<SelectSceneRequest>;
export type UiProfileSelectPageRequest = DeepReadonly<SelectPageRequest>;
export type UiProfileSceneLabelRequest = DeepReadonly<SceneLabelRequest>;
export type UiProfileSceneTargetRequest = DeepReadonly<SceneTargetRequest>;
export type VibePageMutation = DeepReadonly<VibePageMutationV1>;
export type VibePageMutationRequest = DeepReadonly<PageMutationRequest>;
export type VibePageExportRequest = DeepReadonly<PageExportRequest>;

export type VibePageExport = Omit<DeepReadonly<VibePageExportV1>, "contract"> & {
  readonly contract: "rho.ui.vibe-page.export.v1";
};

export interface ProfileTransport {
  loadUiProfile(): Promise<ProjectUiProfileSnapshot>;
  setUiProfileMode(request: UiProfileSetModeRequest): Promise<ProjectUiProfileSnapshot>;
  selectUiProfileScene(request: UiProfileSelectSceneRequest): Promise<ProjectUiProfileSnapshot>;
  selectUiProfilePage(request: UiProfileSelectPageRequest): Promise<ProjectUiProfileSnapshot>;
  applyVibePage(request: VibePageMutationRequest): Promise<ProjectUiProfileSnapshot>;
  exportVibePage(request: VibePageExportRequest): Promise<VibePageExport>;
  duplicateUiProfileScene(request: UiProfileSceneLabelRequest): Promise<ProjectUiProfileSnapshot>;
  saveUiProfileScene(request: UiProfileSceneTargetRequest): Promise<ProjectUiProfileSnapshot>;
  renameUiProfileScene(request: UiProfileSceneLabelRequest): Promise<ProjectUiProfileSnapshot>;
  deleteUiProfileScene(request: UiProfileSceneTargetRequest): Promise<ProjectUiProfileSnapshot>;
  resetUiProfileScene(request: UiProfileSceneTargetRequest): Promise<ProjectUiProfileSnapshot>;
}

function checkedProfileSnapshot(snapshot: ProjectUiProfileSnapshotV1): ProjectUiProfileSnapshot {
  if (
    snapshot.contract !== "rho.ui.project-profile.snapshot.v1" ||
    snapshot.contract_major !== 1 ||
    snapshot.profile.schema_version !== 3
  ) {
    throw new Error("UI Profile returned an unsupported contract version.");
  }
  return snapshot as ProjectUiProfileSnapshot;
}

function checkedVibePageExport(result: VibePageExportV1): VibePageExport {
  if (result.contract !== "rho.ui.vibe-page.export.v1") {
    throw new Error("Vibe Page export returned an unsupported contract version.");
  }
  return result as VibePageExport;
}

export function createTauriProfileTransport(invoke: ProfileInvoke): ProfileTransport {
  const commands = createProfileCommands(invoke);
  return {
    loadUiProfile: () => commands.uiProfileSnapshot().then(checkedProfileSnapshot),
    setUiProfileMode: (request) => commands.uiProfileSetMode(request).then(checkedProfileSnapshot),
    selectUiProfileScene: (request) => (
      commands.uiProfileSelectScene(request).then(checkedProfileSnapshot)
    ),
    selectUiProfilePage: (request) => (
      commands.uiProfileSelectPage(request).then(checkedProfileSnapshot)
    ),
    applyVibePage: (request) => (
      commands.uiProfilePageApply(request as PageMutationRequest).then(checkedProfileSnapshot)
    ),
    exportVibePage: (request) => commands.uiProfilePageExport(request).then(checkedVibePageExport),
    duplicateUiProfileScene: (request) => (
      commands.uiProfileSceneDuplicate(request).then(checkedProfileSnapshot)
    ),
    saveUiProfileScene: (request) => (
      commands.uiProfileSceneSave(request).then(checkedProfileSnapshot)
    ),
    renameUiProfileScene: (request) => (
      commands.uiProfileSceneRename(request).then(checkedProfileSnapshot)
    ),
    deleteUiProfileScene: (request) => (
      commands.uiProfileSceneDelete(request).then(checkedProfileSnapshot)
    ),
    resetUiProfileScene: (request) => (
      commands.uiProfileSceneReset(request).then(checkedProfileSnapshot)
    ),
  };
}
