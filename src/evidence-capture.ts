import type { Project } from './state.js';
export interface EvidenceSnapshot {
  resource: { id: string; version: string };
  kind: string;
  bytes: number;
  observedAt: string;
  source: {
    kind: string;
    path?: string;
    documentId?: string;
    version?: number;
    dirty?: boolean;
  };
}
export interface CaptureRecord {
  key: string;
  path: string;
  phase: string;
  requestedAt: string;
  state: 'pending' | 'captured' | 'unavailable' | 'interrupted';
  snapshots: EvidenceSnapshot[];
  reason?: string;
}
export interface TurnEvidence {
  records: CaptureRecord[];
  omitted: number;
  bytes: number;
  snapshots: number;
}
export type CapturePort = (
  project: Project,
  path: string,
  remainingBytes: number,
  remainingSnapshots: number
) => Promise<{ snapshots: EvidenceSnapshot[]; reason?: string }>;
export const evidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['records', 'omitted', 'bytes', 'snapshots'],
  properties: {
    records: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'path', 'phase', 'requestedAt', 'state', 'snapshots'],
        properties: {
          key: { type: 'string' },
          path: { type: 'string' },
          phase: { type: 'string' },
          requestedAt: { type: 'string' },
          state: {
            enum: ['pending', 'captured', 'unavailable', 'interrupted']
          },
          reason: { type: 'string' },
          snapshots: {
            type: 'array',
            maxItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['resource', 'kind', 'bytes', 'observedAt', 'source'],
              properties: {
                resource: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    version: { type: 'string', pattern: '^[a-f0-9]{64}$' }
                  },
                  required: ['id', 'version']
                },
                kind: { type: 'string' },
                bytes: { type: 'integer', minimum: 0 },
                observedAt: { type: 'string' },
                source: { type: 'object', additionalProperties: true }
              }
            }
          }
        }
      }
    },
    omitted: { type: 'integer', minimum: 0 },
    bytes: { type: 'integer', minimum: 0 },
    snapshots: { type: 'integer', minimum: 0 }
  }
};

// Known connection/authentication locations are not default evidence. Selected file
// contents are never silently edited; callers can still capture an explicit file.
export const privateEvidencePath = (value: string) =>
  value
    .replace(/\\/g, '/')
    .split('/')
    .some((p) => ['.claude', '.codex', '.ssh', '.aws'].includes(p)) ||
  /(^|\/)(?:\.env(?:\..*)?|\.?mcp\.json|connection\.json|credentials\.json|auth\.json|id_rsa|id_ed25519)$/i.test(
    value
  );
