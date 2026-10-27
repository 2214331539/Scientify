import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SubscriptionSidebar } from './SubscriptionSidebar';
import { createWorkspaceStore } from '../../stores/workspace';
import { emptyWorkspace } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';

afterEach(() => {
  cleanup();
  localStorage.clear();
});
async function fixture() {
  let disk = emptyWorkspace();
  const save = vi.fn(async (value) => {
    disk = structuredClone(value);
    return structuredClone(disk);
  });
  const store = createWorkspaceStore({
    load: async () => ({
      workspace: structuredClone(disk),
      directory: 'test',
      legacyAvailable: false,
    }),
    save,
  } as unknown as WorkspaceBackend);
  await store.getState().load();
  const onOpen = vi.fn(async () => {});
  const props = {
    store,
    onOpen,
    onNewBrowser: vi.fn(),
    onRecommendations: vi.fn(),
    bookmark: null,
    onBookmarkHandled: vi.fn(),
  };
  return { store, save, props, user: userEvent.setup() };
}
it('saves grouped sources, opens the stored URL, survives reload, and preserves links when deleting a group', async () => {
  const { store, props, user } = await fixture();
  const view = render(<SubscriptionSidebar {...props} />);
  await user.click(screen.getByRole('button', { name: '新建分组' }));
  await user.type(await screen.findByRole('textbox', { name: '新建分组' }), '论文网站');
  await user.click(screen.getByRole('button', { name: '确认' }));
  await screen.findByRole('button', { name: '论文网站' });
  const group = store.getState().data!.webSources!.groups[0];
  await user.click(screen.getByRole('button', { name: '添加信息源' }));
  await user.type(screen.getByRole('textbox', { name: '名称' }), 'arXiv');
  await user.type(screen.getByRole('textbox', { name: '网址' }), 'https://arxiv.org');
  await user.selectOptions(screen.getByRole('combobox', { name: '分组' }), group.id);
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await user.click(screen.getByRole('button', { name: 'arXiv' }));
  expect(props.onOpen).toHaveBeenCalledWith('https://arxiv.org/');
  view.unmount();
  await store.getState().load();
  render(<SubscriptionSidebar {...props} />);
  expect(screen.getByRole('button', { name: 'arXiv' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '管理分组 论文网站' }));
  await user.click(screen.getByRole('menuitem', { name: '删除' }));
  await user.click(await screen.findByRole('button', { name: '确认' }));
  await waitFor(() => expect(store.getState().data?.webSources?.groups).toEqual([]));
  expect(store.getState().data?.webSources?.items[0].groupId).toBeUndefined();
  expect(screen.getByRole('button', { name: 'arXiv' })).toBeTruthy();
});

it('keeps bookmark edits on save failure, rejects duplicate and unsafe URLs, and edits an existing bookmark', async () => {
  const { store, save, props, user } = await fixture();
  const view = render(
    <SubscriptionSidebar {...props} bookmark={{ title: 'Source', url: 'https://example.org/' }} />,
  );
  await screen.findByRole('dialog', { name: '添加信息源' });
  save.mockRejectedValueOnce(new Error('disk full'));
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'disk full');
  expect((screen.getByRole('textbox', { name: '名称' }) as HTMLInputElement).value).toBe('Source');
  // Simulate the parent consuming the bookmark request.
  view.rerender(<SubscriptionSidebar {...props} />);
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await user.click(screen.getByRole('button', { name: '添加信息源' }));
  await user.type(screen.getByRole('textbox', { name: '名称' }), 'duplicate');
  await user.type(screen.getByRole('textbox', { name: '网址' }), 'https://example.org');
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('此网址已在个人信息源中。')).toBeTruthy();
  await user.clear(screen.getByRole('textbox', { name: '网址' }));
  await user.type(screen.getByRole('textbox', { name: '网址' }), 'javascript:alert(1)');
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('请输入不含账号密码的 HTTP 或 HTTPS 链接。')).toBeTruthy();
  view.unmount();
  render(
    <SubscriptionSidebar
      {...props}
      bookmark={{ title: 'New title', url: 'https://example.org/' }}
    />,
  );
  const dialog = await screen.findByRole('dialog', { name: '编辑信息源' });
  const title = within(dialog).getByRole('textbox', { name: '名称' });
  await user.clear(title);
  await user.type(title, 'Updated');
  await user.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(store.getState().data?.webSources?.items[0].title).toBe('Updated'));
  expect(store.getState().data?.webSources?.items).toHaveLength(1);
});
