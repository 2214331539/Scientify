import { expect, it } from 'vitest';
import { blockLink, parseBlockLink } from './blockLink';

it('links to a page or one of its blocks, and reads the link back', () => {
  const block = { projectId: 'p1', pageId: 'a1b2', blockId: 'x9' };
  expect(blockLink(block)).toBe('scientify://docs/p1/a1b2#x9');
  expect(parseBlockLink(blockLink(block))).toEqual(block);
  expect(parseBlockLink('scientify://docs/p1/a1b2')).toEqual({ projectId: 'p1', pageId: 'a1b2' });
  expect(parseBlockLink('https://example.org/docs/p1/a1b2')).toBeNull();
});
