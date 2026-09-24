import { expect, it } from 'vitest';
import type { ObjectScalar } from "../public/r-protocol/index.js";
import type { ObjectMetadata } from "../public/r-protocol/index.js";
import type { ObjectReadPage } from "../public/r-protocol/index.js";
import { completePalette, serializeVector } from '../src/object-vector';
import { functionSignature } from '../src/object-values';
const value = (text: string | null, extra: Partial<ObjectScalar> = {}): ObjectScalar => ({ kind: text === null ? 'missing' : 'value', object_type: 'character', text, number: null, imaginary: null, logical: null, label: null, text_characters: text?.length ?? null, next_text_start: null, ...extra });
const metadata = (extra: Partial<ObjectMetadata> = {}): ObjectMetadata => ({ kind: 'value', object_type: 'character', classes: [], length: 3, dimensions: [], supported_reads: ['values'], attributes: [], notice: null, ...extra });
const data = (values: ObjectScalar[], extra = {}) => ({ values, metadata: metadata({ length: values.length }), objectRef: 'ref', start: 1, ...extra });
it('copies original Unicode strings, duplicate names and missing values without color normalization', () => {
  expect(serializeVector(data([value('green', { color: '#00FF00FF' }), value('NA'), value(null)], { names: [value('处理组'), value('处理组'), value('')] }))).toBe('structure(c("green", "NA", NA_character_), names = c("处理组", "处理组", ""))');
});
it('makes hex conversion explicit and preserves transparency, missing positions and names', () => {
  const d = data([value('green', { color: '#00FF00FF' }), value(null), value('transparent', { color: '#FFFFFF00' })], { names: [value('a'), value('b'), value('c')] });
  expect(serializeVector(d, 'hex-r')).toBe('structure(c("#00FF00FF", NA_character_, "#FFFFFF00"), names = c("a", "b", "c"))');
  expect(serializeVector(d, 'hex-lines')).toBe('#00FF00FF\nNA\n#FFFFFF00');
  expect(() => serializeVector(data([value('red-ish')]), 'hex-r')).toThrow('Value 1');
});
it('rejects shortened strings and output beyond the clipboard budget', () => {
  expect(() => serializeVector(data([value('abc', { next_text_start: 4 })]))).toThrow('shortened');
  expect(() => serializeVector(data([value('界'.repeat(400000))]))).toThrow('1 MiB');
});
it('preserves ordered factor codes and full levels including unused entries', () => {
  const d = data([value(null, { kind: 'factor', object_type: 'integer', number: 2 })], { metadata: metadata({ object_type: 'integer', classes: ['ordered', 'factor'] }), levels: [value('A'), value('B'), value('unused')] });
  expect(serializeVector(d)).toBe('structure(c(2L), levels = c("A", "B", "unused"), class = c("ordered", "factor"))');
  expect(() => serializeVector({ ...d, levels: undefined })).toThrow('levels');
  expect(serializeVector(data([], { metadata: metadata({ object_type: 'double', length: 0 }) }))).toBe('numeric(0)');
});
it('only classifies a fully observed all-color character vector as a palette', () => {
  const m = metadata({ length: 5 });
  const p = { values: Array.from({ length: 4 }, () => value('#123456')), start: 1, next_start: 5 } as ObjectReadPage;
  expect(completePalette(m, p)).toBe(false);
  p.values.push(value('green', { color: '#00FF00FF' })); p.next_start = null;
  expect(completePalette(m, p)).toBe(true);
  p.values[4] = value(null); expect(completePalette(m, p)).toBe(false);
});
it('shows a function signature without its body while preserving nested default expressions', () => {
  expect(functionSignature('function (x, label = ")", transform = c(1, 2))\n{\n x + 1\n}')).toBe('function (x, label = ")", transform = c(1, 2))');
});
