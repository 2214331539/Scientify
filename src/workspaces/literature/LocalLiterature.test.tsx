import { cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { LocalLiterature } from './LocalLiterature';
import { emptyWorkspace } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { ResearchBackend } from '../../platform/research';
import type { LibraryBackend, LibraryScan } from '../../platform/library';
import { emptyLocalSession, openLocalPdf, closeLocalTab, paperNote } from './local-session';
import { getFileRuntime } from '../../editor/sessions';
import { noteFiles } from '../../platform/library';

vi.mock('../../reader/PdfReader', () => ({
  default: ({ title }: { title: string }) => <div aria-label="Test PDF">{title}</div>,
}));
vi.mock('../../platform/browser-pane', () => ({
  browserCommand: vi.fn(async () => []),
  browserEvents: async () => () => {},
  browserLayout: async () => {},
}));
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
  localStorage.clear();
});
async function fixture(requestedPaper?: string) {
  const data = emptyWorkspace();
  const project = {
    id: crypto.randomUUID(),
    name: 'Test library',
    question: '',
    createdAt: '',
    space: 'personal',
  };
  data.projects.push(project);
  const storage: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: async (data) => data,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(storage);
  await store.getState().load();
  const scan: LibraryScan = {
    root: 'F:/isolated',
    warnings: [],
    entries: [
      {
        path: 'a.pdf',
        name: 'a.pdf',
        directory: false,
        pdf: true,
        note: false,
        size: 10,
        paperId: 'a',
      },
      {
        path: 'b.pdf',
        name: 'b.pdf',
        directory: false,
        pdf: true,
        note: false,
        size: 10,
        paperId: 'b',
      },
    ],
    papers: [
      { id: 'a', path: 'a.pdf', notePath: 'a.notes.md', fingerprint: 'one' },
      { id: 'b', path: 'b.pdf', notePath: 'b.notes.md', fingerprint: 'two' },
    ],
  };
  const library: LibraryBackend = {
    choose: async () => scan,
    command: vi.fn(async () => scan),
    open: async (_p, path) => scan.papers.find((p) => p.path === path)!,
    pdf: async () => new Uint8Array(),
    note: async () => ({ content: 'existing note', revision: 'v1' }),
    saveNote: vi.fn(async (_p, _id, content) => ({ content, revision: 'v2' })),
    external: vi.fn(async () => {}),
    import: async () => scan,
    importFile: vi.fn(async () => scan),
    changed: async () => () => {},
  };
  const backend: ResearchBackend = {
    listFiles: async () => [],
    readFile: vi.fn(),
    writeFile: vi.fn(),
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    gitStatus: async () => [],
    listModels: async () => [],
    testModel: async () => {},
    askAI: async () => '',
    fetchArxiv: async () => '',
  };
  function Host() {
    const [view, onView] = useState('local');
    return (
      <LocalLiterature
        project={project}
        store={store}
        backend={backend}
        library={library}
        requestedPaper={requestedPaper}
        view={view}
        onView={onView}
        width={240}
        onContext={() => {}}
        onLegacy={() => {}}
      />
    );
  }
  return { Host, library, project, scan, user: userEvent.setup() };
}
it('closes PDF and note tabs only after a paired deletion succeeds', async () => {
  const { Host, library, scan, project, user } = await fixture();
  render(<Host />);
  await user.click(await screen.findByRole('treeitem', { name: 'a.pdf' }));
  await screen.findByRole('textbox', { name: '论文笔记正文' });
  vi.mocked(library.command).mockResolvedValueOnce({
    ...scan,
    entries: scan.entries.filter((e) => e.path !== 'a.pdf'),
    papers: scan.papers.filter((p) => p.id !== 'a'),
  });
  fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'a.pdf' }));
  await user.click(await screen.findByRole('menuitem', { name: '移入回收站' }));
  await user.click(
    within(await screen.findByRole('dialog', { name: '确认操作' })).getByRole('button', {
      name: '确认',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '论文笔记正文' })).toBeNull());
  expect(screen.queryByRole('tab', { name: 'a.pdf' })).toBeNull();
  expect(screen.getByRole('treeitem', { name: 'b.pdf' })).toBeTruthy();
  expect(library.command).toHaveBeenCalledWith(project.id, { op: 'delete', path: 'a.pdf' });
  expect(getFileRuntime(noteFiles(library)).sessions.size).toBe(0);
});
it('offers deletion from PDF tabs in subscriptions and preserves notes on failure', async () => {
  const { Host, library, user } = await fixture();
  render(<Host />);
  const entry = await screen.findByRole('treeitem', { name: 'a.pdf' });
  await user.click(entry);
  await screen.findByRole('textbox', { name: '论文笔记正文' });
  await user.click(screen.getByRole('button', { name: '订阅' }));
  vi.mocked(library.command).mockRejectedValueOnce(new Error('trash unavailable'));
  const tab = within(screen.getByRole('tablist', { name: '文献标签页' })).getByRole('tab', {
    name: 'a.pdf',
  });
  fireEvent.contextMenu(tab, { clientX: 100, clientY: 100 });
  await user.click(await screen.findByRole('menuitem', { name: '移入回收站' }));
  const dialog = await screen.findByRole('dialog', { name: '确认操作' });
  expect(within(dialog).getByText('将“a.pdf”及对应笔记移入系统回收站？')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: '确认' }));
  await screen.findByText('trash unavailable');
  expect(tab.isConnected).toBe(true);
  expect((screen.getByRole('textbox', { name: '论文笔记正文' }) as HTMLTextAreaElement).value).toBe(
    'existing note',
  );
  expect(getFileRuntime(noteFiles(library)).sessions.size).toBe(1);
});
it('opens a requested source only after its local binding is available', async () => {
  const { Host } = await fixture('b');
  render(<Host />);
  await screen.findByRole('textbox', { name: '论文笔记正文' });
  expect(
    within(screen.getByRole('tablist', { name: '文献标签页' })).getByRole('tab', { name: 'b.pdf' }),
  ).toBeTruthy();
});

it('copies external files into the folder under the pointer', async () => {
  const { Host, library, scan, user } = await fixture();
  scan.entries.unshift({
    path: 'Reading',
    name: 'Reading',
    directory: true,
    pdf: false,
    note: false,
    size: 0,
    paperId: null,
  });
  render(<Host />);
  const folder = await screen.findByRole('treeitem', { name: 'Reading' });
  const file = new File(['%PDF-1.4 test'], '中文论文.pdf', { type: 'application/pdf' });
  const transfer = {
    types: ['Files'],
    files: [file],
    items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
    dropEffect: '',
  };
  fireEvent.dragOver(folder, { dataTransfer: transfer });
  expect(screen.getByText('复制到 Reading')).toBeTruthy();
  fireEvent.drop(folder, { dataTransfer: transfer });
  await waitFor(() =>
    expect(library.importFile).toHaveBeenCalledWith(expect.any(String), 'Reading', file),
  );
  await user.click(screen.getByRole('button', { name: '搜索文献' }));
  const search = screen.getByRole('textbox', { name: '搜索文献' });
  expect(search.closest('.library-root-toolbar')).not.toBeNull();
  expect(
    within(search.closest('.library-root-toolbar') as HTMLElement).queryAllByRole('button'),
  ).toHaveLength(0);
});

it('replaces the entire directory toolbar during search and restores it on Enter, blur or Escape', async () => {
  const { Host, user } = await fixture();
  render(<Host />);
  await screen.findByRole('treeitem', { name: 'a.pdf' });
  await user.click(screen.getByRole('button', { name: '搜索文献' }));
  await user.type(screen.getByRole('textbox', { name: '搜索文献' }), 'a.pdf{Enter}');
  expect(screen.queryByRole('textbox', { name: '搜索文献' })).toBeNull();
  expect(screen.getByRole('button', { name: '新建文件夹' })).toBeTruthy();
  expect(screen.queryByRole('treeitem', { name: 'b.pdf' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '搜索文献' }));
  expect((screen.getByRole('textbox', { name: '搜索文献' }) as HTMLInputElement).value).toBe(
    'a.pdf',
  );
  await user.click(screen.getByRole('button', { name: '文献库' }));
  expect(screen.queryByRole('textbox', { name: '搜索文献' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '搜索文献' }));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('treeitem', { name: 'b.pdf' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '搜索文献' })).toBeTruthy();
});

it('rejects directory drops without starting a partial import', async () => {
  const { Host, library } = await fixture();
  render(<Host />);
  const entry = await screen.findByRole('treeitem', { name: 'a.pdf' });
  fireEvent.drop(entry, {
    dataTransfer: {
      types: ['Files'],
      files: [],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
    },
  });
  await screen.findByRole('alert');
  expect(library.importFile).not.toHaveBeenCalled();
});
it('opens matching note tabs and does not reopen a note the user closed until the PDF is reopened', async () => {
  const { Host, user } = await fixture();
  render(<Host />);
  await user.click(await screen.findByRole('treeitem', { name: 'a.pdf' }));
  await screen.findByRole('textbox', { name: '论文笔记正文' });
  const notes = within(screen.getByRole('tablist', { name: '论文笔记标签' }));
  await user.click(notes.getByRole('button', { name: '关闭 a.pdf' }));
  expect(screen.queryByRole('textbox', { name: '论文笔记正文' })).toBeNull();
  await user.click(screen.getByRole('treeitem', { name: 'a.pdf' }));
  expect(screen.queryByRole('textbox', { name: '论文笔记正文' })).toBeNull();
  await user.click(
    within(screen.getByRole('tablist', { name: '文献标签页' })).getByRole('button', {
      name: '关闭 a.pdf',
    }),
  );
  await user.click(screen.getByRole('treeitem', { name: 'a.pdf' }));
  await screen.findByRole('textbox', { name: '论文笔记正文' });
});
it('keeps failed note saves visible and blocks closing the note', async () => {
  const { Host, user, library } = await fixture();
  render(<Host />);
  await user.click(await screen.findByRole('treeitem', { name: 'a.pdf' }));
  const input = await screen.findByRole('textbox', { name: '论文笔记正文' });
  await user.type(input, ' draft');
  vi.mocked(library.saveNote).mockRejectedValue(new Error('external edit conflict'));
  await user.click(
    within(screen.getByRole('tablist', { name: '论文笔记标签' })).getByRole('button', {
      name: '关闭 a.pdf',
    }),
  );
  await waitFor(() => expect(library.saveNote).toHaveBeenCalled());
  expect((screen.getByRole('textbox', { name: '论文笔记正文' }) as HTMLTextAreaElement).value).toBe(
    'existing note draft',
  );
});
it('opens a real context menu and shows explicit subscription placeholders without fetching', async () => {
  const { Host, user, library } = await fixture();
  render(<Host />);
  const entry = await screen.findByRole('treeitem', { name: 'a.pdf' });
  fireEvent.contextMenu(entry, { clientX: 100, clientY: 100 });
  await screen.findByRole('menuitem', { name: '打开论文笔记' });
  await user.click(screen.getByRole('menuitem', { name: '复制' }));
  await user.click(screen.getByRole('button', { name: '订阅' }));
  expect(screen.getAllByText('尚未启用')).toHaveLength(2);
  expect(screen.getByRole('button', { name: '打开浏览器' })).toBeTruthy();
  expect(library.command).toHaveBeenCalledWith(expect.any(String), { op: 'scan' });
});
it('keeps pairing behavior independent from titles and retains note buffers after leaving a view', async () => {
  let s = openLocalPdf(emptyLocalSession(), 'id', 'old.pdf');
  s = { ...s, notes: [], activeNote: null };
  expect(openLocalPdf(s, 'id', 'renamed.pdf').notes).toEqual([]);
  expect(openLocalPdf(closeLocalTab(s, 'pdf:id'), 'id', 'renamed.pdf').notes).toEqual(['id']);
  const { library, project } = await fixture();
  const session = paperNote(library, project.id, 'id');
  await session.load();
  session.edit('draft');
  expect(paperNote(library, project.id, 'id')).toBe(session);
  await session.save();
  expect(session.getSnapshot().dirty).toBe(false);
});
