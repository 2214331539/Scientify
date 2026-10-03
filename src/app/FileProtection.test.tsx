import { t } from '../i18n';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { emptyWorkspace, type Project } from '../domain/workspace';
import type { FileContent, ResearchBackend } from '../platform/research';
import type { WorkspaceBackend } from '../platform/desktop';
import { createWorkspaceStore } from '../stores/workspace';
import { getFileSession, type FileSession } from '../editor/sessions';
import { App } from './App';
import { codeContext } from '../workspaces/experiments/code-context';
import { AgentRuntime } from '../features/assistant/agent-runtime';
import { newConversation } from '../features/assistant/model';
import type { AgentBackend, AgentEvent } from '../platform/agent';

const nativeWindow = vi.hoisted(() => ({
  close: undefined as undefined | ((event: { preventDefault(): void }) => Promise<void>),
  destroy: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (command: string) => {
    if (command === 'experiment_list') return [];
    if (command === 'research_git_diff') return '@@ -1 +1 @@\n-old\n+new\n';
    if (command === 'code_git_diff') return '@@ -1 +1 @@\n-old\n+new\n';
    if (command === 'code_git_inspect')
      return {
        root: 'F:/old',
        repository: true,
        branch: 'main',
        head: '123456',
        changes: [{ path: 'paper.md', status: ' M' }],
        branches: [],
        history: [],
        stashes: [],
        worktrees: [],
        busy: false,
      };
    return undefined;
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => nativeWindow.close?.({ preventDefault() {} }),
    onCloseRequested: async (listener: typeof nativeWindow.close) => {
      nativeWindow.close = listener;
      return () => {
        nativeWindow.close = undefined;
      };
    },
    destroy: nativeWindow.destroy,
  }),
}));
vi.mock('../editor/CodeEditor', () => ({
  CodeEditor: ({ session }: { session: FileSession }) => {
    const data = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return (
      <textarea
        aria-label={`编辑 ${session.path}`}
        value={data.content}
        onChange={(event) => session.edit(event.target.value)}
      />
    );
  },
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
  codeContext.setState({ roots: {} });
  nativeWindow.destroy.mockClear();
});

function setup() {
  const data = emptyWorkspace();
  const project: Project = {
    id: 'p1',
    name: 'Directory test',
    question: '',
    path: 'F:/old',
    space: 'personal',
    createdAt: '2026-09-23',
  };
  data.projects.push(project);
  let root = project.path;
  const workspace: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: 'data', legacyAvailable: false }),
    save: vi.fn(async (value) => {
      root = value.projects[0]?.path;
      return value;
    }),
    restore: vi.fn(async () => data),
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => 'F:/new',
  };
  const backend: ResearchBackend = {
    listFiles: vi.fn(async () => [
      { path: 'paper.md', name: 'paper.md', kind: 'file' as const, size: 12 },
    ]),
    readFile: vi.fn(async (_project, path) => ({
      path,
      content: root === 'F:/old' ? '# Old root' : '# New root',
      version: 'v1',
    })),
    writeFile: vi.fn(async (_project, path, content) => ({ path, content, version: 'v2' })),
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    gitStatus: async () => [],
    listModels: async () => [],
    testModel: async () => {},
    askAI: async () => '',
    fetchArxiv: async () => '',
  };
  localStorage.setItem(
    'scientify.ui.v1',
    JSON.stringify({
      version: 1,
      projectId: 'p1',
      locations: {
        p1: { workspace: 'writing', view: 'files', paths: { writing: 'paper.md' }, paperId: null },
      },
    }),
  );
  return { store: createWorkspaceStore(workspace), backend, workspace };
}

it('remembers the code view after opening a changed file and leaving the workspace', async () => {
  const { store, backend } = setup();
  backend.gitStatus = vi.fn(async () => [{ path: 'paper.md', status: 'M' }]);
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('textbox', { name: '编辑 paper.md' });
  await user.click(screen.getByRole('button', { name: t('Experiments') }));
  await user.click(screen.getByRole('button', { name: 'Git' }));
  await user.click(await screen.findByRole('button', { name: '查看更改 paper.md' }));
  await user.click(screen.getByRole('button', { name: t('打开文件') }));
  expect(
    (await screen.findByRole('button', { name: t('Code') })).getAttribute('aria-current'),
  ).toBe('page');
  await user.click(screen.getByRole('button', { name: t('Overview') }));
  await user.click(screen.getByRole('button', { name: t('Experiments') }));
  expect(screen.getByRole('button', { name: t('Code') }).getAttribute('aria-current')).toBe('page');
  expect(await screen.findByRole('textbox', { name: '编辑 paper.md' })).toBeTruthy();
});

it('blocks native close and workspace replacement while a clean-looking file save is pending', async () => {
  const { store, backend, workspace } = setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('textbox', { name: '编辑 paper.md' });
  const session = getFileSession(backend, 'p1', 'paper.md');
  let complete!: (file: FileContent) => void;
  backend.writeFile = vi.fn(
    () =>
      new Promise<FileContent>((resolve) => {
        complete = resolve;
      }),
  );
  let saving!: Promise<boolean>;
  await act(async () => {
    session.edit('submitted');
    saving = session.save();
    session.edit('# Old root');
  });
  expect(session.getSnapshot().dirty).toBe(false);
  expect(store.getState().dirtySources.files).toBe(true);
  await act(async () => {
    expect(await store.getState().replace('restore')).toBe(false);
  });
  expect(workspace.restore).not.toHaveBeenCalled();
  const event = { preventDefault: vi.fn() };
  await nativeWindow.close?.(event);
  expect(event.preventDefault).toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: '关闭窗口' }));
  expect(nativeWindow.destroy).not.toHaveBeenCalled();
  await act(async () => {
    complete({ path: 'paper.md', content: 'submitted', version: 'v2' });
    await saving;
  });
});

it('allows native close after an interrupted AI result is saved', async () => {
  const { store, backend } = setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('textbox', { name: '编辑 paper.md' });
  const events: AgentEvent[] = [];
  const agent = {
    startThread: async () => ({ threadId: 'thread', cwd: 'F:/old' }),
    startTurn: async () => ({ turnId: 'turn', status: 'inProgress', events: [] }),
    events: async () => events.splice(0),
    interrupt: async () => {
      events.push({
        kind: 'notification',
        method: 'turn/completed',
        params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } },
      });
    },
  } as unknown as AgentBackend;
  const runtime = new AgentRuntime(store, agent);
  const chat = newConversation('p1');
  try {
    await act(async () => {
      await runtime.send(
        chat,
        'code',
        { endpoint: 'http://localhost/v1', model: 'test', provider: 'openai' },
        '运行实验',
      );
    });
    await act(async () => {
      await nativeWindow.close?.({ preventDefault() {} });
    });
    expect(nativeWindow.destroy).not.toHaveBeenCalled();
    await act(async () => {
      await runtime.get('p1', chat.id)!.session.interrupt();
    });
    await waitFor(() => expect(store.getState().agentTasks).toEqual({}));
    await act(async () => {
      await nativeWindow.close?.({ preventDefault() {} });
    });
    expect(nativeWindow.destroy).toHaveBeenCalledOnce();
    expect(store.getState().data!.sessions.find((s) => s.id === chat.id)?.agentStatus).toBe(
      'interrupted',
    );
  } finally {
    runtime.dispose();
  }
});

it('blocks directory changes with drafts and reloads the tree and editor after a clean rebind', async () => {
  const { store, backend } = setup();
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('textbox', { name: '编辑 paper.md' });
  const original = getFileSession(backend, 'p1', 'paper.md');
  await act(async () => {
    original.edit('dirty buffer');
  });
  await user.click(screen.getByRole('button', { name: '切换项目' }));
  await user.click(screen.getByRole('button', { name: '项目设置' }));
  expect((screen.getByRole('button', { name: '选择目录' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await user.click(screen.getByRole('button', { name: '关闭弹窗' }));
  await act(async () => {
    original.edit('# Old root');
  });
  const previousListings = vi.mocked(backend.listFiles).mock.calls.length;
  await user.click(screen.getByRole('button', { name: '切换项目' }));
  await user.click(screen.getByRole('button', { name: '项目设置' }));
  await user.click(screen.getByRole('button', { name: '选择目录' }));
  await user.click(screen.getByRole('button', { name: '保存项目' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
    ).toBe('# New root'),
  );
  expect(getFileSession(backend, 'p1', 'paper.md')).not.toBe(original);
  expect(vi.mocked(backend.listFiles).mock.calls.length).toBeGreaterThan(previousListings);
});

it('opens the exact experiment source, remembers selection, and opens a recent note directly', async () => {
  const { store, backend } = setup();
  const user = userEvent.setup();
  render(<App store={store} backend={backend} />);
  await screen.findByRole('textbox', { name: '编辑 paper.md' });
  await act(async () => {
    await store.getState().update((draft) => {
      draft.runs.push(
        {
          id: 'r-old',
          project: 'p1',
          name: 'Ablation result',
          protocol: '',
          config: '',
          conclusion: 'Older experiment',
          status: 'completed',
          updatedAt: '2026-09-20',
          metrics: [],
        },
        {
          id: 'r-new',
          project: 'p1',
          name: 'Latest result',
          protocol: '',
          config: '',
          conclusion: 'Latest experiment',
          status: 'completed',
          updatedAt: '2026-09-23',
          metrics: [],
        },
      );
      draft.records.push({
        id: 'n1',
        project: 'p1',
        title: 'Insight note',
        body: 'Keep the useful conclusion.',
        type: 'note',
        status: 'draft',
        createdAt: '2026-09-23',
        updatedAt: '2026-09-23',
      });
    });
  });
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('scientify-open-source', {
        detail: {
          projectId: 'p1',
          workspace: 'experiments',
          resourceId: 'r-old',
          title: 'Ablation result',
        },
      }),
    );
  });
  expect(await screen.findByRole('heading', { name: 'Ablation result' })).toBeTruthy();
  expect(screen.getByRole('button', { name: t('Runs') }).getAttribute('aria-current')).toBe('page');
  expect(JSON.parse(localStorage.getItem('scientify.ui.v2')!).locations.p1.runId).toBe('r-old');
  await user.click(screen.getByRole('button', { name: /Latest result/ }));
  expect(JSON.parse(localStorage.getItem('scientify.ui.v2')!).locations.p1.runId).toBe('r-new');
  await user.click(screen.getByRole('button', { name: t('Overview') }));
  await user.click(screen.getAllByRole('button', { name: /Insight note/ })[0]);
  expect(((await screen.findByLabelText('笔记标题')) as HTMLInputElement).value).toBe(
    'Insight note',
  );
  expect((screen.getByLabelText('笔记正文') as HTMLTextAreaElement).value).toBe(
    'Keep the useful conclusion.',
  );
  await user.click(screen.getByRole('button', { name: t('Experiments') }));
  await user.click(screen.getByRole('button', { name: t('Runs') }));
  expect(await screen.findByRole('heading', { name: 'Latest result' })).toBeTruthy();
});
