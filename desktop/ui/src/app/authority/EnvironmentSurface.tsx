import type { SurfaceInstance } from "../../transport";
import type { AuthorityEnvironmentPort } from "../workbench/authorityPorts";
import { EnvironmentHealthPanel } from "./EnvironmentHealthPanel";

export function EnvironmentSurface({ instance, transport, reportError }: {
  readonly instance: SurfaceInstance;
  readonly transport: AuthorityEnvironmentPort;
  readonly reportError: (error: unknown) => void;
}) {
  const mode = instance.mode_id === "plans" || instance.mode_id === "activity"
    ? instance.mode_id
    : "health";
  return <EnvironmentHealthPanel
    transport={transport}
    mode={mode}
    reportError={reportError}
  />;
}
