import type { RequestContext } from "./shared/ports";
import type { ApplicationAction } from "./generated/ApplicationAction";
import type { ApplicationBridgeReply } from "./generated/ApplicationBridgeReply";
import type { ApplicationBridgeRequest } from "./generated/ApplicationBridgeRequest";
import type { ApplicationBridgeSession } from "./generated/ApplicationBridgeSession";
import type { ApplicationCommandReceipt } from "./generated/ApplicationCommandReceipt";
import type { ApplicationCommandStatusArguments } from "./generated/ApplicationCommandStatusArguments";
import type { ApplicationContextState } from "./generated/ApplicationContextState";
import type { ApplicationDocument } from "./generated/ApplicationDocument";
import type { ApplicationDocumentPage } from "./generated/ApplicationDocumentPage";
import type { ApplicationDocumentRef } from "./generated/ApplicationDocumentRef";
import type { ApplicationExecuteReply } from "./generated/ApplicationExecuteReply";
import type { ApplicationExecuteRequest } from "./generated/ApplicationExecuteRequest";
import type { ApplicationReadDocumentArguments } from "./generated/ApplicationReadDocumentArguments";
import type { ApplicationTextEdit } from "./generated/ApplicationTextEdit";
import type { ApplicationViewType } from "./generated/ApplicationViewType";
import type { ApplicationObjectSelection } from "./generated/ApplicationObjectSelection";
import type { ApplicationPackageSelection } from "./generated/ApplicationPackageSelection";
import type { ApplicationPlotSelection } from "./generated/ApplicationPlotSelection";

export interface ApplicationTransport {
  bridge(project: string, request: ApplicationBridgeRequest): Promise<ApplicationBridgeReply>;
  execute(project: string, request: ApplicationExecuteRequest): Promise<ApplicationExecuteReply>;
  status(project: string, args: ApplicationCommandStatusArguments): Promise<ApplicationCommandReceipt>;
  readDocument(project: string, args: ApplicationReadDocumentArguments): Promise<ApplicationDocumentPage>;
}

/** Studio composes these methods from resident module owners. Panels are absent. */
export interface ApplicationModules {
  context(): Omit<ApplicationContextState, "version">;
  documents(): readonly ApplicationDocument[];
  restoreDocuments(documents: readonly ApplicationDocument[], active: string | null): void;
  restoreViews(context: ApplicationContextState): void;
  openView(type: ApplicationViewType, id?: string): void;
  activateView(id: string): void;
  closeView(id: string): void;
  openDocument(path: string): Promise<unknown>;
  createDocument(path: string | null, text: string): void;
  checkDocument(document: ApplicationDocumentRef): void;
  setSelection(document: ApplicationDocumentRef, anchor: number, head: number): void;
  editDocument(document: ApplicationDocumentRef, edits: readonly ApplicationTextEdit[]): void;
  selectObject(selection: ApplicationObjectSelection): void;
  selectPackage(selection: ApplicationPackageSelection): void;
  selectPlot(selection: ApplicationPlotSelection): Promise<void> | void;
  confirmSave(documentId: string, captured: string, path: string, digest: string): void;
}
export interface ApplicationBridgePorts {
  scope(): RequestContext;
  transport: ApplicationTransport;
  modules: ApplicationModules;
  identity: { windowId: string; incarnation: string; previousSession?: ApplicationBridgeSession };
  registered(session: ApplicationBridgeSession): void;
  reportError(message: string): void;
  now?(): number;
}
export function actionDocument(action: ApplicationAction): ApplicationDocumentRef | null {
  return "document" in action ? action.document : null;
}
