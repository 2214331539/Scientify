import { expect, it } from 'vitest';
import { extractPaper, type PaperJob } from './pdf-text';

const job: PaperJob = {
  id: 'one',
  projectId: 'p1',
  root: 'papers',
  path: 'a.pdf',
  version: 'v1',
  operation: 'read',
  page: 1,
  offset: 0,
  pageCount: 8,
  query: '',
};
const signal = new AbortController().signal;

it('continues a long page without losing text or splitting Unicode characters', async () => {
  const text = 'a'.repeat(23999) + '😀' + 'remaining';
  const first = await extractPaper({ numPages: 1 }, job, async () => text, signal);
  expect(first.pages![0].text).toHaveLength(23999);
  expect(first.nextCursor).toEqual({ page: 1, offset: 23999 });
  const second = await extractPaper(
    { numPages: 1 },
    { ...job, ...first.nextCursor! },
    async () => text,
    signal,
  );
  expect(first.pages![0].text + second.pages![0].text).toBe(text);
  expect(second.truncated).toBe(false);
});

it('continues across page batches and finds text beyond the first 20 pages', async () => {
  const read = await extractPaper({ numPages: 36 }, job, async (page) => `page ${page}`, signal);
  expect(read.pages).toHaveLength(8);
  expect(read.nextCursor).toEqual({ page: 9, offset: 0 });
  const searchJob = { ...job, operation: 'search' as const, query: 'Target.*', pageCount: 20 };
  const text = async (page: number) => (page === 31 ? 'İ 😀 TARGET.* end' : `page ${page}`);
  const first = await extractPaper({ numPages: 36 }, searchJob, text, signal);
  expect(first.matches).toEqual([]);
  expect(first.searchedPages).toHaveLength(20);
  const second = await extractPaper(
    { numPages: 36 },
    { ...searchJob, ...first.nextCursor! },
    text,
    signal,
  );
  expect(second.matches).toEqual([{ page: 31, offset: 5, text: 'İ 😀 TARGET.* end' }]);
  expect(second.nextCursor).toBeNull();
});

it('resumes capped search within the same page without repeating matches', async () => {
  const searchJob = { ...job, operation: 'search' as const, query: 'hit' };
  const text = 'hit '.repeat(24);
  const first = await extractPaper({ numPages: 1 }, searchJob, async () => text, signal);
  expect(first.matches).toHaveLength(20);
  const next = await extractPaper(
    { numPages: 1 },
    { ...searchJob, ...first.nextCursor! },
    async () => text,
    signal,
  );
  expect(next.matches).toHaveLength(4);
  expect(next.matches![0].offset).toBe(80);
  expect(next.truncated).toBe(false);
});

it('reports blank/scanned pages and propagates parsing and cancellation failures', async () => {
  await expect(extractPaper({ numPages: 2 }, job, async () => '  ', signal)).rejects.toThrow('OCR');
  await expect(
    extractPaper({ numPages: 1 }, { ...job, page: 2 }, async () => '', signal),
  ).rejects.toThrow('页码');
  await expect(
    extractPaper(
      { numPages: 1 },
      job,
      async () => {
        throw new Error('corrupt PDF');
      },
      signal,
    ),
  ).rejects.toThrow('corrupt');
  const controller = new AbortController();
  await expect(
    extractPaper(
      { numPages: 2 },
      job,
      async () => {
        controller.abort(new Error('stopped'));
        return 'text';
      },
      controller.signal,
    ),
  ).rejects.toThrow('stopped');
});
