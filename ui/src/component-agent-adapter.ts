/** Window/project-local recovery copies, separate from native CLI task state. */
export function componentDraftCache(windowId: string) {
  const key = (project: string) => `rho-component-drafts:${JSON.stringify([windowId, project])}`;
  return {
    readLocal(project: string): unknown {
      const value = localStorage.getItem(key(project));
      if (value === null) return null;
      try { return JSON.parse(value); }
      catch { throw new Error("Saved assistant state is unreadable."); }
    },
    writeLocal(project: string, value: unknown): void {
      // Deliberately synchronous: Start waits for durable request identity before dispatch.
      localStorage.setItem(key(project), JSON.stringify(value));
    },
  };
}
