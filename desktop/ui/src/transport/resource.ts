import {
  createResourceCommands,
  type ResourceBindingV1,
  type ResourceContentV1,
  type ResourceDeleteRequestV1,
  type ResourceDescriptorV1,
  type ResourceDraftRequestV1,
  type ResourceInvoke,
  type ResourceProviderDefinitionV1,
  type ResourceProviderRegistrationV1,
  type ResourceReadConsistencyV1,
  type ResourceReadRequestV1,
  type ResourceRegistrySnapshotV1,
  type ResourceReloadRequestV1,
  type ResourceRenameRequestV1,
  type ResourceResolveRequestV1,
  type ResourceSaveRequestV1,
  type ResourceStatusV1,
  type ResourceTargetV1,
} from "./generated/resource";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ResourceBinding = DeepReadonly<ResourceBindingV1>;
export type ResourceStatus = ResourceStatusV1;
export type ResourceReadConsistency = ResourceReadConsistencyV1;
export type ResourceDescriptor = DeepReadonly<ResourceDescriptorV1>;
export type ResourceProviderDefinition = DeepReadonly<ResourceProviderDefinitionV1>;
export type ResourceProviderRegistration = DeepReadonly<ResourceProviderRegistrationV1>;

export type ResourceRegistrySnapshot = Omit<
  DeepReadonly<ResourceRegistrySnapshotV1>,
  "contract" | "contract_major"
> & {
  readonly contract: "rho.ui.resource-registry.snapshot.v1";
  readonly contract_major: 1;
};

export type ResourceTarget = DeepReadonly<ResourceTargetV1>;
export type ResourceResolveRequest = DeepReadonly<ResourceResolveRequestV1>;
export type ResourceReadRequest = DeepReadonly<ResourceReadRequestV1>;

export type ResourceContent = Omit<
  DeepReadonly<ResourceContentV1>,
  "contract"
> & {
  readonly contract: "rho.ui.resource-content.v1";
};

export type ResourceDraftRequest = DeepReadonly<ResourceDraftRequestV1>;
export type ResourceSaveRequest = DeepReadonly<ResourceSaveRequestV1>;
export type ResourceReloadRequest = DeepReadonly<ResourceReloadRequestV1>;
export type ResourceRenameRequest = DeepReadonly<ResourceRenameRequestV1>;
export type ResourceDeleteRequest = DeepReadonly<ResourceDeleteRequestV1>;

export interface ResourceTransport {
  loadResources(): Promise<ResourceRegistrySnapshot>;
  resolveResource(request: ResourceResolveRequest): Promise<ResourceRegistrySnapshot>;
  readResource(request: ResourceReadRequest): Promise<ResourceContent>;
  updateResourceDraft(request: ResourceDraftRequest): Promise<ResourceContent>;
  saveResource(request: ResourceSaveRequest): Promise<ResourceContent>;
  reloadResource(request: ResourceReloadRequest): Promise<ResourceContent>;
  renameResource(request: ResourceRenameRequest): Promise<ResourceRegistrySnapshot>;
  deleteResource(request: ResourceDeleteRequest): Promise<ResourceRegistrySnapshot>;
}

function checkedRegistrySnapshot(snapshot: ResourceRegistrySnapshotV1): ResourceRegistrySnapshot {
  if (
    snapshot.contract !== "rho.ui.resource-registry.snapshot.v1" ||
    snapshot.contract_major !== 1
  ) {
    throw new Error("Resource Registry returned an unsupported contract version.");
  }
  return snapshot as ResourceRegistrySnapshot;
}

function checkedResourceContent(content: ResourceContentV1): ResourceContent {
  if (content.contract !== "rho.ui.resource-content.v1") {
    throw new Error("Resource Registry returned an unsupported content contract.");
  }
  return content as ResourceContent;
}

export function createTauriResourceTransport(invoke: ResourceInvoke): ResourceTransport {
  const commands = createResourceCommands(invoke);
  return {
    loadResources: () => commands.resourceList().then(checkedRegistrySnapshot),
    resolveResource: (request) => commands.resourceResolve(request).then(checkedRegistrySnapshot),
    readResource: (request) => commands.resourceRead(request).then(checkedResourceContent),
    updateResourceDraft: (request) => (
      commands.resourceUpdateDraft(request).then(checkedResourceContent)
    ),
    saveResource: (request) => commands.resourceSave(request).then(checkedResourceContent),
    reloadResource: (request) => commands.resourceReload(request).then(checkedResourceContent),
    renameResource: (request) => commands.resourceRename(request).then(checkedRegistrySnapshot),
    deleteResource: (request) => commands.resourceDelete(request).then(checkedRegistrySnapshot),
  };
}
