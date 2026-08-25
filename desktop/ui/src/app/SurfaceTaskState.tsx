import type { ReactNode } from "react";

type SurfaceTaskStateTone = "loading" | "empty" | "attention" | "error" | "paused";

export function SurfaceTaskState({
  tone,
  title,
  detail,
  role,
  busy = false,
  className = "",
  children,
}: {
  readonly tone: SurfaceTaskStateTone;
  readonly title: string;
  readonly detail: string;
  readonly role?: "status" | "alert";
  readonly busy?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return <section className={`rho-task-state rho-task-state-${tone} ${className}`.trim()} role={role} aria-busy={busy || undefined}>
    {busy && <span className="rho-preparation-spinner" aria-hidden="true" />}
    <div><strong>{title}</strong><p>{detail}</p></div>
    {children != null && <div className="rho-task-state-actions">{children}</div>}
  </section>;
}
