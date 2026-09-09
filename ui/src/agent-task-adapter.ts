import type { AgentAssetPreview } from "./agent-task-ports";
export function taskDraftCache(windowId: string) {
  const key = (project: string) => `rho-agent-drafts:${windowId}:${project}`;
  return {
    readLocal(project: string): unknown { try { return JSON.parse(localStorage.getItem(key(project)) ?? "null"); } catch { return null; } },
    writeLocal(project: string, value: unknown) { localStorage.setItem(key(project), JSON.stringify(value)); },
  };
}
export async function previewAgentAsset(blob: Blob): Promise<AgentAssetPreview> {
  return { url: URL.createObjectURL(blob), text: blob.type.startsWith("image/") ? null : await blob.slice(0, 16384).text() };
}
export const releaseAgentAsset = (url: string) => URL.revokeObjectURL(url);
export async function encodeAgentFile(file: File): Promise<string> {
  if (file.size > 8 * 1024 * 1024) throw new Error("Attachments are limited to 8 MiB each.");
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
