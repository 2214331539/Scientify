import { t } from '../i18n';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace, type Workspace } from '../domain/workspace';
import { createNote } from '../features/notes/model';
import type { WorkspaceBackend } from '../platform/desktop';
import type { ResearchBackend } from '../platform/research';
import { createWorkspaceStore } from '../stores/workspace';
import { App } from './App';
import { resetBrowserDocs } from '../platform/docs';
import { resetDocsRuntimes } from '../workspaces/docs/runtime';

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
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetDocsRuntimes();
  resetBrowserDocs();
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
  if (screen.queryByRole('complementary', { name: '项目中心导航' })) {
    await user.click(screen.getAllByRole('button', { name })[0]);
    return;
  }
  await user.click(screen.getByLabelText('切换项目'));
  await user.click(
    within(screen.getByRole('menu', { name: '项目切换' })).getByRole('menuitemradio', { name }),
  );
}

it('provides four project modules, title bar tools and starts with AI closed', async () => {
  const { store, backend } = fixture();
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('navigation', { name: '一级导航' });

  expect(
    rail()
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['文献', '文档', '实验', '写作']);
  expect(rail().getByRole('button', { name: '文献' }).getAttribute('aria-current')).toBe('page');
  const titlebar = within(screen.getByRole('button', { name: '回到项目中心' }).closest('header')!);
  expect(screen.queryByRole('contentinfo')).toBeNull();
  expect(screen.queryByRole('region', { name: 'AI 助手内容' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: '向 AI 提问' })).toBeNull();
  expect(backend.askAI).not.toHaveBeenCalled();

  const trigger = titlebar.getByRole('button', { name: 'AI 助手' });
  expect(titlebar.getByRole('button', { name: '文档' })).toBeTruthy();
  expect(trigger.getAttribute('aria-pressed')).toBe('false');
  await user.click(trigger);
  expect(screen.getByPlaceholderText(t('Ask about this project...'))).toBeTruthy();
  expect(trigger.getAttribute('aria-pressed')).toBe('true');
  await user.click(screen.getByRole('button', { name: '收起辅助栏' }));
  expect(screen.queryByRole('textbox', { name: '向 AI 提问' })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(backend.askAI).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: '回到项目中心' }));
  expect(screen.queryByRole('complementary', { name: '工作区导航' })).toBeNull();
  const center = within(screen.getByRole('complementary', { name: '项目中心导航' }));
  expect(center.getByRole('button', { name: '设置' })).toBeTruthy();
  expect(center.queryByRole('button', { name: /收集箱/ })).toBeNull();
  expect(titlebar.queryByRole('button', { name: 'AI 助手' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '后退' }));
  expect(rail().getByRole('button', { name: '文献' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '前进' }));
  expect(screen.getByRole('complementary', { name: '项目中心导航' })).toBeTruthy();
  await selectProject(user, 'ToolHCL');
  expect(rail().getByRole('button', { name: '实验' })).toBeTruthy();
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
  expect(assistant.getAllByText(t('Literature')).length).toBeGreaterThan(0);
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
  expect(assistant.getAllByText(t('Literature')).length).toBeGreaterThan(0);
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

it('keeps a document open in the right-hand panel for each project', async () => {
  const { store, backend } = fixture();
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('navigation', { name: '一级导航' });
  await user.click(screen.getByRole('button', { name: '文档', pressed: false }));
  // Old notes were moved into documents under “笔记”.
  const dock = () => within(screen.getByRole('complementary', { name: '全局辅助工具' }));
  await user.click((await dock().findAllByRole('button', { name: '展开' }, { timeout: 4000 }))[0]);
  await user.click(dock().getByRole('button', { name: /A research note/ }));
  expect(
    (await dock().findByRole('textbox', { name: '页面标题' })) as HTMLTextAreaElement,
  ).toHaveProperty('value', 'A research note');

  await selectProject(user, 'Protein Study');
  expect(dock().queryByRole('textbox', { name: '页面标题' })).toBeNull();
  await user.click((await dock().findAllByRole('button', { name: '展开' }, { timeout: 4000 }))[0]);
  expect(dock().queryByRole('button', { name: /A research note/ })).toBeNull();
  await user.click(dock().getByRole('button', { name: /B research note/ }));
  expect(
    ((await dock().findByRole('textbox', { name: '页面标题' })) as HTMLTextAreaElement).value,
  ).toBe('B research note');

  await selectProject(user, 'ToolHCL');
  expect(
    ((await dock().findByRole('textbox', { name: '页面标题' })) as HTMLTextAreaElement).value,
  ).toBe('A research note');
  // Old notes keep their records, marked as moved.
  await waitFor(() =>
    expect(
      store.getState().data?.records.map((note) => (note as { migratedTo?: string }).migratedTo),
    ).toEqual([
      'note-' + store.getState().data!.records[0].id,
      'note-' + store.getState().data!.records[1].id,
    ]),
  );
});

it('does not expose a standalone Files destination in the primary navigation', async () => {
  const { store, backend } = fixture();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('navigation', { name: '一级导航' });
  expect(rail().queryByRole('button', { name: t('Files') })).toBeNull();
  expect(backend.listFiles).not.toHaveBeenCalled();
});

it('opens documents as a module with the page tree in the sidebar', async () => {
  const { store, backend } = fixture();
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('navigation', { name: '一级导航' });
  await user.click(rail().getByRole('button', { name: '文档' }));
  expect(await screen.findByRole('heading', { name: '文档' })).toBeTruthy();
  expect(screen.getByRole('tree', { name: '页面' })).toBeTruthy();
  // The title bar does not offer a second documents panel while the module is open.
  expect(screen.queryByRole('button', { name: '文档', pressed: false })).toBeNull();
  const home = screen.getByRole('heading', { name: '文档' }).closest('.doc-home') as HTMLElement;
  await user.click(within(home).getByRole('button', { name: '新建页面' }));
  expect(
    ((await screen.findByRole('textbox', { name: '页面标题' })) as HTMLTextAreaElement).value,
  ).toBe('');
});

it('opens manuscripts in writing and keeps the assistant draft across modules', async () => {
  const { store, backend } = fixture();
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('navigation', { name: '一级导航' });
  await user.click(rail().getByRole('button', { name: '写作' }));
  expect(await screen.findByRole('heading', { name: t('还没有稿件') })).toBeTruthy();
  await waitFor(() => expect(backend.listFiles).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: t('新建稿件…') })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'AI 助手' }));
  const draft = screen.getByRole('textbox', { name: '向 AI 提问' });
  await user.type(draft, 'Keep my question');
  await user.click(rail().getByRole('button', { name: t('Literature') }));
  await user.click(screen.getByRole('button', { name: t('Subscriptions') }));
  expect(
    within(screen.getByRole('region', { name: t('文献订阅') })).getByRole('button', {
      name: /打开浏览器/,
    }),
  ).toBeTruthy();
  expect(screen.getByRole('textbox', { name: '向 AI 提问' })).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe('Keep my question');
  expect(backend.askAI).not.toHaveBeenCalled();
});
