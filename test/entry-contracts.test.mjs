import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declarationSchema as file } from '@rho-workspace/plugin-files/contract';
import { declarationSchema as table } from '@rho-workspace/plugin-tables/contract';
import { declarationSchema as media } from '@rho-workspace/plugin-media/contract';
import { declarationSchema as object, createExecutionInputSchema } from '@rho-workspace/plugin-r/contract';
import { requirementsSchema } from '@rho-workspace/plugin-requirements/contract';
import { documentSummarySchema as ownerSummary } from '@rho-workspace/plugin-documents/contract';
import { documentSummarySchema as wireSummary } from '../dist/document-contract.js';
import * as frozen from '../dist/entry-contracts.js';

test('the retained v2 wire vocabulary matches owner contracts without centralizing their implementations', () => {
  assert.deepEqual(wireSummary, ownerSummary);
  const declarations = { oneOf: [file, table, media, object] };
  assert.deepEqual(frozen.declarationSchema, declarations);
  assert.deepEqual(frozen.requirementsSchema, requirementsSchema);
  assert.deepEqual(frozen.executionInputSchema, createExecutionInputSchema(declarations, requirementsSchema));
});
