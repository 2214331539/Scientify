import { beforeEach, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_command: string, args: { content: string | null }) => {
    if (args.content !== null) saved.calls.push(args.content);
    return args.content;
  }),
}));

import {
  chunks,
  paperOfTab,
  readablePage,
  translatePaper,
  translationJobs,
  translationTab,
} from './paper-translation';

beforeEach(() => {
  saved.calls = [];
});

it('turns a PDF page into prose and cuts it at sentences', () => {
  expect(readablePage('Deep learn-\ning works.\nIt is\nfast.\n\nNext para.')).toBe(
    'Deep learning works. It is fast.\n\nNext para.',
  );
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} ends here.`).join(' ');
  const pieces = chunks(text, 200);
  expect(pieces.length).toBeGreaterThan(5);
  expect(pieces.every((piece) => piece.length <= 200)).toBe(true);
  expect(pieces.every((piece) => piece.endsWith('.'))).toBe(true);
  expect(pieces.join(' ')).toBe(text);
});

it('names translation tabs by their paper', () => {
  expect(paperOfTab(translationTab('p1'))).toBe('p1');
  expect(paperOfTab('p1')).toBe('p1');
});

it('translates every page in order, saving as it goes, with links back to the pages', async () => {
  const ask = vi.fn(
    async ({ messages }: { messages: { content: unknown }[] }) =>
      `译：${String(messages[1].content)}`,
  );
  await translatePaper({
    projectId: 'proj',
    paperId: 'paper',
    title: '论文（全文翻译）',
    pages: ['First page text.', '', 'Third page text.'],
    ask,
    language: '简体中文',
    note: 'note',
    pageLabel: (page) => `第 ${page} 页`,
    pending: '（未翻译）',
    parallel: 2,
  });
  const job = translationJobs.get('proj', 'paper');
  expect(job.running).toBe(false);
  expect(job.done).toBe(2);
  expect(job.error).toBe('');
  expect(job.content).toContain('## [第 1 页](scientify-page:1)');
  expect(job.content).toContain('译：First page text.');
  expect(job.content).toContain('## [第 3 页](scientify-page:3)');
  expect(job.content).not.toContain('第 2 页');
  expect(job.content).not.toContain('（未翻译）');
  expect(saved.calls.at(-1)).toBe(job.content);
});

it('stops at the first failure and keeps what was translated', async () => {
  const ask = vi.fn().mockResolvedValueOnce('第一段').mockRejectedValueOnce(new Error('额度用完'));
  await translatePaper({
    projectId: 'proj',
    paperId: 'failing',
    title: 't',
    pages: ['One.', 'Two.', 'Three.'],
    ask,
    language: '简体中文',
    note: 'note',
    pageLabel: (page) => `p${page}`,
    pending: '（未翻译）',
    parallel: 1,
  });
  const job = translationJobs.get('proj', 'failing');
  expect(job.error).toBe('额度用完');
  expect(job.content).toContain('第一段');
  expect(job.content).toContain('（未翻译）');
  expect(ask).toHaveBeenCalledTimes(2);
});
