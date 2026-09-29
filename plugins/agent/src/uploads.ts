import type { AgentTaskControl, AgentTaskCommandResult, AgentAsset } from '../sdk/index.js';
import type { InstanceRef } from '../public/plugin-protocol/index.js';
import { same } from './operations.js';
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024, ATTACHMENT_CHUNK_BYTES = 64 * 1024;
export interface Upload { request_id: string; control: AgentTaskControl; name: string; mime_type: string; bytes: number; sha256: string; }
export interface PendingUpload { upload: Upload; view: string; instance: InstanceRef; received: number; phase: 'uploading' | 'finishing' | 'imported'; }
export interface UploadProgress { upload: Upload; received: number; complete: boolean; }
export async function captureFile(file: Blob, name: string, control: AgentTaskControl, request: string = crypto.randomUUID()): Promise<{ upload: Upload; blob: Blob }> {
  if (file.size > MAX_ATTACHMENT_BYTES || !Number.isSafeInteger(file.size)) throw Error('Attachments are limited to 8 MiB each.');
  if (!name || new TextEncoder().encode(name).length > 240 || /[\u0000-\u001f\u007f/\\]/.test(name)) throw Error('The attachment filename is invalid or too long.');
  const blob = new Blob([file], { type: file.type || 'application/octet-stream' });
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join('');
  return { blob, upload: { request_id: request, control: structuredClone(control), name, mime_type: blob.type, bytes: blob.size, sha256 } };
}
export async function attachmentChunk(blob: Blob, offset: number): Promise<string> {
  const bytes = new Uint8Array(await blob.slice(offset, offset + ATTACHMENT_CHUNK_BYTES).arrayBuffer());
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += 8192) parts.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
  return btoa(parts.join(''));
}
export function verifyProgress(value: UploadProgress, upload: Upload, minimum: number) {
  if (!value || !same(value.upload, upload) || !Number.isSafeInteger(value.received) || value.received < minimum || value.received > upload.bytes || value.complete !== (value.received === upload.bytes))
    throw Error('The attachment acknowledgement differs from the original file.');
}
export function verifyUploaded(upload: Upload, result: AgentTaskCommandResult): AgentAsset {
  const receipt = result?.receipt, asset = result?.detail?.assets.find(item => item.asset_id === upload.request_id);
  if (receipt?.request_id !== upload.request_id || receipt.task_id !== upload.control.task_id || receipt.command !== 'add_asset' || receipt.status !== 'succeeded' ||
    result.detail.summary.task.task_id !== upload.control.task_id || !asset || asset.name !== upload.name || asset.mime_type !== upload.mime_type || asset.bytes !== upload.bytes || asset.sha256 !== upload.sha256)
    throw Error('The original attachment is not confirmed with the selected file identity.');
  return asset;
}
