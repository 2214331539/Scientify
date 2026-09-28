import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { createWorkspaceStore } from '../../stores/workspace';
import { emptyWorkspace, type Project } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { ResearchBackend } from '../../platform/research';
import { hasPendingFileOperations } from '../../editor/sessions';
import { LiteratureWorkspace } from './LiteratureWorkspace';
import type { LiteratureSession } from './tabs';

vi.mock('../../reader/PdfReader', () => ({
  default: ({ title }: { title: string }) => (
    <div role="region" aria-label="PDF fixture">
      {title}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function fixture() {
  const data = emptyWorkspace();
  const project: Project = {
    id: 'p',
    name: 'Research',
    question: '',
    space: 'personal',
    createdAt: '',
  };
  data.projects.push(project, { ...project, id: 'other', name: 'Other' });
  data.papers.push(
    { id: 'a', title: 'Alpha', projects: ['p'], abstract: 'Alpha evidence' },
    { id: 'b', title: 'Beta', projects: ['p'], abstract: 'Beta evidence' },
    { id: 'c', title: 'Other project', projects: ['other'] },
  );
  const storage: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save: vi.fn(async (value) => value),
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const backend: ResearchBackend = {
    listFiles: async () => [],
    readFile: vi.fn(),
    writeFile: vi.fn(),
    importPdf: vi.fn(async () => null),
    readPdf: vi.fn(),
    gitStatus: async () => [],
    listModels: async () => [],
    testModel: async () => {},
    askAI: async () => '',
    fetchArxiv: vi.fn(async () => '<feed/>'),
  };
  const store = createWorkspaceStore(storage);
  await store.getState().load();
  const context = vi.fn();
  let last: LiteratureSession | undefined;
  function Host({ initial = undefined }: { initial?: LiteratureSession }) {
    const [view, setView] = useState('local');
    const [session, setSession] = useState(initial);
    return (
      <LiteratureWorkspace
        project={project}
        store={store}
        backend={backend}
        view={view}
        onView={setView}
        selectedPaper={session?.tabs.find((tab) => tab.id === session.activeId)?.paperId ?? null}
        session={session}
        onSessionChange={(next) => {
          last = next;
          setSession(next);
        }}
        width={240}
        onContext={context}
        onTool={() => {}}
      />
    );
  }
  return { store, storage, backend, context, Host, saved: () => last, user: userEvent.setup() };
}

it('uses a resource tree, opens multiple tabs and preserves the viewer when switching the sidebar', async () => {
  const { Host, user, backend, context, saved } = await fixture();
  render(<Host />);
  expect(screen.queryByRole('button', { name: '收起资源' })).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
  const sidebar = within(screen.getByRole('complementary'));
  expect(sidebar.getByRole('button', { name: '导入 PDF' })).toBeTruthy();
  expect(sidebar.queryByRole('treeitem', { name: 'Other project' })).toBeNull();
  await user.click(sidebar.getByRole('treeitem', { name: 'Alpha' }));
  await user.click(sidebar.getByRole('treeitem', { name: 'Beta' }));
  expect(screen.getAllByRole('tab')).toHaveLength(2);
  const viewer = screen.getByRole('tabpanel');
  await user.click(sidebar.getByRole('button', { name: '订阅' }));
  expect(screen.getByRole('tabpanel')).toBe(viewer);
  expect(within(viewer).getByText('Beta evidence')).toBeTruthy();
  expect(sidebar.getByRole('region', { name: '文献订阅' }).textContent).toBe('');
  expect(backend.fetchArxiv).not.toHaveBeenCalled();
  expect(context.mock.lastCall?.[0]).toMatchObject({ resourceId: 'b' });
  await user.click(screen.getByRole('tab', { name: 'Alpha' }));
  expect(within(viewer).getByText('Alpha evidence')).toBeTruthy();
  const snapshot = saved();
  cleanup();
  render(<Host initial={snapshot} />);
  expect(screen.getAllByRole('tab')).toHaveLength(2);
  expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
});

it('adds a blank page, searches without replacing the viewer and closes to an adjacent tab', async () => {
  const { Host, user, store } = await fixture();
  render(<Host />);
  await user.click(screen.getByRole('treeitem', { name: 'Alpha' }));
  await user.click(screen.getByRole('button', { name: '新建文献标签页' }));
  expect(screen.getByRole('tab', { name: '空白页 2' }).getAttribute('aria-selected')).toBe('true');
  await user.click(screen.getByRole('treeitem', { name: 'Beta' }));
  expect(screen.getAllByRole('tab')).toHaveLength(2);
  await user.type(screen.getByRole('searchbox', { name: '搜索文献' }), 'Alpha');
  expect(screen.queryByRole('treeitem', { name: 'Beta' })).toBeNull();
  expect(screen.getByText('Beta evidence')).toBeTruthy();
  await user.click(screen.getByRole('treeitem', { name: 'Research' }));
  expect(screen.queryByRole('treeitem', { name: 'Alpha' })).toBeNull();
  await user.click(screen.getByRole('treeitem', { name: 'Research' }));
  expect(screen.getByRole('treeitem', { name: 'Alpha' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '关闭 Beta' }));
  expect(screen.getByText('Alpha evidence')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '关闭 Alpha' }));
  expect(screen.queryByRole('tab')).toBeNull();
  expect(store.getState().data?.papers).toHaveLength(3);
});

it('retries metadata saving without reimporting the PDF and keeps the original project association', async () => {
  const { Host, user, store, storage, backend } = await fixture();
  render(<Host />);
  vi.mocked(backend.importPdf).mockResolvedValueOnce({
    assetId: 'asset',
    fileName: 'Imported.pdf',
    size: 10,
  });
  vi.mocked(storage.save).mockRejectedValueOnce(new Error('disk full'));
  await user.click(screen.getByRole('button', { name: '导入 PDF' }));
  await screen.findByRole('alert');
  expect(store.getState().dirty).toBe(true);
  expect(store.getState().data?.papers).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: '重试保存' }));
  await screen.findByRole('tab', { name: 'Imported' });
  expect(backend.importPdf).toHaveBeenCalledTimes(1);
  expect(store.getState().data?.papers.at(-1)).toMatchObject({ projects: ['p'], assetId: 'asset' });
  await waitFor(() => expect(store.getState().dirty).toBe(false));
});

it('tracks an outstanding file dialog and does not create a paper on cancellation', async () => {
  const { Host, user, store, backend } = await fixture();
  render(<Host />);
  let finish!: (value: null) => void;
  vi.mocked(backend.importPdf).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(screen.getByRole('button', { name: '导入 PDF' }));
  expect(hasPendingFileOperations(backend)).toBe(true);
  await act(async () => finish(null));
  expect(hasPendingFileOperations(backend)).toBe(false);
  expect(store.getState().data?.papers).toHaveLength(3);
});
