import { useEffect, useState } from "react";

import type { UiKernelTransport } from "../transport/types";

export function PlotThumbnail({ plotId, transport, className = "rho-domain-output-image" }: {
  readonly plotId: string;
  readonly transport: UiKernelTransport;
  readonly className?: string;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setFailed(false);
    transport.readPlotArtifact(plotId)
      .then((view) => {
        if (!cancelled) setSource(`data:${view.media_type};base64,${view.data_base64}`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [plotId, transport]);
  if (source != null) {
    return <img className={className} src={source} alt="" loading="lazy" />;
  }
  return <div className="rho-domain-output-preview" aria-hidden="true">
    <span>{failed ? "Preview unavailable" : "Plot"}</span>
  </div>;
}
