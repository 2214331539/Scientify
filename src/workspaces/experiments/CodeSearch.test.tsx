import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchQuery } from '@codemirror/search';
import type { ResearchBackend } from '../../platform/research';
import { getFileSession } from '../../editor/sessions';
import { CodeSearch, fileMatches } from './CodeSearch';
afterEach(cleanup);
function backend(): ResearchBackend {
  return {
    listFiles: vi.fn(async () => [
      { path: 'train.py', name: 'train.py', kind: 'file' as const, size: 30 },
    ]),
    readFile: vi.fn(async (_id, path) => ({ path, content: 'needle = 1\n', version: 'v1' })),
    writeFile: vi.fn(),
    importPdf: vi.fn(),
    readPdf: vi.fn(),
    gitStatus: vi.fn(),
    askAI: vi.fn(),
    listModels: vi.fn(),
    testModel: vi.fn(),
    fetchArxiv: vi.fn(),
  };
}
function submit(text: string) {
  fireEvent.change(screen.getByLabelText('搜索工作区内容'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
}
it('uses the editor search engine for case, whole words, regex and original offsets', () => {
  const text = '模型\nSeed seedling SEED\nseed=42';
  const query = new SearchQuery({ search: 'seed', wholeWord: true, caseSensitive: false });
  const hits = fileMatches(text, 'train.py', query);
  expect(hits.map((hit) => hit.line)).toEqual([2, 2, 3]);
  for (const hit of hits) expect(text.slice(hit.from, hit.to).toLowerCase()).toBe('seed');
  expect(
    fileMatches(text, 'train.py', new SearchQuery({ search: 'seed=\\d+', regexp: true }))[0],
  ).toMatchObject({ line: 3 });
  expect(fileMatches('seed seed seed', 'train.py', query, 2)).toHaveLength(2);
});
it('Windows line endings use the same offsets as the editor', () => {
  const hits = fileMatches(
    'one\r\nneedle\r\nthree',
    'windows.py',
    new SearchQuery({ search: 'needle' }),
  );
  expect(hits[0]).toMatchObject({ line: 2, from: 4, to: 10 });
});
it('searches the selected directory and its unsaved buffer without reading another worktree', async () => {
  const api = backend();
  const own = getFileSession(api, 'p', 'train.py', 'F:/main');
  await own.load();
  own.edit('unsaved needle\n');
  getFileSession(api, 'p', 'train.py', 'F:/other').edit('another needle');
  const onOpen = vi.fn();
  render(<CodeSearch projectId="p" root="F:/main" backend={api} onOpen={onOpen} />);
  submit('needle');
  const result = await screen.findByRole('button', { name: /train.py.*unsaved needle/ });
  fireEvent.click(result);
  expect(api.listFiles).toHaveBeenCalledWith('p', 'F:/main');
  expect(api.readFile).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'train.py', from: 8, to: 14, line: 1 }),
  );
});
it('cancels a search without publishing a late response', async () => {
  const api = backend();
  let resolve!: (value: { path: string; content: string; version: string }) => void;
  vi.mocked(api.readFile).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<CodeSearch projectId="p" root="F:/main" backend={api} onOpen={vi.fn()} />);
  submit('needle');
  await waitFor(() => expect(api.readFile).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '停止搜索' }));
  await act(async () => resolve({ path: 'train.py', content: 'needle', version: 'v1' }));
  expect(screen.queryByRole('button', { name: /train.py/ })).toBeNull();
  expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy();
});
it('a worktree switch releases busy state and rejects the previous search result', async () => {
  const api = backend();
  let resolve!: (value: { path: string; content: string; version: string }) => void;
  vi.mocked(api.readFile).mockImplementation((_p, path, root) =>
    root === 'F:/main'
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve({ path, content: 'other needle', version: 'v1' }),
  );
  const props = { projectId: 'p', backend: api, onOpen: vi.fn() };
  const view = render(<CodeSearch {...props} root="F:/main" />);
  submit('needle');
  await waitFor(() => expect(api.readFile).toHaveBeenCalled());
  view.rerender(<CodeSearch {...props} root="F:/other" />);
  submit('needle');
  await screen.findByRole('button', { name: /other needle/ });
  await act(async () => resolve({ path: 'train.py', content: 'old needle', version: 'v1' }));
  expect(screen.queryByRole('button', { name: /old needle/ })).toBeNull();
});
it('shows a partial search when large files are excluded and rejects invalid regular expressions', async () => {
  const api = backend();
  vi.mocked(api.listFiles).mockResolvedValue([
    { path: 'big.txt', name: 'big.txt', kind: 'file', size: 3 * 1024 * 1024 },
  ]);
  render(<CodeSearch projectId="p" root="F:/main" backend={api} onOpen={vi.fn()} />);
  submit('needle');
  await screen.findByText('1 个文件未读取');
  expect(api.readFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '正则表达式' }));
  submit('[');
  expect(screen.getByRole('alert').textContent).toContain('搜索表达式无效');
});
