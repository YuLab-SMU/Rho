import { useId } from "react";
import type { ReactNode } from "react";

import type {
  VibeCorrespondence,
  VibeLayoutMode,
  VibeRegionRole,
} from "./vibe/core/vibe-workspace-model";

interface VibeWorkspaceProps {
  readonly label: string;
  readonly layoutMode: VibeLayoutMode;
  readonly activeRegion: VibeRegionRole;
  readonly correspondence: VibeCorrespondence;
  readonly manuscript: ReactNode;
  readonly exploration: ReactNode;
  readonly verification: ReactNode;
  readonly footer?: ReactNode;
  readonly onActivateRegion: (region: VibeRegionRole) => void;
  readonly onShowOverview: () => void;
}

const REGION_COPY: Record<VibeRegionRole, { readonly title: string; readonly subtitle: string }> = {
  manuscript: { title: "手稿", subtitle: "问题、方法与边界" },
  exploration: { title: "自主探索", subtitle: "Agent 的当前工作" },
  verification: { title: "查验与结论", subtitle: "产物、检查与措辞边界" },
};

function RegionFrame({
  role,
  activeRegion,
  layoutMode,
  titleId,
  onActivate,
  children,
}: {
  readonly role: VibeRegionRole;
  readonly activeRegion: VibeRegionRole;
  readonly layoutMode: VibeLayoutMode;
  readonly titleId: string;
  readonly onActivate: () => void;
  readonly children: ReactNode;
}) {
  const copy = REGION_COPY[role];
  const focused = layoutMode === `focus-${role}`;
  return (
    <section
      className="rho-vibe-region"
      data-region={role}
      data-active={String(activeRegion === role)}
      data-focused={String(focused)}
      aria-labelledby={titleId}
    >
      <header className="rho-vibe-region-header">
        <button
          type="button"
          className="rho-vibe-region-focus"
          aria-pressed={focused}
          onClick={onActivate}
        >
          <strong id={titleId}>{copy.title}</strong>
          <span>{copy.subtitle}</span>
        </button>
      </header>
      <div className="rho-vibe-region-body">{children}</div>
    </section>
  );
}

export function VibeWorkspace({
  label,
  layoutMode,
  activeRegion,
  correspondence,
  manuscript,
  exploration,
  verification,
  footer,
  onActivateRegion,
  onShowOverview,
}: VibeWorkspaceProps) {
  const id = useId();
  return (
    <article
      className="rho-vibe-workspace"
      data-layout={layoutMode}
      data-active-region={activeRegion}
      aria-label={`${label} Vibe workspace`}
    >
      <header className="rho-vibe-workspace-header">
        <div className="rho-vibe-workspace-identity">
          <span className="rho-eyebrow">Vibe</span>
          <h1>{label}</h1>
        </div>
        <nav className="rho-vibe-region-switcher" aria-label="Vibe information layer">
          {(["manuscript", "exploration", "verification"] as const).map((role) => (
            <button
              type="button"
              aria-pressed={activeRegion === role}
              onClick={() => onActivateRegion(role)}
              key={role}
            >
              {REGION_COPY[role].title}
            </button>
          ))}
          <button
            type="button"
            className="rho-vibe-overview-action"
            aria-pressed={layoutMode === "overview"}
            onClick={onShowOverview}
          >三联总览</button>
        </nav>
      </header>

      <div className="rho-vibe-regions">
        <RegionFrame
          role="manuscript"
          activeRegion={activeRegion}
          layoutMode={layoutMode}
          titleId={`${id}-manuscript`}
          onActivate={() => onActivateRegion("manuscript")}
        >{manuscript}</RegionFrame>
        <RegionFrame
          role="exploration"
          activeRegion={activeRegion}
          layoutMode={layoutMode}
          titleId={`${id}-exploration`}
          onActivate={() => onActivateRegion("exploration")}
        >{exploration}</RegionFrame>
        <RegionFrame
          role="verification"
          activeRegion={activeRegion}
          layoutMode={layoutMode}
          titleId={`${id}-verification`}
          onActivate={() => onActivateRegion("verification")}
        >{verification}</RegionFrame>
      </div>

      <aside
        className="rho-vibe-correspondence"
        data-linked={String(correspondence.hasExactLink)}
        aria-label="当前对应关系"
      >
        <strong>当前对应</strong>
        <span>{correspondence.summary}</span>
        {correspondence.steps.length > 0 && (
          <ol aria-label="当前对应路径">
            {correspondence.steps.map((step) => (
              <li data-region={step.role} key={`${step.role}:${step.label}`}>
                <span>{step.label}</span>
                <small>{step.detail}</small>
              </li>
            ))}
          </ol>
        )}
      </aside>

      {footer != null && <footer className="rho-vibe-workspace-footer">{footer}</footer>}
    </article>
  );
}
