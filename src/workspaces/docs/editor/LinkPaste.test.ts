import { expect, it } from 'vitest';
import { isLink } from './LinkPaste';

it('offers link choices only for a lone web address', () => {
  expect(isLink('https://arxiv.org/abs/1706.03762')).toBe(true);
  expect(isLink('  http://example.com/a?b=1  ')).toBe(true);
  expect(isLink('see https://example.com')).toBe(false);
  expect(isLink('ftp://example.com')).toBe(false);
});
