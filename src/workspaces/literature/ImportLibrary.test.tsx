import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportLibrary } from './ImportLibrary';
import type { ImportPreview, ReferenceImport } from '../../platform/reference-import';

afterEach(cleanup);

const preview: ImportPreview = {
  id: 'p1',
  kind: 'zotero',
  location: 'C:/Users/me/Zotero',
  fromBackup: true,
  collections: [
    { id: 'c1', name: 'Robots', parent: null, items: 2 },
    { id: 'c2', name: 'Grasping', parent: 'c1', items: 3 },
    { id: 'c3', name: 'Vision', parent: null, items: 4 },
  ],
  unfiled: 1,
  items: 10,
  pdfs: 8,
  missing: 1,
  notes: 2,
  highlights: 5,
  withoutPdf: 2,
  warnings: [],
  folder: 'Zotero',
};

function api(): ReferenceImport {
  return {
    sources: vi.fn(async () => ({ zotero: ['C:/Users/me/Zotero'] })),
    pick: vi.fn(async () => null),
    preview: vi.fn(async () => preview),
    run: vi.fn(async () => ({
      papers: 6,
      duplicates: 1,
      highlights: 5,
      notes: 2,
      references: 9,
      withoutPdf: 2,
      missing: 1,
      failed: ['Broken：不是有效的 PDF 文件。'],
      cancelled: false,
      folder: 'Zotero',
    })),
    cancel: vi.fn(async () => {}),
    progress: vi.fn(async () => () => {}),
  };
}

it('finds Zotero, previews what comes over and imports the chosen collections', async () => {
  const user = userEvent.setup();
  const fake = api();
  const done = vi.fn();
  render(<ImportLibrary projectId="project" api={fake} onClose={vi.fn()} onDone={done} />);
  await user.click(await screen.findByRole('button', { name: /已找到 C:\/Users\/me\/Zotero/ }));
  expect(fake.preview).toHaveBeenCalledWith('zotero', 'C:/Users/me/Zotero');
  // Counts, notices and the collection tree with totals that include subcollections.
  expect(await screen.findByText('高亮')).toBeTruthy();
  expect(screen.getByText(/读到的是它最近一次的备份/)).toBeTruthy();
  expect(screen.getByText('2 条没有 PDF，只写入 references.bib')).toBeTruthy();
  const robots = screen.getByRole('checkbox', { name: /Robots/ });
  expect(within(robots.closest('label')!).getByText('5')).toBeTruthy();
  // Leaving out a parent leaves out its subcollections.
  await user.click(robots);
  expect((screen.getByRole('checkbox', { name: /Grasping/ }) as HTMLInputElement).checked).toBe(
    false,
  );
  expect((screen.getByRole('checkbox', { name: /全部/ }) as HTMLInputElement).checked).toBe(false);
  await user.clear(screen.getByRole('textbox', { name: '目标文件夹' }));
  await user.type(screen.getByRole('textbox', { name: '目标文件夹' }), 'From Zotero');
  await user.click(screen.getByRole('button', { name: '开始导入' }));
  expect(fake.run).toHaveBeenCalledWith('project', 'p1', expect.any(Array), 'From Zotero');
  const chosen = new Set(vi.mocked(fake.run).mock.calls[0][2]);
  expect(chosen).toEqual(new Set(['', 'c3']));
  expect(await screen.findByText('导入完成')).toBeTruthy();
  expect(screen.getByText('新增论文')).toBeTruthy();
  expect(screen.getByText('1 条没有导入')).toBeTruthy();
  expect(done).toHaveBeenCalled();
});

it('imports everything when nothing is left out, and reads BibTeX or RIS files', async () => {
  const user = userEvent.setup();
  const fake = api();
  vi.mocked(fake.sources).mockResolvedValue({ zotero: [] });
  vi.mocked(fake.pick).mockResolvedValue('D:/export/library.bib');
  render(<ImportLibrary projectId="project" api={fake} onClose={vi.fn()} onDone={vi.fn()} />);
  await waitFor(() => expect(screen.getByText('选择 Zotero 数据文件夹')).toBeTruthy());
  await user.click(screen.getByRole('button', { name: /BibTeX \/ RIS/ }));
  expect(fake.pick).toHaveBeenCalledWith('file');
  expect(fake.preview).toHaveBeenCalledWith('file', 'D:/export/library.bib');
  await user.click(await screen.findByRole('button', { name: '开始导入' }));
  expect(fake.run).toHaveBeenCalledWith('project', 'p1', null, 'Zotero');
});
