import { t } from '../../i18n';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace, type Workspace } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { ResearchBackend } from '../../platform/research';
import { createWorkspaceStore } from '../../stores/workspace';
import { AssistantPanel } from './AssistantPanel';
import { freezeContext, newConversation, requestMessages } from './model';

afterEach(cleanup);
const context: WorkContext = {
  projectId: 'p1',
  workspace: 'literature',
  resourceId: 'paper1',
  title: '论文一',
  selection: '独立的原始结论',
};

it('captures a bounded context snapshot and keeps historical materials attached to their own messages', () => {
  const source = { ...context, text: 'a'.repeat(15000) };
  const snapshot = freezeContext(source);
  source.title = '另一篇文章';
  source.selection = '被替换的材料';
  expect(snapshot.title).toBe('论文一');
  expect(snapshot.text).toHaveLength(12000);
  const conversation = newConversation('p1');
  conversation.messages.push({
    id: 'm',
    role: 'user',
    text: '解释',
    context: snapshot,
    createdAt: '',
  });
  expect(requestMessages(conversation)[1].content).toContain('独立的原始结论');
  expect(requestMessages(conversation)[1].content).not.toContain('被替换的材料');
});

it('uses the actual backend, preserves sent context after navigation and saves an answer as a scoped note', async () => {
  const data = emptyWorkspace();
  data.settings.model = { endpoint: 'http://localhost:11434', model: 'test-model' };
  data.sessions.push({
    id: 'other',
    project: 'p2',
    title: '项目二对话',
    context: [],
    messages: [],
    updatedAt: '',
  });
  const persistence: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save: async (value: Workspace) => value,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(persistence);
  await store.getState().load();
  let answer!: (value: string) => void;
  const askAI = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  );
  const backend = { askAI } as unknown as ResearchBackend;
  const user = userEvent.setup();
  const view = render(
    <AssistantPanel store={store} backend={backend} scope="p1" context={context} />,
  );
  expect(screen.queryByText('项目二对话')).toBeNull();
  await user.type(screen.getByLabelText('向 AI 提问'), '这个结论是什么？');
  await user.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(askAI).toHaveBeenCalledTimes(1));
  view.rerender(
    <AssistantPanel
      store={store}
      backend={backend}
      scope="p1"
      context={{ ...context, title: '论文二', resourceId: 'paper2', selection: '不同结论' }}
    />,
  );
  expect(askAI.mock.calls[0]?.length).toBe(1);
  await act(async () => answer('这是基于原文的分析。'));
  await screen.findByText('这是基于原文的分析。');
  await user.click(screen.getByRole('button', { name: '保存为笔记' }));
  await waitFor(() => expect(store.getState().data?.records).toHaveLength(1));
  const note = store.getState().data!.records[0];
  expect(note.project).toBe('p1');
  expect(note.body).toBe('这是基于原文的分析。');
  expect(note.sources).toEqual([
    expect.objectContaining({ title: '论文一', selection: '独立的原始结论' }),
  ]);
  const stored = store.getState().data!.sessions.find((item) => item.project === 'p1');
  expect(stored?.context).toEqual([expect.objectContaining({ title: '论文一' })]);
});

it('reports service failures explicitly and keeps the saved question available for retry', async () => {
  const data = emptyWorkspace();
  data.settings.model.model = 'test-model';
  const persistence: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save: async (value: Workspace) => value,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const store = createWorkspaceStore(persistence);
  await store.getState().load();
  const backend = {
    askAI: vi.fn(async () => {
      throw new Error('模型服务连接失败');
    }),
  } as unknown as ResearchBackend;
  const user = userEvent.setup();
  render(<AssistantPanel store={store} backend={backend} scope="p1" context={context} />);
  await user.type(screen.getByLabelText('向 AI 提问'), '解释一下');
  await user.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('模型服务连接失败');
  expect(screen.getByRole('button', { name: '重试本次请求' })).toBeTruthy();
  expect(store.getState().data!.sessions[0].messages).toHaveLength(1);
  expect(screen.queryByText('这是基于原文的分析。')).toBeNull();
});

async function actionHarness() {
  const data = emptyWorkspace();
  data.settings.model.model = 'test-model';
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save: async (value) => value,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  });
  await store.getState().load();
  const askAI = vi.fn(async () => '回答');
  const backend = { askAI } as unknown as ResearchBackend;
  const view = render(
    <AssistantPanel store={store} backend={backend} scope="p1" context={context} />,
  );
  return { store, backend, askAI, view, user: userEvent.setup() };
}

it('context actions prepare and focus a question without sending or overwriting a draft', async () => {
  const { store, askAI, user } = await actionHarness();
  const composer = screen.getByLabelText('向 AI 提问') as HTMLTextAreaElement;
  await user.click(screen.getByRole('button', { name: t('Explain') }));
  expect(composer.value).toBe('请解释当前材料中的关键概念与结论。');
  expect(document.activeElement).toBe(composer);
  expect(askAI).not.toHaveBeenCalled();
  expect(store.getState().data?.sessions).toHaveLength(0);
  const summarize = screen.getByRole('button', {
    name: t('Summarize'),
  }) as HTMLButtonElement;
  expect(summarize.disabled).toBe(true);
  await user.click(summarize);
  expect(composer.value).toBe('请解释当前材料中的关键概念与结论。');
  await user.clear(composer);
  await user.type(composer, '请保留我的问题');
  await user.click(screen.getByRole('button', { name: t('Explain') }));
  expect(composer.value).toBe('请保留我的问题');
  expect(askAI).not.toHaveBeenCalled();
});

it('context actions require attached material and match the current workspace', async () => {
  const { store, backend, askAI, view, user } = await actionHarness();
  const disabled = (name: string) =>
    (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;
  expect(disabled(t('Explain'))).toBe(false);
  expect(disabled(t('Improve writing'))).toBe(true);
  expect(disabled(t('Analyze experiment'))).toBe(true);
  await user.click(screen.getByLabelText('发送时附带当前材料'));
  expect(disabled(t('Explain'))).toBe(true);
  await user.click(screen.getByLabelText('发送时附带当前材料'));
  view.rerender(
    <AssistantPanel
      store={store}
      backend={backend}
      scope="p1"
      context={{ ...context, workspace: 'writing', text: '论文草稿', selection: undefined }}
    />,
  );
  expect(disabled(t('Improve writing'))).toBe(false);
  expect(disabled(t('Analyze experiment'))).toBe(true);
  view.rerender(
    <AssistantPanel
      store={store}
      backend={backend}
      scope="p1"
      context={{ ...context, workspace: 'experiments', text: '运行结果', selection: undefined }}
    />,
  );
  expect(disabled(t('Improve writing'))).toBe(true);
  expect(disabled(t('Analyze experiment'))).toBe(false);
  view.rerender(
    <AssistantPanel
      store={store}
      backend={backend}
      scope="p1"
      context={{ ...context, workspace: 'experiments', selection: undefined }}
    />,
  );
  expect(disabled(t('Explain'))).toBe(true);
  expect(disabled(t('Summarize'))).toBe(true);
  expect(disabled(t('Analyze experiment'))).toBe(true);
  expect(askAI).not.toHaveBeenCalled();
});
