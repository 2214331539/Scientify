import { act, cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
import type { WorkContext } from '../../domain/context';

vi.mock('../../reader/PdfReader', () => ({
  default: ({ title, onContext }: { title: string; onContext(context: WorkContext): void }) => (
    <div aria-label="Test PDF">
      {title}
      <button
        aria-label="Test PDF selection"
        onClick={() =>
          onContext({
            workspace: 'literature',
            title,
            resourceId: 'a',
            page: 3,
            text: 'Page text',
            selection: 'Selected passage',
          })
        }
      >
        Select
      </button>
    </div>
  ),
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
        path: 'a.notes.md',
        name: 'a.notes.md',
        directory: false,
        pdf: false,
        note: true,
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
      {
        path: 'notes.md',
        name: 'notes.md',
        directory: false,
        pdf: false,
        note: false,
        size: 18,
        paperId: null,
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
    readFile: vi.fn(async (_p, path) => ({
      path,
      content: '# Local notes\n\nOpened in Scientify.',
      version: 'v1',
    })),
    note: async () => ({ content: 'existing note', revision: 'v1' }),
    saveNote: vi.fn(async (_p, _id, content) => ({ content, revision: 'v2' })),
    external: vi.fn(async () => {}),
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
  };
  const onContext = vi.fn();
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
        onContext={onContext}
      />
    );
  }
  return { Host, library, project, scan, onContext, user: userEvent.setup() };
}
it('keeps the sidebar bounded and mounts the PDF in a separate flexible reading area', async () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/workspaces/literature/local-literature.css', 'utf8');
  document.head.append(style);
  try {
    const { Host, user } = await fixture();
    render(<Host />);
    await user.click(await screen.findByRole('treeitem', { name: 'a.pdf' }));
    const pdf = await screen.findByLabelText('Test PDF');
    const sidebar = screen.getByRole('complementary', { name: '本地文献目录' });
    const reader = screen.getByRole('tabpanel', { name: '文献呈现区' });
    expect(sidebar.contains(pdf)).toBe(false);
    expect(reader.contains(pdf)).toBe(true);
    expect(getComputedStyle(sidebar).flexGrow).toBe('0');
    expect(getComputedStyle(sidebar).flexShrink).toBe('0');
    expect(getComputedStyle(reader.closest('.local-library-center')!).flexGrow).toBe('1');
    expect(getComputedStyle(sidebar.parentElement!).flexDirection).toBe('row');
  } finally {
    style.remove();
  }
});
it('passes PDF page text and selection through to the global assistant', async () => {
  const { Host, onContext, user } = await fixture();
  render(<Host />);
  await user.click(await screen.findByRole('treeitem', { name: 'a.pdf' }));
  await user.click(await screen.findByRole('button', { name: 'Test PDF selection' }));
  expect(onContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 3, text: 'Page text', selection: 'Selected passage' }),
  );
});
it('updates an open Markdown tab and its reader when the file is renamed', async () => {
  const { Host, library, project, scan, user } = await fixture();
  render(<Host />);
  const file = await screen.findByRole('treeitem', { name: 'notes.md' });
  await user.click(file);
  await screen.findByRole('article', { name: 'Markdown 预览' });
  vi.mocked(library.command).mockResolvedValueOnce({
    ...scan,
    entries: scan.entries.map((entry) =>
      entry.path === 'notes.md' ? { ...entry, path: 'renamed.md', name: 'renamed.md' } : entry,
    ),
  });
  fireEvent.contextMenu(file);
  await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
  const dialog = await screen.findByRole('dialog', { name: '重命名' });
  await user.clear(within(dialog).getByRole('textbox', { name: '相对路径' }));
  await user.type(within(dialog).getByRole('textbox', { name: '相对路径' }), 'renamed.md');
  await user.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(library.readFile).toHaveBeenCalledWith(project.id, 'renamed.md'));
  expect(screen.getByRole('tab', { name: 'renamed.md' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'notes.md' })).toBeNull();
});
it('ignores a Markdown response after switching to another document', async () => {
  const { Host, library, onContext, user } = await fixture();
  let resolve!: (value: { path: string; content: string; version: string }) => void;
  vi.mocked(library.readFile!).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<Host />);
  await user.click(await screen.findByRole('treeitem', { name: 'notes.md' }));
  await waitFor(() => expect(library.readFile).toHaveBeenCalled());
  await user.click(screen.getByRole('treeitem', { name: 'b.pdf' }));
  await screen.findByLabelText('Test PDF');
  await act(async () =>
    resolve({ path: 'notes.md', content: 'Stale Markdown response', version: 'v1' }),
  );
  expect(onContext).not.toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Stale Markdown response' }),
  );
  expect(onContext).toHaveBeenLastCalledWith(expect.objectContaining({ resourceId: 'b' }));
});
it('closes PDF and note tabs only after a paired deletion succeeds', async () => {
  const { Host, library, scan, project, user } = await fixture();
  render(<Host />);
  await user.click(await screen.findByRole('treeitem', { name: 'a.pdf' }));
  await screen.findByRole('textbox', { name: '论文笔记正文' });
  vi.mocked(library.command).mockResolvedValueOnce({
    ...scan,
    entries: scan.entries.filter((e) => !['a.pdf', 'a.notes.md'].includes(e.path)),
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
  expect(screen.queryByRole('treeitem', { name: 'a.notes.md' })).toBeNull();
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

it('opens Markdown literature files in the center instead of launching an external app', async () => {
  const { Host, library, user } = await fixture();
  render(<Host />);
  await user.click(await screen.findByRole('treeitem', { name: 'notes.md' }));
  await screen.findByRole('article', { name: 'Markdown 预览' });
  expect(screen.getByText('Local notes')).toBeTruthy();
  expect(library.external).not.toHaveBeenCalled();
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

it('moves a Ctrl-selected bundle and keeps paired notes with their PDFs', async () => {
  const { Host, library, scan, project } = await fixture();
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
  const a = (await screen.findAllByRole('treeitem', { name: 'a.pdf' })).find(
    (item) => item.dataset.treeId === 'a.pdf',
  )!;
  const b = screen.getByRole('treeitem', { name: 'b.pdf' });
  fireEvent.click(a, { ctrlKey: true });
  fireEvent.click(b, { ctrlKey: true });
  expect(screen.getAllByRole('treeitem', { selected: true })).toHaveLength(2);
  expect(screen.queryByLabelText('Test PDF')).toBeNull();
  const transfer = { setData: vi.fn(), types: [], effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(a, { dataTransfer: transfer });
  fireEvent.drop(screen.getByRole('treeitem', { name: 'Reading' }), { dataTransfer: transfer });
  await waitFor(() =>
    expect(library.command).toHaveBeenCalledWith(project.id, {
      op: 'transfer',
      path: 'b.pdf',
      destination: 'Reading/b.pdf',
      copy: false,
    }),
  );
  expect(library.command).toHaveBeenCalledWith(project.id, {
    op: 'transfer',
    path: 'a.pdf',
    destination: 'Reading/a.pdf',
    copy: false,
  });
  expect(transfer.setData).toHaveBeenCalledWith(
    'application/x-scientify-library',
    '["a.pdf","b.pdf"]',
  );
  expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
  expect(screen.queryByRole('button', { name: '导入 PDF' })).toBeNull();
  expect(screen.queryByText('旧资料')).toBeNull();
});

it.each(['a.pdf', 'a.notes.md'])(
  'checks a conflicting %s before moving any file in a Shift-selected range',
  async (name) => {
    const { Host, library, scan } = await fixture();
    scan.entries.push({
      ...scan.entries[0],
      path: `Reading/${name}`,
      name,
      pdf: name.endsWith('.pdf'),
      note: name.endsWith('.notes.md'),
    });
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
    const a = (await screen.findAllByRole('treeitem', { name: 'a.pdf' })).find(
      (item) => item.dataset.treeId === 'a.pdf',
    )!;
    fireEvent.click(a, { ctrlKey: true });
    fireEvent.click(screen.getByRole('treeitem', { name: 'b.pdf' }), { shiftKey: true });
    const transfer = { setData: vi.fn(), types: [] };
    fireEvent.dragStart(a, { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole('treeitem', { name: 'Reading' }), { dataTransfer: transfer });
    await screen.findByText(`目标文件已存在：Reading/${name}`);
    expect(
      vi.mocked(library.command).mock.calls.filter(([, operation]) => operation.op === 'transfer'),
    ).toHaveLength(0);
  },
);

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
it('opens a real context menu and restores the embedded browser subscription entry', async () => {
  const { Host, user, library } = await fixture();
  render(<Host />);
  const entry = await screen.findByRole('treeitem', { name: 'a.pdf' });
  fireEvent.contextMenu(entry, { clientX: 100, clientY: 100 });
  await screen.findByRole('menuitem', { name: '打开论文笔记' });
  await user.click(screen.getByRole('menuitem', { name: '复制' }));
  await user.click(screen.getByRole('button', { name: '订阅' }));
  expect(screen.getByText('开发中')).toBeTruthy();
  expect(screen.getByText('敬请期待')).toBeTruthy();
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
