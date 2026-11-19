import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LibraryTable, byline } from './LibraryTable';
import type { LibraryEntry, LibraryPaper } from '../../platform/library';

afterEach(cleanup);

const entries: LibraryEntry[] = [
  {
    path: 'Zotero/a.pdf',
    name: 'a.pdf',
    directory: false,
    pdf: true,
    note: false,
    size: 2048,
    paperId: 'p1',
  },
  {
    path: 'b.pdf',
    name: 'b.pdf',
    directory: false,
    pdf: true,
    note: false,
    size: 2048,
    paperId: 'p2',
  },
];
const papers: LibraryPaper[] = [
  { id: 'p1', path: 'Zotero/a.pdf', notePath: 'Zotero/a.notes.md', fingerprint: 'f1' },
  { id: 'p2', path: 'b.pdf', notePath: 'b.notes.md', fingerprint: 'f2' },
];
const events = {
  onContextMenu: vi.fn(),
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
  onDragOver: vi.fn(),
  onDragLeave: vi.fn(),
  onDrop: vi.fn(),
  onKeyDown: vi.fn(),
};

function table(query = '') {
  return (
    <LibraryTable
      root="D:/Papers"
      entries={entries}
      papers={papers}
      folder=""
      query={query}
      selected=""
      busy={false}
      readOnly={false}
      importing=""
      onSelect={vi.fn()}
      onOpen={vi.fn()}
      onChoose={vi.fn()}
      onImport={vi.fn()}
      onImportLibrary={vi.fn()}
      references={{
        f1: {
          title: 'Attention Is All You Need',
          authors: ['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki'],
          year: '2017',
          venue: 'NeurIPS',
        },
      }}
      fileEvents={events}
    />
  );
}

it('shows imported papers by title, authors and year, and finds them by author', () => {
  const view = render(table());
  expect(screen.getByText('Attention Is All You Need')).toBeTruthy();
  expect(screen.getByText('Vaswani, Shazeer 等 · NeurIPS · 2017')).toBeTruthy();
  // A PDF no reference manager knew keeps its file name.
  expect(screen.getByText('b')).toBeTruthy();
  view.rerender(table('parmar'));
  expect(screen.getByText('Attention Is All You Need')).toBeTruthy();
  expect(screen.queryByText('b')).toBeNull();
  expect(screen.getByRole('button', { name: /从 Zotero 导入/ })).toBeTruthy();
});

it('writes short bylines', () => {
  expect(byline({ authors: ['Li, Wei'], year: '2020' })).toBe('Li · 2020');
  expect(byline({ authors: ['OpenAI'] })).toBe('OpenAI');
});
