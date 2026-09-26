import { Files as PluginFiles } from "../../plugins/files/src/files";
import type { ResourcePorts } from "./resource-ports";
import type { OperationChange } from "./shared/events";

/** Retiring composition adapter. The directory/search state has one owner in
 * the Files package; this adapter only translates the old Host capability edge. */
export class Files extends PluginFiles {
  constructor(ports: ResourcePorts) {
    super({
      context: () => ({ ...ports.context(), capabilities: ports.context().capabilities.map(id => id.replace(/^project\./, "files.")) }),
      query: (project, capability, args) => ports.query(project, capability.replace(/^files\./, "project."), args),
      schedule: () => ports.schedule(), changed: () => ports.changed(),
    });
  }
  override operationChanged(event: OperationChange) {
    if (event.capability.startsWith("workspace.") || event.capability.startsWith("project."))
      super.operationChanged({ ...event, capability: "files.changed" });
  }
}
