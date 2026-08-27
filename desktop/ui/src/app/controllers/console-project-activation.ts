import { useEffect } from "react";

import type { ConsoleExecutionRouter } from "./console-execution-router";
import type { ConsoleExecutionActivation } from "./console-execution-router";

export function useConsoleProjectActivation(
  router: ConsoleExecutionRouter,
  activation: ConsoleExecutionActivation | null,
): void {
  useEffect(() => {
    router.activate(activation);
  }, [activation, router]);
  useEffect(() => () => router.dispose(), [router]);
}
