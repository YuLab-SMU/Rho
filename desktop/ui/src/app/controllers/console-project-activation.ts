import { useEffect } from "react";

import type { ConsoleExecutionRouter } from "./console-execution-router";

export function useConsoleProjectActivation(
  router: ConsoleExecutionRouter,
  projectId: string | null,
): void {
  useEffect(() => {
    router.activateProject(projectId);
  }, [projectId, router]);
  useEffect(() => () => router.dispose(), [router]);
}
