import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineMarkdown, markdownBlocks, safeHref } from '../dist/agent-markdown.js';

test('inline Markdown keeps meaning without raw HTML: strong, emphasis, code and breaks', () => {
  const nodes = inlineMarkdown('**bold** and `x <- 1` and _slow_\nnext');
  assert.deepEqual(nodes.map(n => n.type), ['strong', 'text', 'code', 'text', 'em', 'break', 'text']);
  assert.equal(nodes[0].children[0].text, 'bold');
  assert.equal(nodes[2].text, 'x <- 1');
  assert.equal(nodes[4].children[0].text, 'slow');
  // An identifier is not emphasis.
  assert.deepEqual(inlineMarkdown('gene_name and p_value').map(n => n.type), ['text']);
  // HTML is text, never a node type we would render as markup.
  const html = inlineMarkdown('<script>alert(1)</script>');
  assert.equal(html.length, 1); assert.equal(html[0].type, 'text');
});

test('links are limited to explicit http(s)/mailto targets', () => {
  assert.equal(safeHref('https://example.org/a'), 'https://example.org/a');
  assert.equal(safeHref('mailto:person@example.org'), 'mailto:person@example.org');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.deepEqual(inlineMarkdown('[site](javascript:alert(1))'), [{ type: 'text', text: 'site' }]);
  const link = inlineMarkdown('[the **result**](https://example.org/r)');
  assert.equal(link[0].type, 'link'); assert.equal(link[0].href, 'https://example.org/r');
  assert.equal(link[0].children[1].type, 'strong');
});

test('blocks keep paragraphs, headings, lists, quotes and fenced code', () => {
  const blocks = markdownBlocks('# Findings\n\nFirst line\nsecond line\n\n- alpha\n- beta\n\n1. inspect\n2. check\n\n> quoted 你好\n\n```r\nx <- 1\n```\n\n---');
  assert.deepEqual(blocks.map(b => b.type), ['heading', 'paragraph', 'list', 'list', 'quote', 'code', 'rule']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].children.filter(n => n.type === 'break').length, 1);
  assert.deepEqual(blocks[2].items.map(item => item[0].text), ['alpha', 'beta']);
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[5].language, 'r'); assert.equal(blocks[5].text, 'x <- 1');
});

test('an unclosed fence renders as code while it streams, never as raw backticks', () => {
  const blocks = markdownBlocks('Reading the data.\n\n```python\nprint("你好")');
  assert.equal(blocks.length, 2); assert.equal(blocks[1].type, 'code');
  assert.equal(blocks[1].text, 'print("你好")');
});

test('inline code is literal and Unicode is preserved', () => {
  const nodes = inlineMarkdown('Use `a ** b` then say 你好');
  const code = nodes.find(node => node.type === 'code');
  assert.equal(code.text, 'a ** b');
  assert.match(nodes.map(n => n.text ?? '').join(''), /你好/);
});

test('a table after a line of prose is a table, with its alignment, code spans holding pipes and short rows filled', () => {
  const blocks = markdownBlocks('Means by month:\n| Month | Mean | `a|b` |\n|---|--:|:-:|\n| May | 23.6 |\n| Jun | 29.4 | x |\nAfter.');
  assert.deepEqual(blocks.map(b => b.type), ['paragraph', 'table', 'paragraph']);
  const table = blocks[1];
  assert.deepEqual(table.align, [null, 'right', 'center']);
  assert.deepEqual(table.head.map(c => c.map(n => n.text).join('')), ['Month', 'Mean', 'a|b']);
  assert.deepEqual(table.rows.map(r => r.map(c => c.map(n => n.text ?? '').join(''))), [['May', '23.6', ''], ['Jun', '29.4', 'x']]);
  assert.deepEqual(markdownBlocks('a | b\nnot a delimiter').map(b => b.type), ['paragraph'], 'pipes alone are prose');
});
