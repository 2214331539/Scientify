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
    changed: async () => () => {},
  };
  const backend: ResearchBackend = {
    listFiles: async () => [],
    readFile: vi.fn(),
    writeFile: vi.fn(),
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    gitStatus: async () => [],
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
  const { Host, library, scan, user } = await fixture();
  render(<Host />);
  await user.click(await screen.findByRole('treeitem', { name: 'a.pdf' }));
  await screen.findByRole('textbox', { name: '论文笔记正文' });
  vi.mocked(library.command).mockResolvedValueOnce({
    ...scan,
    entries: scan.entries.filter((e) => e.path !== 'a.pdf'),
    papers: scan.papers.filter((p) => p.id !== 'a'),
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'a.pdf' }));
  await user.click(await screen.findByRole('menuitem', { name: '移入回收站' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '论文笔记正文' })).toBeNull());
  expect(screen.queryByRole('tab', { name: 'a.pdf' })).toBeNull();
  expect(screen.getByRole('treeitem', { name: 'b.pdf' })).toBeTruthy();
  confirm.mockRestore();
});
it('opens a requested source only after its local binding is available', async () => {
  const { Host } = await fixture('b');
  render(<Host />);
  await screen.findByRole('textbox', { name: '论文笔记正文' });
  expect(
    within(screen.getByRole('tablist', { name: '文献标签页' })).getByRole('tab', { name: 'b.pdf' }),
  ).toBeTruthy();
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
