import {
  createPluginSurfaceCommands,
  type PluginCommandResultV1_Serialize,
  type PluginSurfaceDocumentRequest as PluginSurfaceDocumentRequestWire,
  type PluginSurfaceDocumentView as PluginSurfaceDocumentViewWire,
  type PluginSurfaceEventRequest as PluginSurfaceEventRequestWire,
  type PluginSurfaceEventResult_Serialize as PluginSurfaceEventResultWire,
  type PluginSurfaceInvoke,
  type PluginSurfaceJsonValue as PluginSurfaceJsonValueWire,
  type SurfaceBlockV1,
  type SurfaceDocumentV1,
  type SurfaceEventKindV1,
  type SurfaceNoticeToneV1,
} from "./generated/plugin-surface";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type PluginSurfaceJsonValue = DeepReadonly<PluginSurfaceJsonValueWire>;
export type PluginSurfaceEventKind = SurfaceEventKindV1;
export type PluginSurfaceNoticeTone = SurfaceNoticeToneV1;
export type PluginSurfaceBlock = DeepReadonly<SurfaceBlockV1>;
export type PluginSurfaceCommandResult = DeepReadonly<PluginCommandResultV1_Serialize>;

export type PluginSurfaceDocument = Omit<
  DeepReadonly<SurfaceDocumentV1>,
  "contract"
> & {
  readonly contract: "rho.plugin_surface_document.v1";
};

export type PluginSurfaceDocumentRequest = DeepReadonly<PluginSurfaceDocumentRequestWire>;
export type PluginSurfaceEventRequest = DeepReadonly<PluginSurfaceEventRequestWire>;

export type PluginSurfaceDocumentView = Omit<
  DeepReadonly<PluginSurfaceDocumentViewWire>,
  "document"
> & {
  readonly document: PluginSurfaceDocument;
};

export type PluginSurfaceEventResult = Omit<
  DeepReadonly<PluginSurfaceEventResultWire>,
  "document"
> & {
  readonly document: PluginSurfaceDocument | null;
};

export interface PluginSurfaceTransport {
  loadPluginSurfaceDocument(
    request: PluginSurfaceDocumentRequest,
  ): Promise<PluginSurfaceDocumentView>;
  dispatchPluginSurfaceEvent(
    request: PluginSurfaceEventRequest,
  ): Promise<PluginSurfaceEventResult>;
}

function toWireJson(value: PluginSurfaceJsonValue): PluginSurfaceJsonValueWire {
  if (Array.isArray(value)) return value.map(toWireJson);
  if (typeof value !== "object" || value == null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toWireJson(item)]),
  );
}

function documentFromWire(document: SurfaceDocumentV1): PluginSurfaceDocument {
  if (document.contract !== "rho.plugin_surface_document.v1") {
    throw new Error(`Unsupported Plugin Surface document contract: ${document.contract}`);
  }
  return document as PluginSurfaceDocument;
}

export function createTauriPluginSurfaceTransport(
  invoke: PluginSurfaceInvoke,
): PluginSurfaceTransport {
  const commands = createPluginSurfaceCommands(invoke);
  return {
    loadPluginSurfaceDocument: async (request) => {
      const view = await commands.pluginSurfaceDocument(request);
      return { ...view, document: documentFromWire(view.document) };
    },
    dispatchPluginSurfaceEvent: async (request) => {
      const result = await commands.pluginSurfaceEvent({
        ...request,
        value: toWireJson(request.value),
      });
      return {
        ...result,
        document: result.document == null ? null : documentFromWire(result.document),
      };
    },
  };
}
