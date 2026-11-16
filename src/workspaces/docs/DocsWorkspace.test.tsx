import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace, type Project } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import { memoryDocs } from '../../platform/docs';
import type { LibraryBackend } from '../../platform/library';
import type { ResearchBackend } from '../../platform/research';
import { DocsWorkspace } from './DocsWorkspace';
import { newPage, type Page } from './model';
import { resetDocsRuntimes } from './runtime';
import { migrateNotes } from './migrate';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  resetDocsRuntimes();
  localStorage.clear();
});

const project: Project = {
  id: 'p1',
  name: 'Proactive',
  question: '',
  createdAt: '',
  space: 'personal',
};
async function setup(pages: Page[] = [], records: unknown[] = []) {
  const data = emptyWorkspace();
  data.projects = [project];
  data.records = records as typeof data.records;
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: vi.fn(async (next) => next),
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  });
  await store.getState().load();
  const docs = memoryDocs(pages);
  const onOpenPage = vi.fn();
  const library = {} as LibraryBackend;
  const backend = { listFiles: async () => [] } as unknown as ResearchBackend;
  const view = render(
    <DocsWorkspace
      project={project}
      store={store}
      backend={backend}
      docs={docs}
      library={library}
      activePage={null}
      onOpenPage={onOpenPage}
      onContext={() => {}}
      onTool={() => {}}
    />,
  );
  return { store, docs, onOpenPage, view, library, backend };
}

const meeting = () => {
  const page = newPage({ parent: null, order: 'V', title: '组会纪要', icon: '🗓️' });
  page.blocks = [{ id: 'b1', type: 'paragraph', content: [{ text: '议题' }] }];
  return page;
};

it('lists pages in the tree and creates a page from a template', async () => {
  const first = meeting();
  const { docs, onOpenPage } = await setup([first]);
  const tree = await screen.findByRole('tree', { name: '页面' });
  expect(within(tree).getByRole('button', { name: /组会纪要/ })).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '模板' }));
  await user.click(
    within(screen.getByRole('dialog', { name: '模板' })).getByRole('button', { name: /实验记录/ }),
  );
  await waitFor(() => expect(onOpenPage).toHaveBeenCalled());
  const created = docs.pages.get(onOpenPage.mock.calls[0][0])!;
  expect(created.title).toBe('实验记录');
  expect(created.blocks.map((block) => block.type)).toContain('code');
});

it('opens a page, edits its title and saves it', async () => {
  const first = meeting();
  const { docs, view, store, backend, library } = await setup([first]);
  view.rerender(
    <DocsWorkspace
      project={project}
      store={store}
      backend={backend}
      docs={docs}
      library={library}
      activePage={first.id}
      onOpenPage={() => {}}
      onContext={() => {}}
      onTool={() => {}}
    />,
  );
  const title = (await screen.findByRole('textbox', { name: '页面标题' })) as HTMLTextAreaElement;
  expect(title.value).toBe('组会纪要');
  const user = userEvent.setup();
  await user.type(title, ' 11 月');
  await waitFor(() => expect(docs.pages.get(first.id)!.title).toBe('组会纪要 11 月'), {
    timeout: 3000,
  });
});

it('moves a page and its subpages to the recycle bin and back', async () => {
  const parent = meeting();
  const child = newPage({ parent: parent.id, order: 'V', title: '11 月 16 日' });
  const { docs } = await setup([parent, child]);
  const user = userEvent.setup();
  const tree = await screen.findByRole('tree', { name: '页面' });
  await user.click(within(tree).getAllByRole('button', { name: '更多' })[0]);
  await user.click(screen.getByRole('menuitem', { name: '删除' }));
  await waitFor(() => expect(docs.pages.get(child.id)!.deletedAt).toBeTruthy());
  expect(docs.pages.get(parent.id)!.deletedAt).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /回收站/ }));
  const dialog = screen.getByRole('dialog', { name: '回收站' });
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
  await user.click(within(dialog).getByRole('button', { name: '恢复' }));
  await waitFor(() => expect(docs.pages.get(child.id)!.deletedAt).toBeNull());
});

it('turns old notes into pages under “笔记”, once', async () => {
  const note = {
    id: 'n1',
    project: 'p1',
    type: 'note',
    title: '阅读笔记',
    body: '# 要点\n\n- 一\n- 二',
    status: 'draft',
    createdAt: '2026-10-01',
    updatedAt: '2026-10-02',
  };
  const { store, docs } = await setup([], [note]);
  await act(async () => {
    await migrateNotes(store, docs, 'p1');
  });
  const page = docs.pages.get('note-n1')!;
  expect(page.title).toBe('阅读笔记');
  expect(page.parent).toBe('notes-p1');
  expect(page.blocks.map((block) => block.type)).toEqual(['heading', 'bullet', 'bullet']);
  expect((store.getState().data!.records[0] as { migratedTo?: string }).migratedTo).toBe('note-n1');
  expect(await migrateNotes(store, docs, 'p1')).toBe(0);
});
