// Frozen v2 consumer vocabulary at selected entry contract 0.2.0.
// Provider schema parity is checked against each owner's ./contract export.
// Describing an absent provider must not import or activate its package.
import { objectSchema as obj, text, version, refSchema } from '@rho-workspace/plugin-contracts';
export const requirementSchema = obj({ package: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.]*$' }, source: { enum: ['cran', 'bioconductor'] }, minimumVersion: { type: 'string', pattern: '^[0-9]+([.-][0-9]+)*$' } }, ['package', 'source']);
export const requirementsSchema = { type: 'array', items: requirementSchema, maxItems: 64, uniqueItems: true };
export const columnSchema = obj({ name: text, type: { enum: ['string', 'number', 'boolean'] }, nullValues: { type: 'array', items: { type: 'string' }, maxItems: 16 } });
export const tableFormatSchema = obj({ encoding: { enum: ['csv', 'json-rows'] }, columns: { type: 'array', items: columnSchema, minItems: 1, maxItems: 256 }, key: { anyOf: [obj({ column: text, namespace: text }), { type: 'null' }] } });
export const declarationSchema = { oneOf: [
  obj({ path: text, kind: { const: 'file' }, format: obj({ mimeType: text }) }),
  obj({ path: text, kind: { const: 'table' }, format: tableFormatSchema }),
  obj({ path: text, kind: { const: 'media' }, format: obj({ mimeType: { enum: ['image/png', 'image/jpeg', 'image/svg+xml', 'application/pdf'] }, pages: { type: 'integer', minimum: 1 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, ['mimeType']) }),
  obj({ path: text, kind: { const: 'object' }, format: obj({ encoding: { const: 'json' }, observation: { const: 'exported-snapshot' }, classes: { type: 'array', items: text, maxItems: 32 } }) })
] };
export const scriptSchema = { oneOf: [
  obj({ kind: { const: 'disk' }, path: text, digest: version }),
  obj({ kind: { const: 'buffer' }, documentId: version, version: { type: 'integer', minimum: 1 } })
] };
export const executionInputSchema = obj({ script: scriptSchema, args: { type: 'array', maxItems: 64, items: { oneOf: [{ type: 'string', maxLength: 4096 }, obj({ resource: refSchema })] } }, requirements: requirementsSchema, artifacts: { type: 'array', items: declarationSchema, maxItems: 128 }, completion: { anyOf: [text, { type: 'null' }] } });
