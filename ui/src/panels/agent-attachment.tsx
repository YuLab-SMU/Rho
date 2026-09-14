import { Icon } from "../icons";
import type { AgentAsset } from "../generated/AgentAsset";
import type { AgentAssetPreview } from "../agent-task-ports";

export function AgentAttachment({ asset, preview, onPreview, onRemove }: { asset: AgentAsset; preview?: AgentAssetPreview; onPreview(): void; onRemove?: () => void }) {
  return <div className="at-asset"><button className="at-asset-main" onClick={onPreview}>{asset.mime_type.startsWith("image/") ? preview ? <img src={preview.url} alt={asset.name} /> : <Icon name="image" size={24} /> : <Icon name="file" size={24} />}<span><strong>{asset.name}</strong><small>{Math.max(1,Math.ceil(asset.bytes/1024))} KB</small></span></button>{onRemove && <button className="at-icon" aria-label={`Remove ${asset.name}`} onClick={onRemove}><Icon name="close" size={12} /></button>}</div>;
}
