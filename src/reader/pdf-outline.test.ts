import { expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  changeHeadingLevel,
  detectHeadings,
  normalizeOutline,
  readPdfOutline,
  visibleHeadings,
  type PdfHeading,
} from './pdf-outline';

it('recognizes numbered sections and filters repeating headers and captions', () => {
  const lines = [1, 2, 3].flatMap((page) => [
    {
      title: 'Journal of Research 2026',
      page,
      x: 50,
      y: 770,
      height: 800,
      size: 14,
      emphasis: false,
    },
    ...Array.from({ length: 12 }, (_, i) => ({
      title: 'A sentence in the ordinary body of this research paper.',
      page,
      x: 50,
      y: 620 - i * 14,
      height: 800,
      size: 10,
      emphasis: false,
    })),
  ]);
  lines.push(
    { title: '1 Introduction', page: 1, x: 50, y: 700, height: 800, size: 13, emphasis: false },
    { title: '1.1 Motivation', page: 1, x: 50, y: 650, height: 800, size: 11, emphasis: false },
    {
      title: 'Figure 1. Example diagram',
      page: 2,
      x: 50,
      y: 400,
      height: 800,
      size: 14,
      emphasis: false,
    },
    { title: 'References', page: 3, x: 50, y: 700, height: 800, size: 12, emphasis: false },
  );
  expect(detectHeadings(lines, 3).map((entry) => [entry.title, entry.level])).toEqual([
    ['1 Introduction', 0],
    ['1.1 Motivation', 1],
    ['References', 0],
  ]);
});

it('resolves nested native bookmarks without extracting any page text', async () => {
  const pdf = {
    numPages: 3,
    getOutline: async () => [
      {
        title: 'Methods',
        dest: 'methods',
        items: [{ title: 'Setup', dest: [2, { name: 'FitH' }, 400], items: [] }],
      },
    ],
    getDestination: vi.fn(async () => [{ num: 12, gen: 0 }, { name: 'XYZ' }, 0, 650, null]),
    getPageIndex: vi.fn(async () => 1),
    getPage: vi.fn(),
  };
  const result = await readPdfOutline(
    pdf as unknown as PDFDocumentProxy,
    new AbortController().signal,
    vi.fn(),
  );
  expect(result.source).toBe('bookmarks');
  expect(result.entries.map((entry) => [entry.title, entry.page, entry.level])).toEqual([
    ['Methods', 2, 0],
    ['Setup', 3, 1],
  ]);
  expect(pdf.getPage).not.toHaveBeenCalled();
});

it('skips a broken bookmark and falls back to the text when the outline itself is damaged', async () => {
  const pdf = {
    numPages: 3,
    getOutline: async () => [
      { title: 'Broken', dest: 'missing', items: [{ title: 'Child', dest: [1], items: [] }] },
      { title: '', dest: [2], items: [] },
      { title: 'Results', dest: [2], items: [] },
    ],
    getDestination: vi.fn(async () => {
      throw new Error('Invalid destination');
    }),
    getPageIndex: vi.fn(),
    getPage: vi.fn(),
  };
  const result = await readPdfOutline(
    pdf as unknown as PDFDocumentProxy,
    new AbortController().signal,
    vi.fn(),
  );
  expect(result.entries.map((entry) => [entry.title, entry.page, entry.level])).toEqual([
    ['Child', 2, 1],
    ['Results', 3, 0],
  ]);

  const damaged = {
    numPages: 1,
    getOutline: async () => {
      throw new Error('Bad outline');
    },
    getPage: async () => ({
      view: [0, 0, 600, 800],
      getTextContent: async () => ({ items: [], styles: {} }),
    }),
  };
  await expect(
    readPdfOutline(damaged as unknown as PDFDocumentProxy, new AbortController().signal, vi.fn()),
  ).resolves.toMatchObject({ source: 'detected', entries: [] });
});

it('keeps stored outlines within the limits the data layer accepts', () => {
  const outline = normalizeOutline({
    version: 1,
    source: 'manual',
    customized: true,
    entries: [
      { id: 'a', title: '  ', page: 1, level: 0 },
      { id: 'b', title: 'x'.repeat(5000), page: 0, level: 40 },
    ],
  });
  expect(outline.entries).toHaveLength(1);
  expect(outline.entries[0]).toMatchObject({ id: 'b', page: 1, level: 5 });
  expect(outline.entries[0].title).toHaveLength(300);
});

it('recognizes capitalized numbered headings at body size but not numbered sentences', () => {
  const body = Array.from({ length: 12 }, (_, i) => ({
    title: 'Ordinary body text that explains the method in a sentence.',
    page: 1,
    x: 50,
    y: 600 - i * 14,
    height: 800,
    size: 10,
    emphasis: false,
  }));
  const lines = [
    { title: 'I. INTRODUCTION', page: 1, x: 50, y: 700, height: 800, size: 10, emphasis: true },
    {
      title: '1. We propose a method',
      page: 1,
      x: 50,
      y: 650,
      height: 800,
      size: 10,
      emphasis: false,
    },
    ...body,
  ];
  expect(detectHeadings(lines, 1).map((entry) => entry.title)).toEqual(['I. INTRODUCTION']);
});

it('cancels extraction between pages and never cleans up a page owned by the renderer', async () => {
  const controller = new AbortController();
  const cleanup = vi.fn();
  const getPage = vi.fn(async () => ({
    view: [0, 0, 600, 800],
    cleanup,
    getTextContent: async () => ({ items: [], styles: {} }),
  }));
  const pdf = { numPages: 10, getOutline: async () => null, getPage };
  await expect(
    readPdfOutline(pdf as unknown as PDFDocumentProxy, controller.signal, () => controller.abort()),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(getPage).toHaveBeenCalledTimes(1);
  expect(cleanup).not.toHaveBeenCalled();
});

it('extracts a title split into text fragments and keeps PDF coordinates', async () => {
  const items = [
    { str: '2', transform: [13, 0, 0, 13, 50, 700], width: 7, height: 13, fontName: 'g_d0_f2' },
    {
      str: 'Methods',
      transform: [13, 0, 0, 13, 64, 700],
      width: 55,
      height: 13,
      fontName: 'g_d0_f2',
    },
    ...Array.from({ length: 10 }, (_, i) => ({
      str: 'Ordinary research text explaining the proposed method.',
      transform: [10, 0, 0, 10, 50, 650 - i * 14],
      width: 250,
      height: 10,
      fontName: 'g_d0_f1',
    })),
  ];
  const pdf = {
    numPages: 1,
    getOutline: async () => null,
    getPage: async () => ({
      view: [0, 0, 600, 800],
      getTextContent: async () => ({ items, styles: {} }),
    }),
  };
  const result = await readPdfOutline(
    pdf as unknown as PDFDocumentProxy,
    new AbortController().signal,
    vi.fn(),
  );
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    title: '2 Methods',
    page: 1,
    level: 0,
    destination: [0, { name: 'XYZ' }, 42, 719.5, null],
  });
});

it('folds subtrees, searches folded titles, and changes a whole subtree depth', () => {
  const entries: PdfHeading[] = [
    { id: 'a', title: 'Introduction', page: 1, level: 0 },
    { id: 'b', title: 'Motivation', page: 2, level: 1 },
    { id: 'c', title: 'Details', page: 2, level: 2 },
    { id: 'd', title: 'Methods', page: 3, level: 0 },
  ];
  expect(visibleHeadings(entries, new Set(['a']), '').map((entry) => entry.id)).toEqual(['a', 'd']);
  expect(visibleHeadings(entries, new Set(['a']), 'details').map((entry) => entry.id)).toEqual([
    'c',
  ]);
  expect(changeHeadingLevel(entries, 'b', -1).map((entry) => entry.level)).toEqual([0, 0, 1, 0]);
  expect(entries[1].level).toBe(1);
  expect(changeHeadingLevel(entries, 'a', 1)).toBe(entries);
});
