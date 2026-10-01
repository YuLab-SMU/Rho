import type { AgentAsset } from '../sdk/index.js';
import type { InstanceRef } from '../public/plugin-protocol/index.js';
import { same } from './operations.js';
export interface RhoUpload { request_id: string; conversation_id: string; name: string; mime_type: string; bytes: number; sha256: string; }
export interface RhoPendingUpload { upload: RhoUpload; view: string; instance: InstanceRef; received: number; phase: 'uploading' | 'finishing' | 'imported'; }
export interface RhoImported { conversation_id: string; asset: AgentAsset; }
export function validateUpload(upload: RhoUpload) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(upload.request_id) || !upload.conversation_id || upload.conversation_id.length > 160 ||
    !upload.name || new TextEncoder().encode(upload.name).length > 240 || /[\u0000-\u001f\u007f-\u009f/\\]/.test(upload.name) ||
    !['text/plain', 'image/png', 'image/jpeg'].includes(upload.mime_type) || !Number.isSafeInteger(upload.bytes) || upload.bytes < 0 ||
    upload.bytes > (upload.mime_type === 'text/plain' ? 32768 : 2097152) || !/^[0-9a-f]{64}$/.test(upload.sha256))
    throw Error('Rho attachments require UTF-8 text up to 32 KiB, or PNG/JPEG up to 2 MiB.');
}
export async function captureRhoFile(file: Blob, name: string, task: string, request: string = crypto.randomUUID()) {
  const image = file.type === 'image/png' || file.type === 'image/jpeg';
  const upload: RhoUpload = { request_id: request, conversation_id: task, name, mime_type: image ? file.type : 'text/plain', bytes: file.size, sha256: '0'.repeat(64) };
  validateUpload(upload);
  const blob = new Blob([file], { type: upload.mime_type }), bytes = new Uint8Array(await blob.arrayBuffer());
  if (!image) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw Error('Text attachments must use UTF-8.'); }
    if (bytes.includes(0)) throw Error('Binary files are not supported as Rho text attachments.');
  }
  upload.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  return { upload, blob };
}
export function verifyRhoImported(upload: RhoUpload, result: RhoImported) {
  if (result?.conversation_id !== upload.conversation_id || !same(result.asset, {
    asset_id: upload.request_id, name: upload.name, mime_type: upload.mime_type, bytes: upload.bytes, sha256: upload.sha256,
  })) throw Error('The original Rho attachment is not confirmed with the selected file identity.');
  return result.asset;
}
