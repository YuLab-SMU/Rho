import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { UiKernelTransport } from "../transport";
import { defaultTransport, WorkbenchApp } from "./WorkbenchApp";
import {
  createStartupController,
  StartupLedgerView,
  type StartupRecoveryAction,
} from "./startup";

export interface AppProps {
  readonly transport?: UiKernelTransport;
}

export function App({ transport }: AppProps) {
  const resolvedTransport = transport ?? defaultTransport;
  const controller = useMemo(
    () => createStartupController(resolvedTransport),
    [resolvedTransport],
  );
  const preparation = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    return controller.connect();
  }, [controller]);

  useEffect(() => {
    if (preparation.status !== "ready") {
      document.documentElement.dataset.rsrReady = "false";
    }
  }, [preparation.status]);

  if (preparation.status === "ready") {
    return <WorkbenchApp transport={resolvedTransport} />;
  }

  const recoveryAction: StartupRecoveryAction | null = preparation.recovery === "choose_project"
    ? { kind: "choose_project", onChoose: controller.chooseProject }
    : preparation.recovery === "choose_rscript"
      ? { kind: "choose_rscript", onChoose: controller.chooseRscript }
      : null;
  return <StartupLedgerView
    ledger={preparation.ledger}
    issue={preparation.issue}
    recoveryAction={recoveryAction}
    onRetry={controller.retry}
    startedAtMs={preparation.startedAtMs}
    admissionPending={preparation.status === "preparing"}
    focusRequest={preparation.focusRequest}
    focusTarget={preparation.focusTarget}
  />;
}
