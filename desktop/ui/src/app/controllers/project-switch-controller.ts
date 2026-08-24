import type { ProjectSwitchResponse, ProjectSwitchStatus } from "../../transport";
import { projectLabel } from "../../transport/normalize";
import { workbenchFailureMessage } from "../workbench-failure";
import { workbenchOperationTrace } from "../operation-trace";

export interface ProjectSwitchLifecycle {
  readonly start: (targetPath: string | null) => void;
  readonly accept: (response: ProjectSwitchResponse) => Promise<void>;
  readonly refreshRestored: () => Promise<void>;
  readonly report: (message: string | null) => void;
  readonly finish: () => void;
}

export function projectSwitchFailure(
  response: ProjectSwitchResponse,
  targetPath: string | null,
): string | null {
  const target = targetPath == null ? "the selected folder" : projectLabel(targetPath);
  switch (response.status) {
    case "ready":
    case "cancelled":
      return null;
    case "blocked":
      return response.blocker?.message ?? response.message ?? `Finish active work before switching to ${target}.`;
    case "unavailable":
      return response.unavailable == null
        ? `${target} is unavailable.`
        : `${projectLabel(response.unavailable.path)} is unavailable: ${response.unavailable.reason}`;
    case "failed_restored":
      return `${target} could not be opened. Rho restored ${response.restored_root == null ? "the previous project" : projectLabel(response.restored_root)}. ${response.message ?? "You can retry or choose another folder."}`;
    case "fatal":
      return `${target} could not be opened and project recovery did not complete. ${response.message ?? "Restart Rho before continuing."}`;
  }
}

export class ProjectSwitchController {
  #inFlight = false;

  async perform(
    operation: () => Promise<ProjectSwitchResponse>,
    targetPath: string | null,
    lifecycle: ProjectSwitchLifecycle,
  ): Promise<ProjectSwitchStatus | "ignored"> {
    if (this.#inFlight) return "ignored";
    this.#inFlight = true;
    try {
      lifecycle.start(targetPath);
      lifecycle.report(null);
      const response = await workbenchOperationTrace.run(
        "project.switch",
        operation,
        { fallback: "The project could not be switched.", scope: "inline" },
      );
      if (response.status === "ready") await lifecycle.accept(response);
      else {
        if (response.status === "failed_restored") await lifecycle.refreshRestored();
        lifecycle.report(projectSwitchFailure(response, targetPath));
      }
      return response.status;
    } catch (cause) {
      lifecycle.report(workbenchFailureMessage(
        cause,
        "The project could not be switched. The current project remains open.",
      ));
      return "fatal";
    } finally {
      this.#inFlight = false;
      lifecycle.finish();
    }
  }
}
