import { t } from '../i18n';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace, type Workspace } from '../domain/workspace';
import { createNote } from '../features/notes/model';
import type { WorkspaceBackend } from '../platform/desktop';
import type { ResearchBackend } from '../platform/research';
import { createWorkspaceStore } from '../stores/workspace';
import { App } from './App';

vi.mock('../platform/library', async (original) => {
  const actual = await original<typeof import('../platform/library')>();
  return {
    ...actual,
    nativeLibrary: {
      ...actual.nativeLibrary,
      command: async (project: string) => ({
        root: `F:/isolated/${project}`,
        warnings: [],
        papers: [],
        entries: [
          {
            path: `${project}.md`,
            name: project === 'p1' ? 'Tool retrieval paper.md' : 'Protein representation paper.md',
            directory: false,
            pdf: false,
            note: false,
            size: 64,
            paperId: null,
          },
        ],
      }),
      readFile: async (project: string, path: string) => ({
        path,
        version: 'v1',
        content:
          project === 'p1'
            ? 'Project A evidence about lifelong retrieval.'
            : 'Project B evidence about molecular structure.',
      }),
      changed: async () => () => {},
    },
  };
});
vi.mock('../platform/browser-pane', () => ({
  browserCommand: async () => [],
  browserEvents: async () => () => {},
  browserLayout: async () => {},
}));

beforeAll(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
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

function fixture({ failSaves = false } = {}) {
  const data = emptyWorkspace();
  data.projects = [
    {
      id: 'p1',
      name: 'ToolHCL',
      question: 'Continual Tool Retrieval',
      space: 'personal',
      createdAt: '2026-09-24T01:00:00.000Z',
    },
    {
      id: 'p2',
      name: 'Protein Study',
      question: 'Protein representation learning',
      space: 'personal',
      createdAt: '2026-09-24T01:00:00.000Z',
    },
  ];
  data.papers = [
    {
      id: 'paper-a',
      projects: ['p1'],
      title: 'Tool retrieval paper',
      abstract: 'Project A evidence about lifelong retrieval.',
    },
    {
      id: 'paper-b',
      projects: ['p2'],
      title: 'Protein representation paper',
      abstract: 'Project B evidence about molecular structure.',
    },
  ];
  data.records = [
    createNote('p1', 'A research note', 'Original note A'),
    createNote('p2', 'B research note', 'Original note B'),
  ];
  data.settings.model = { endpoint: 'http://test.invalid', model: 'isolated-test-model' };
  let disk = structuredClone(data);
  const save = vi.fn(async (value: Workspace) => {
    if (failSaves) throw new Error('Test disk is offline');
    disk = structuredClone(value);
    return structuredClone(disk);
  });
  const adapter: WorkspaceBackend = {
    load: async () => ({
      workspace: structuredClone(disk),
      directory: 'isolated/shell-test',
      legacyAvailable: false,
    }),
    save,
    restore: async () => structuredClone(disk),
    migrateLegacy: async () => structuredClone(disk),
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  let answers = 0;
  const backend: ResearchBackend = {
    listFiles: vi.fn(async () => [
      { path: 'data/results.csv', name: 'results.csv', kind: 'file' as const, size: 32 },
      { path: 'paper/draft.md', name: 'draft.md', kind: 'file' as const, size: 16 },
      { path: 'experiments/train.py', name: 'train.py', kind: 'file' as const, size: 24 },
    ]),
    readFile: vi.fn(async (_project, path) => ({ path, content: '', version: 'v1' })),
    writeFile: vi.fn(async (_project, path, content) => ({ path, content, version: 'v2' })),
    importPdf: vi.fn(async () => null),
    readPdf: vi.fn(async () => new Uint8Array()),
    gitStatus: vi.fn(async () => []),
    listModels: async () => [],
    testModel: async () => {},
    askAI: vi.fn(async () => `Isolated answer ${++answers}`),
  };
  // Exercise migration from the previous UI session, including an open assistant.
  localStorage.setItem(
    'scientify.ui.v1',
    JSON.stringify({
      version: 1,
      projectId: 'p1',
      space: 'personal',
      locations: {},
      dock: 'assistant',
      dockOpen: true,
      leftWidth: 240,
      rightWidth: 340,
    }),
  );
  return { store: createWorkspaceStore(adapter), backend, save };
}

function rail() {
  return within(screen.getByLabelText('一级导航', { selector: 'nav' }));
}

async function selectProject(user: ReturnType<typeof userEvent.setup>, name: string) {
  if (screen.queryByLabelText('项目管理', { selector: 'section' })) {
    await user.click(screen.getByRole('button', { name }));
    return;
  }
  await user.click(screen.getByLabelText('切换项目'));
  await user.click(within(screen.getByLabelText('项目切换')).getByRole('button', { name }));
}

it('provides the five primary workspace destinations and starts with AI closed', async () => {
  const { store, backend } = fixture();
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('navigation', { name: '一级导航' });

  expect(
    rail()
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label')),
  ).toEqual([t('Overview'), t('Literature'), t('Notes'), t('Experiments'), t('Paper')]);
  for (const button of rail().getAllByRole('button')) expect(button.textContent).toBe('');
  const topbar = within(
    screen.getByRole('button', { name: 'Scientify 项目管理' }).closest('header')!,
  );
  expect(topbar.queryByRole('button', { name: 'AI 助手' })).toBeNull();
  expect(topbar.queryByRole('button', { name: '研究笔记' })).toBeNull();
  const statusbar = within(screen.getByRole('contentinfo'));
  expect(statusbar.getByRole('button', { name: 'AI 助手' }).textContent).toBe('');
  expect(statusbar.getByRole('button', { name: '研究笔记' }).textContent).toBe('');
  expect(statusbar.queryByText(t('Overview'))).toBeNull();
  expect(
    rail()
      .getByRole('button', { name: t('Overview') })
      .getAttribute('aria-current'),
  ).toBe('page');
  expect(screen.queryByRole('region', { name: 'AI 助手内容' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: '向 AI 提问' })).toBeNull();
  expect(backend.askAI).not.toHaveBeenCalled();

  const trigger = statusbar.getByRole('button', { name: 'AI 助手' });
  expect(trigger.getAttribute('aria-pressed')).toBe('false');
  await user.click(trigger);
  expect(screen.getByPlaceholderText(t('Ask about this project...'))).toBeTruthy();
  expect(trigger.getAttribute('aria-pressed')).toBe('true');
  await user.click(screen.getByRole('button', { name: '收起辅助栏' }));
  expect(screen.queryByRole('textbox', { name: '向 AI 提问' })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(backend.askAI).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Scientify 项目管理' }));
  expect(screen.queryByRole('complementary', { name: '工作区导航' })).toBeNull();
  const spaces = within(screen.getByRole('complementary', { name: '项目空间' }));
  expect(spaces.getByRole('button', { name: '设置' })).toBeTruthy();
  expect(spaces.queryByRole('button', { name: '数据与备份' })).toBeNull();
  await selectProject(user, 'ToolHCL');
  expect(rail().getByRole('button', { name: t('Literature') })).toBeTruthy();
});

it('updates assistant context with the active material and isolates project conversations and requests', async () => {
  const { store, backend } = fixture();
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('navigation', { name: '一级导航' });
  await user.click(screen.getByLabelText('AI 助手', { selector: 'button' }));
  let assistant = within(screen.getByRole('region', { name: 'AI 助手内容' }));
  await user.click(assistant.getByRole('button', { name: '对话选项' }));
  await user.click(screen.getByRole('menuitem', { name: '查看当前材料' }));
  expect(assistant.getByText('ToolHCL')).toBeTruthy();
  expect(assistant.getByText(t('Overview'))).toBeTruthy();
  await user.click(screen.getByLabelText('关闭弹窗'));

  await user.click(rail().getByRole('button', { name: t('Literature') }));
  await user.click(
    within(await screen.findByRole('complementary', { name: t('本地文献目录') })).getByRole(
      'treeitem',
      {
        name: 'Tool retrieval paper.md',
      },
    ),
  );
  await user.click(assistant.getByRole('button', { name: '对话选项' }));
  await user.click(screen.getByRole('menuitem', { name: '查看当前材料' }));
  expect(assistant.getByText(t('Literature'))).toBeTruthy();
  expect(assistant.getByText('p1.md')).toBeTruthy();
  await user.click(screen.getByLabelText('关闭弹窗'));
  await user.click(assistant.getByRole('textbox', { name: '向 AI 提问' }));
  await user.paste('Question for project A');
  await user.click(assistant.getByRole('button', { name: '发送' }));
  await assistant.findByText('Isolated answer 1');
  await waitFor(() => expect(store.getState().dirty).toBe(false));

  await selectProject(user, 'Protein Study');
  assistant = within(screen.getByRole('region', { name: 'AI 助手内容' }));
  await user.click(assistant.getByRole('button', { name: '对话选项' }));
  await user.click(screen.getByRole('menuitem', { name: '查看当前材料' }));
  expect(assistant.getByText('Protein Study')).toBeTruthy();
  expect(assistant.getByText(t('Overview'))).toBeTruthy();
  expect(assistant.queryByText('Question for project A')).toBeNull();
  expect(assistant.queryByText('Isolated answer 1')).toBeNull();
  expect(assistant.queryByText('p1.md')).toBeNull();
  await user.click(screen.getByLabelText('关闭弹窗'));
  await user.click(rail().getByRole('button', { name: t('Literature') }));
  await user.click(
    within(await screen.findByRole('complementary', { name: t('本地文献目录') })).getByRole(
      'treeitem',
      {
        name: 'Protein representation paper.md',
      },
    ),
  );
  await user.click(assistant.getByRole('button', { name: '对话选项' }));
  await user.click(screen.getByRole('menuitem', { name: '查看当前材料' }));
  expect(assistant.getByText('p2.md')).toBeTruthy();
  await user.click(screen.getByLabelText('关闭弹窗'));
  await user.click(assistant.getByRole('textbox', { name: '向 AI 提问' }));
  await user.paste('Question for project B');
  await user.click(assistant.getByRole('button', { name: '发送' }));
  await assistant.findByText('Isolated answer 2');
  const requests = vi.mocked(backend.askAI).mock.calls;
  expect(requests).toHaveLength(2);
  const first = JSON.stringify(requests[0][0].messages);
  const second = JSON.stringify(requests[1][0].messages);
  expect(first).toContain('Project A evidence');
  expect(first).not.toContain('Project B evidence');
  expect(second).toContain('Project B evidence');
  expect(second).not.toContain('Project A evidence');
  expect(second).not.toContain('Question for project A');

  await selectProject(user, 'ToolHCL');
  assistant = within(screen.getByRole('region', { name: 'AI 助手内容' }));
  expect(assistant.getByText('Isolated answer 1')).toBeTruthy();
  expect(assistant.queryByText('Isolated answer 2')).toBeNull();
});

it('keeps one unsaved note editor through side, central, hidden and project transitions', async () => {
  const { store, backend } = fixture({ failSaves: true });
  const user = userEvent.setup();
  const view = render(<App store={store} backend={backend} />);
  await screen.findByRole('navigation', { name: '一级导航' });
  await user.click(screen.getByRole('button', { name: '研究笔记' }));
  await user.click(
    within(screen.getByRole('region', { name: '研究笔记内容' })).getByRole('button', {
      name: /A research note/,
    }),
  );
  const firstEditor = screen.getByRole('textbox', { name: '笔记正文' }) as HTMLTextAreaElement;
  await user.type(firstEditor, ' + unsaved A');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(store.getState().error).toBe('Test disk is offline'));
  expect(store.getState().dirtySources['notes:p1']).toBe(true);
  expect(store.getState().data?.records[0].body).toBe('Original note A');

  await user.click(rail().getByRole('button', { name: t('Notes') }));
  const main = screen.getByRole('main', { name: t('Notes workspace') });
  expect(within(main).getByRole('textbox', { name: '笔记正文' })).toBe(firstEditor);
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(view.container.querySelectorAll('[aria-label="笔记正文"]')).toHaveLength(1);
  expect(firstEditor.value).toBe('Original note A + unsaved A');

  await user.click(rail().getByRole('button', { name: t('Literature') }));
  expect(screen.getByRole('textbox', { name: '笔记正文' })).toBe(firstEditor);
  expect(screen.queryByRole('main', { name: t('Notes workspace') })).toBeNull();
  await user.click(screen.getByRole('button', { name: '收起辅助栏' }));
  expect(screen.queryByRole('textbox', { name: '笔记正文' })).toBeNull();
  expect(view.container.contains(firstEditor)).toBe(true);
  await user.click(screen.getByRole('button', { name: '研究笔记' }));
  expect(screen.getByRole('textbox', { name: '笔记正文' })).toBe(firstEditor);
  expect(firstEditor.value).toBe('Original note A + unsaved A');

  await selectProject(user, 'Protein Study');
  const secondPanel = within(screen.getByRole('region', { name: '研究笔记内容' }));
  expect(secondPanel.queryByRole('textbox', { name: '笔记正文' })).toBeNull();
  expect(secondPanel.queryByRole('button', { name: /A research note/ })).toBeNull();
  await user.click(secondPanel.getByRole('button', { name: /B research note/ }));
  const secondEditor = screen.getByRole('textbox', { name: '笔记正文' }) as HTMLTextAreaElement;
  expect(secondEditor).not.toBe(firstEditor);
  expect(secondEditor.value).toBe('Original note B');
  await user.type(secondEditor, ' + unsaved B');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(store.getState().busy).toBe(false));

  await selectProject(user, 'ToolHCL');
  expect(screen.getByRole('textbox', { name: '笔记正文' })).toBe(firstEditor);
  expect(firstEditor.value).toBe('Original note A + unsaved A');
  expect(screen.getAllByRole('textbox', { name: '笔记正文' })).toHaveLength(1);
  expect(view.container.querySelectorAll('[aria-label="笔记正文"]')).toHaveLength(2);
  expect(store.getState().dirtySources['notes:p1']).toBe(true);
  expect(store.getState().dirtySources['notes:p2']).toBe(true);
  expect(store.getState().data?.records.map((note) => note.body)).toEqual([
    'Original note A',
    'Original note B',
  ]);
});

it('does not expose a standalone Files destination in the primary navigation', async () => {
  const { store, backend } = fixture();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('navigation', { name: '一级导航' });
  expect(rail().queryByRole('button', { name: t('Files') })).toBeNull();
  expect(backend.listFiles).not.toHaveBeenCalled();
});

it('keeps the same note editor during interrupted central fades and restores the side panel after settling', async () => {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  const jobs: { finish(): void; cancel(): void }[] = [];
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: vi.fn(() => {
      let finish!: () => void;
      let cancel!: () => void;
      const finished = new Promise<void>((resolve, reject) => {
        finish = resolve;
        cancel = () => reject(new Error('cancelled'));
      });
      jobs.push({ finish, cancel });
      return { finished, cancel } as unknown as Animation;
    }),
  });
  const { store, backend } = fixture();
  try {
    await act(async () => {
      render(<App store={store} backend={backend} />);
    });
    fireEvent.click(screen.getByLabelText('研究笔记', { selector: 'button' }));
    fireEvent.click(screen.getByRole('button', { name: /A research note/ }));
    const editor = (await screen.findByLabelText('笔记正文')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'unsaved fade draft' } });
    editor.setSelectionRange(2, 9);
    editor.scrollTop = 30;
    const notes = editor.closest('.sf-dock-notes') as HTMLElement;
    fireEvent.click(rail().getByRole('button', { name: t('Notes') }));
    expect(jobs.length).toBeGreaterThan(0);
    fireEvent.click(rail().getByRole('button', { name: t('Overview') }));
    expect(notes.classList.contains('notes-workspace-surface')).toBe(true);
    expect(notes.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(rail().getByRole('button', { name: t('Notes') }));
    await act(async () => jobs.forEach((job) => job.finish()));
    expect(notes.hidden).toBe(false);
    expect(within(screen.getByRole('main')).getByLabelText('笔记正文')).toBe(editor);
    fireEvent.click(rail().getByRole('button', { name: t('Overview') }));
    await act(async () => jobs.forEach((job) => job.finish()));
    expect(notes.classList.contains('notes-workspace-surface')).toBe(false);
    expect(notes.hidden).toBe(false);
    expect(
      within(screen.getByRole('complementary', { name: '全局辅助工具' })).getByLabelText(
        '笔记正文',
      ),
    ).toBe(editor);
    expect(editor.value).toBe('unsaved fade draft');
    expect([editor.selectionStart, editor.selectionEnd, editor.scrollTop]).toEqual([2, 9, 30]);
  } finally {
    cleanup();
    if (previous) Object.defineProperty(HTMLElement.prototype, 'animate', previous);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  }
});

it('keeps unavailable workspaces as placeholders without loading files or disabling the assistant', async () => {
  const { store, backend } = fixture();
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('region', { name: t('Overview') });
  expect(screen.getByText(t('开发中'))).toBeTruthy();
  await user.click(rail().getByRole('button', { name: t('Paper') }));
  const paper = within(screen.getByRole('region', { name: t('LaTeX 论文撰写') }));
  expect(paper.getByText(t('敬请期待'))).toBeTruthy();
  expect(screen.queryByRole('button', { name: t('Manuscript') })).toBeNull();
  expect(backend.listFiles).not.toHaveBeenCalled();
  expect(backend.readFile).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'AI 助手' }));
  const draft = screen.getByRole('textbox', { name: '向 AI 提问' });
  await user.type(draft, 'Keep my question');
  await user.click(rail().getByRole('button', { name: t('Literature') }));
  await user.click(screen.getByRole('button', { name: t('Subscriptions') }));
  expect(
    within(screen.getByRole('region', { name: t('文献订阅') })).getByText(t('开发中')),
  ).toBeTruthy();
  expect(screen.getByRole('textbox', { name: '向 AI 提问' })).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe('Keep my question');
  expect(backend.askAI).not.toHaveBeenCalled();
});
