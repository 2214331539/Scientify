import { expect, it } from 'vitest';
import { closePaperTab, openPaperTab, restorePaperTabs, type LiteratureSession } from './tabs';

it('reuses an open paper and fills an active blank page without duplicating it', () => {
  const blank: LiteratureSession = { tabs: [{ id: 'blank', paperId: null }], activeId: 'blank' };
  const first = openPaperTab(blank, 'p1');
  expect(first.tabs).toEqual([{ id: 'blank', paperId: 'p1' }]);
  const second = openPaperTab(first, 'p2');
  const returned = openPaperTab(second, 'p1');
  expect(returned.tabs).toHaveLength(2);
  expect(returned.activeId).toBe('blank');
  expect(openPaperTab(returned, 'p1')).toBe(returned);
});

it('selects a neighbor only when closing the active tab and never deletes a paper', () => {
  const session = {
    tabs: [
      { id: 'a', paperId: 'p1' },
      { id: 'b', paperId: 'p2' },
      { id: 'c', paperId: 'p3' },
    ],
    activeId: 'b',
  };
  expect(closePaperTab(session, 'a').activeId).toBe('b');
  const closed = closePaperTab(session, 'b');
  expect(closed.activeId).toBe('c');
  expect(closePaperTab(closePaperTab(closed, 'c'), 'a')).toEqual({ tabs: [], activeId: null });
});

it('drops invalid, duplicate and foreign project preferences and honors an external paper target', () => {
  const stored = {
    tabs: [
      null,
      { id: 'a', paperId: 'p1' },
      { id: 'a', paperId: 'p2' },
      { id: 'b', paperId: 'p1' },
      { id: 'c', paperId: 'foreign' },
      { id: 'blank', paperId: null },
    ],
    activeId: 'missing',
  } as unknown as LiteratureSession;
  const result = restorePaperTabs(stored, new Set(['p1', 'p2']), 'p2');
  expect(result).toEqual({
    tabs: [
      { id: 'a', paperId: 'p1' },
      { id: 'blank', paperId: 'p2' },
    ],
    activeId: 'blank',
  });
  expect(restorePaperTabs(undefined, new Set(), null)).toEqual({ tabs: [], activeId: null });
});
