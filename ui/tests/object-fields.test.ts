import { expect, it } from 'vitest';
import { defaultFields, normalizeFields, moveField, fieldTemplate } from '../src/object-fields';
it('keeps the name fixed and restores only valid, bounded field preferences', () => {
  expect(normalizeFields(null)).toEqual(defaultFields());
  const config = normalizeFields({ order: ['type', 'name', 'type'], hidden: ['name', 'content'], widths: { name: 2, content: 5000, type: NaN } });
  expect(config).toEqual({ order: ['type', 'content', 'size'], hidden: ['content'], widths: { name: 120, content: 1000 } });
  expect(fieldTemplate(config)).toBe('120px 148px 220px 24px');
  expect(moveField(config, 'size', 'type').order).toEqual(['size', 'type', 'content']);
});
