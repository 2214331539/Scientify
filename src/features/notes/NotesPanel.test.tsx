import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace, type Workspace } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { WorkspaceBackend } from '../../platform/desktop';
import { createWorkspaceStore } from '../../stores/workspace';
import { createNote, expiredNotes, purgeExpiredNotes, selectNotes, TRASH_DAYS } from './model';
import { NotesPanel } from './NotesPanel';

afterEach(cleanup);
const context: WorkContext = {
  projectId: 'p1',
  workspace: 'literature',
  resourceId: 'paper1',
  title: '论文一',
  selection: '原文结论',
};

async function fixture(save = vi.fn(async (data: Workspace) => data)) {
  const data = emptyWorkspace();
  data.records = [
    createNote('p1', '项目一笔记', '已有正文'),
    createNote('p2', '项目二私有笔记', '其他项目'),
    createNote('__inbox__', '个人收集箱', '个人内容'),
  ];
  const backend: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(backend);
  await store.getState().load();
  return { store, save };
}

it('keeps the selected note pinned when the central object changes and adds sources only on request', async () => {
  const { store } = await fixture();
  const user = userEvent.setup();
  const view = render(<NotesPanel store={store} scope="p1" context={context} />);
  expect(screen.queryByText('项目二私有笔记')).toBeNull();
  expect(screen.queryByText('个人收集箱')).toBeNull();
  await user.click(screen.getByRole('button', { name: /项目一笔记/ }));
  view.rerender(
    <NotesPanel
      store={store}
      scope="p1"
      context={{ ...context, resourceId: 'paper2', title: '论文二', selection: '第二篇结论' }}
    />,
  );
  expect((screen.getByLabelText('笔记标题') as HTMLInputElement).value).toBe('项目一笔记');
  expect(store.getState().data?.records[0].sources).toEqual([]);
  await user.click(screen.getByRole('button', { name: '添加当前来源' }));
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(store.getState().dirty).toBe(false));
  const sources = store.getState().data?.records[0].sources as {
    title: string;
    selection: string;
  }[];
  expect(sources[0]).toMatchObject({ title: '论文二', selection: '第二篇结论' });
});

it('retains failed drafts and prevents switching away until the note can be saved', async () => {
  const save = vi.fn(async (data: Workspace) => data);
  save.mockRejectedValueOnce(new Error('磁盘写入失败'));
  const { store } = await fixture(save);
  const user = userEvent.setup();
  render(<NotesPanel store={store} scope="p1" context={context} />);
  await user.click(screen.getByRole('button', { name: /项目一笔记/ }));
  await user.type(screen.getByLabelText('笔记正文'), '，新结论');
  await user.click(screen.getByRole('button', { name: '返回笔记列表' }));
  await screen.findByText('磁盘写入失败');
  expect((screen.getByLabelText('笔记正文') as HTMLTextAreaElement).value).toBe('已有正文，新结论');
  expect(store.getState().data?.records[0].body).toBe('已有正文');
  expect(store.getState().dirty).toBe(true);
  await user.click(screen.getByRole('button', { name: '重试保存' }));
  await waitFor(() => expect(store.getState().dirty).toBe(false));
  expect(store.getState().data?.records[0].body).toBe('已有正文，新结论');
});

it('does not let an old save acknowledgment mark newer input as saved', async () => {
  let finish!: () => void;
  const save = vi.fn(
    (data: Workspace) =>
      new Promise<Workspace>((resolve) => {
        finish = () => resolve(data);
      }),
  );
  const { store } = await fixture(save);
  const user = userEvent.setup();
  render(<NotesPanel store={store} scope="p1" context={context} />);
  await user.click(screen.getByRole('button', { name: /项目一笔记/ }));
  await user.type(screen.getByLabelText('笔记正文'), 'A');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await user.type(screen.getByLabelText('笔记正文'), 'B');
  await act(async () => finish());
  expect(store.getState().data?.records[0].body).toBe('已有正文A');
  expect((screen.getByLabelText('笔记正文') as HTMLTextAreaElement).value).toBe('已有正文AB');
  expect(store.getState().dirty).toBe(true);
});

it('opens a requested note only in its scope and only after saving the current draft', async () => {
  const save = vi.fn(async (data: Workspace) => data);
  const { store } = await fixture(save);
  const target = createNote('p1', '搜索目标笔记', '目标正文');
  await store.getState().update((data) => {
    data.records.push(target);
  });
  const user = userEvent.setup();
  render(<NotesPanel store={store} scope="p1" context={context} />);
  await user.click(screen.getByRole('button', { name: /项目一笔记/ }));
  await user.type(screen.getByLabelText('笔记正文'), '新想法');
  save.mockRejectedValueOnce(new Error('来源切换时保存失败'));
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('scientify-open-note', { detail: { scope: 'p1', id: target.id } }),
    );
  });
  await screen.findByText('来源切换时保存失败');
  expect((screen.getByLabelText('笔记标题') as HTMLInputElement).value).toBe('项目一笔记');
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('scientify-open-note', { detail: { scope: 'p2', id: target.id } }),
    );
  });
  expect((screen.getByLabelText('笔记标题') as HTMLInputElement).value).toBe('项目一笔记');
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('scientify-open-note', { detail: { scope: 'p1', id: target.id } }),
    );
  });
  await waitFor(() =>
    expect((screen.getByLabelText('笔记标题') as HTMLInputElement).value).toBe('搜索目标笔记'),
  );
  expect(store.getState().data?.records[0].body).toBe('已有正文新想法');
});

it('moves a note to the recycle bin, undoes it, restores and deletes it for good', async () => {
  const { store } = await fixture();
  const user = userEvent.setup();
  vi.spyOn(await import('../../components/prompts'), 'confirmAction').mockResolvedValue(true);
  render(<NotesPanel store={store} scope="p1" context={context} />);
  await user.click(screen.getByRole('button', { name: /项目一笔记/ }));
  await user.click(screen.getByRole('button', { name: '删除笔记' }));
  await screen.findByText('已移到回收站');
  expect(screen.queryByRole('button', { name: /项目一笔记/ })).toBeNull();
  expect(selectNotes(store.getState().data, 'p1')).toHaveLength(0);

  await user.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByRole('button', { name: /项目一笔记/ });

  await user.click(screen.getByRole('button', { name: /项目一笔记/ }));
  await user.click(screen.getByRole('button', { name: '删除笔记' }));
  await user.click(await screen.findByRole('button', { name: '回收站' }));
  const bin = screen.getByRole('list', { name: '回收站' });
  await user.click(within(bin).getByRole('button', { name: '恢复“项目一笔记”' }));
  await waitFor(() => expect(selectNotes(store.getState().data, 'p1')).toHaveLength(1));

  await user.click(screen.getByRole('button', { name: '返回笔记列表' }));
  await user.click(screen.getByRole('button', { name: /项目一笔记/ }));
  await user.click(screen.getByRole('button', { name: '删除笔记' }));
  await user.click(await screen.findByRole('button', { name: '回收站' }));
  await user.click(screen.getByRole('button', { name: '彻底删除“项目一笔记”' }));
  await waitFor(() =>
    expect(store.getState().data?.records.some((note) => note.title === '项目一笔记')).toBe(false),
  );
});

it('removes notes that stayed in the recycle bin longer than the limit', async () => {
  const { store } = await fixture();
  const old = new Date(Date.now() - (TRASH_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
  await store.getState().update((data) => {
    data.records[0] = { ...data.records[0], deletedAt: old };
    data.records[1] = { ...data.records[1], deletedAt: new Date().toISOString() };
  });
  expect(expiredNotes(store.getState().data)).toHaveLength(1);
  expect(await purgeExpiredNotes(store)).toBe(true);
  expect(store.getState().data?.records.map((note) => note.title)).toEqual([
    '项目二私有笔记',
    '个人收集箱',
  ]);
});
