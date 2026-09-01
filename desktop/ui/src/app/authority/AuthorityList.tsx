import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { SurfaceTaskState } from "../SurfaceTaskState";
import { workbenchFailureMessage } from "../workbench-failure";

export function AuthorityList<T>({ title, load, empty, render }: {
  readonly title: string;
  readonly load: () => Promise<readonly T[]>;
  readonly empty: string;
  readonly render: (item: T) => ReactNode;
}) {
  const [items, setItems] = useState<readonly T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setItems(await load());
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, title + " Authority projection could not be loaded."));
    }
  }, [load, title]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (error != null) {
    return <SurfaceTaskState tone="error" title={title + " Authority unavailable"} detail={error} role="alert">
      <button type="button" onClick={() => void refresh()}>Try again</button>
    </SurfaceTaskState>;
  }
  if (items == null) {
    return <SurfaceTaskState
      tone="loading"
      title={"Loading " + title.toLowerCase() + "…"}
      detail="Reading the owning Authority projection."
      role="status"
      busy
    />;
  }
  return <section className="rho-authority-surface">
    <header><strong>{title}</strong><button type="button" onClick={() => void refresh()}>Refresh</button></header>
    {items.length === 0
      ? <SurfaceTaskState tone="empty" title={"No " + title.toLowerCase()} detail={empty} role="status" />
      : <div className="rho-authority-records">{items.map(render)}</div>}
  </section>;
}
