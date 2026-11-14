import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { LibraryBackend, LibraryScan } from '../../platform/library';
import { createWorkspaceStore } from '../../stores/workspace';
import { createNote } from '../notes/model';
import { SearchDialog, searchWorkspace } from './SearchDialog';

afterEach(cleanup);

function fixture() {
  const data = emptyWorkspace();
  data.projects.push({
    id: 'p1',
    name: '检索实验',
    question: '验证检索结论',
    space: 'personal',
    createdAt: '',
  });
  data.papers.push({ id: 'paper', title: '检索论文', authors: '科研作者', projects: ['p1'] });
  data.records.push(
    createNote('p1', '实验结论', '检索的主要发现'),
    createNote('__inbox__', '个人想法', '检索待办'),
  );
  return data;
}

it('searches actual fields, carries scopes and returns no invented empty-query results', () => {
  const data = fixture();
  expect(searchWorkspace(data, '')).toEqual([]);
  const results = searchWorkspace(data, '检索');
  expect(results).toHaveLength(4);
  expect(results.find((result) => result.title === '个人想法')?.target).toMatchObject({
    projectId: undefined,
    workspace: 'projects',
    tool: 'notes',
  });
  expect(searchWorkspace(data, '科研作者')[0].target).toMatchObject({
    projectId: 'p1',
    workspace: 'literature',
    resourceId: 'paper',
  });
  expect(searchWorkspace(data, '未存在的材料')).toEqual([]);
});

it('navigates a matching saved note with its project and resource identity', async () => {
  const data = fixture();
  const adapter: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: async (value) => value,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(adapter);
  await store.getState().load();
  const navigate = vi.fn();
  const close = vi.fn();
  const user = userEvent.setup();
  render(<SearchDialog store={store} onClose={close} onNavigate={navigate} />);
  await user.type(screen.getByLabelText('搜索项目、文献和笔记'), '主要发现');
  await user.click(screen.getByRole('button', { name: /实验结论/ }));
  expect(navigate).toHaveBeenCalledWith({
    projectId: 'p1',
    workspace: 'notes',
    resourceId: data.records[0].id,
  });
  expect(close).toHaveBeenCalledOnce();
});

it('finds PDFs in the literature folder by file name and opens the one picked', async () => {
  const data = fixture();
  data.records.push({ ...createNote('p1', '已删除', '检索'), deletedAt: new Date().toISOString() });
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: async (value: typeof data) => value,
  } as unknown as WorkspaceBackend);
  await store.getState().load();
  const scan = {
    root: 'C:/papers',
    papers: [],
    warnings: [],
    entries: [
      {
        path: 'Methods/Attention Is All You Need.pdf',
        name: 'Attention Is All You Need.pdf',
        directory: false,
        pdf: true,
        note: false,
        size: 1,
        paperId: null,
      },
      {
        path: 'Methods/attention-notes.md',
        name: 'attention-notes.md',
        directory: false,
        pdf: false,
        note: true,
        size: 1,
        paperId: null,
      },
    ],
  } as LibraryScan;
  const library = {
    command: vi.fn(async () => scan),
    open: vi.fn(async () => ({
      id: 'bound-paper',
      path: 'Methods/Attention Is All You Need.pdf',
      notePath: '',
      fingerprint: 'x',
    })),
  } as unknown as LibraryBackend;
  const navigate = vi.fn();
  const close = vi.fn();
  const user = userEvent.setup();
  render(
    <SearchDialog
      store={store}
      onClose={close}
      onNavigate={navigate}
      projectId="p1"
      library={library}
    />,
  );
  await user.type(screen.getByLabelText('搜索项目、文献和笔记'), 'attention');
  const paper = await screen.findByRole('button', { name: /Attention Is All You Need/ });
  expect(screen.queryByRole('button', { name: /attention-notes/ })).toBeNull();
  expect(library.command).toHaveBeenCalledOnce();
  await user.click(paper);
  expect(library.open).toHaveBeenCalledWith('p1', 'Methods/Attention Is All You Need.pdf');
  expect(navigate).toHaveBeenCalledWith({
    projectId: 'p1',
    workspace: 'literature',
    resourceId: 'bound-paper',
  });
  expect(close).toHaveBeenCalledOnce();
  expect(
    searchWorkspace(store.getState().data, '检索').some((result) => result.title === '已删除'),
  ).toBe(false);
});
