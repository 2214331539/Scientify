import { t } from '../../i18n';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyWorkspace, type Workspace } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { ResearchBackend } from '../../platform/research';
import { createWorkspaceStore } from '../../stores/workspace';
import { AssistantPanel } from './AssistantPanel';
import { getAgentRuntime } from './agent-runtime';
import type { AgentBackend, AgentEvent } from '../../platform/agent';
import { freezeContext, newConversation, requestMessages } from './model';

afterEach(cleanup);
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
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

it('preserves sent context after navigation and copies either message without hidden context or creating notes', async () => {
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
  const copy = vi.spyOn(navigator.clipboard, 'writeText');
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
  const messages = within(screen.getByRole('log', { name: '对话消息' }));
  expect(messages.queryByText('你')).toBeNull();
  expect(messages.queryByText('AI 助手')).toBeNull();
  expect(messages.queryByRole('button', { name: '保存为笔记' })).toBeNull();
  for (const [role, text] of [
    ['用户消息', '这个结论是什么？'],
    ['助手消息', '这是基于原文的分析。'],
  ]) {
    await user.click(
      within(messages.getByRole('article', { name: role })).getByRole('button', {
        name: '复制消息',
      }),
    );
    expect(copy).toHaveBeenLastCalledWith(text);
  }
  expect(store.getState().data?.records).toHaveLength(0);
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

async function actionHarness(model = 'test-model') {
  const data = emptyWorkspace();
  data.settings.model.model = model;
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
  const listModels = vi.fn(async () =>
    ['other-model', 'test-chat', 'test-model'].map((id) => ({ id, name: id })),
  );
  const testModel = vi.fn(async () => {});
  const backend = { askAI, listModels, testModel } as unknown as ResearchBackend;
  const view = render(
    <AssistantPanel store={store} backend={backend} scope="p1" context={context} />,
  );
  return { store, backend, askAI, listModels, testModel, view, user: userEvent.setup() };
}

it('context actions prepare and focus a question without sending or overwriting a draft', async () => {
  const { store, askAI, user } = await actionHarness();
  const composer = screen.getByLabelText('向 AI 提问') as HTMLTextAreaElement;
  expect(screen.queryByRole('button', { name: t('Explain') })).toBeNull();
  await user.click(screen.getByRole('button', { name: '查看当前材料' }));
  await user.click(screen.getByRole('button', { name: t('Explain') }));
  expect(composer.value).toBe('请解释当前材料中的关键概念与结论。');
  await waitFor(() => expect(document.activeElement).toBe(composer));
  expect(askAI).not.toHaveBeenCalled();
  expect(store.getState().data?.sessions).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: '查看当前材料' }));
  const summarize = screen.getByRole('button', {
    name: t('Summarize'),
  }) as HTMLButtonElement;
  expect(summarize.disabled).toBe(true);
  await user.click(summarize);
  expect(composer.value).toBe('请解释当前材料中的关键概念与结论。');
  await user.click(screen.getByRole('button', { name: '关闭弹窗' }));
  await user.clear(composer);
  await user.type(composer, '请保留我的问题');
  await user.click(screen.getByRole('button', { name: '查看当前材料' }));
  await user.click(screen.getByRole('button', { name: t('Explain') }));
  expect(composer.value).toBe('请保留我的问题');
  expect(askAI).not.toHaveBeenCalled();
});

it('context actions require attached material and match the current workspace', async () => {
  const { store, backend, askAI, view, user } = await actionHarness();
  await user.click(screen.getByRole('button', { name: '查看当前材料' }));
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
it('supports chat keyboard shortcuts without submitting Chinese IME composition', async () => {
  const { askAI, user } = await actionHarness();
  const input = screen.getByLabelText('向 AI 提问');
  await user.type(input, '第一行');
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  await user.type(input, '第二行');
  expect((input as HTMLTextAreaElement).value).toBe('第一行\n第二行');
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  expect(askAI).not.toHaveBeenCalled();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(askAI).toHaveBeenCalledTimes(1));
  await screen.findByText('回答');
});
it('switches configured models from the capsule and cancels unsaved configuration without losing a chat draft', async () => {
  const { store, user } = await actionHarness();
  const input = screen.getByLabelText('向 AI 提问') as HTMLTextAreaElement;
  await user.type(input, '保留草稿');
  await user.click(screen.getByRole('button', { name: '选择模型' }));
  await user.click(screen.getByRole('menuitem', { name: '配置其他模型' }));
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '选择模型' }), 'other-model');
  await user.click(screen.getByRole('button', { name: '关闭弹窗' }));
  expect(screen.getByRole('button', { name: '选择模型' }).textContent).toBe('test-model');
  await user.click(screen.getByRole('button', { name: '选择模型' }));
  await user.click(screen.getByRole('menuitem', { name: '配置其他模型' }));
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '选择模型' }), 'other-model');
  await user.click(screen.getByRole('button', { name: '保存模型配置' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(input.value).toBe('保留草稿');
  await user.click(screen.getByRole('button', { name: '选择模型' }));
  await user.click(
    within(screen.getByRole('menu', { name: '选择模型' })).getByRole('menuitemradio', {
      name: 'test-model',
    }),
  );
  await waitFor(() => expect(store.getState().data?.settings.model.model).toBe('test-model'));
  expect(store.getState().data?.settings.model.recentModels).toEqual(['test-model', 'other-model']);
  expect(input.value).toBe('保留草稿');
});

it('renames and deletes a saved conversation from its context menu', async () => {
  const { store, user, askAI } = await actionHarness();
  const composer = screen.getByLabelText('向 AI 提问');
  await user.type(composer, '需要重命名的问题');
  await user.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(askAI).toHaveBeenCalledOnce());
  await screen.findByText('回答');

  await user.click(screen.getByRole('button', { name: '当前 AI 对话' }));
  const historyItem = screen.getByRole('menuitemradio', { name: '需要重命名的问题' });
  fireEvent.contextMenu(historyItem);
  await user.click(screen.getByRole('menuitem', { name: '重命名对话' }));
  const renameDialog = await screen.findByRole('dialog', { name: '重命名对话' });
  const renameInput = within(renameDialog).getByRole('textbox');
  await user.clear(renameInput);
  await user.type(renameInput, '已重命名的会话');
  await user.click(within(renameDialog).getByRole('button', { name: '确认' }));
  await waitFor(() => expect(store.getState().data?.sessions[0]?.title).toBe('已重命名的会话'));

  await user.click(screen.getByRole('button', { name: '当前 AI 对话' }));
  const renamedItem = screen.getByRole('menuitemradio', { name: '已重命名的会话' });
  fireEvent.contextMenu(renamedItem);
  await user.click(screen.getByRole('menuitem', { name: '删除对话' }));
  const confirmDialog = await screen.findByRole('dialog', { name: '确认操作' });
  await user.click(within(confirmDialog).getByRole('button', { name: '确认' }));
  await waitFor(() => expect(store.getState().data?.sessions).toHaveLength(0));
  expect(screen.queryByText('需要重命名的问题')).toBeNull();
});

it('opens provider settings for an unconfigured chat and preserves the question through cancel and save', async () => {
  const { store, user, askAI } = await actionHarness('');
  const composer = screen.getByLabelText('向 AI 提问') as HTMLTextAreaElement;
  await user.type(composer, '保留这个问题');
  await user.keyboard('{Enter}');
  const dialog = await screen.findByRole('dialog', { name: '模型设置' });
  const settingsNavigation = within(screen.getByRole('navigation', { name: '模型设置导航' }));
  expect(settingsNavigation.getAllByRole('button')).toHaveLength(1);
  expect(settingsNavigation.getByRole('button', { name: '模型配置' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('textbox', { name: '模型名称' })).toBeNull();
  await user.selectOptions(screen.getByRole('combobox', { name: '模型提供方' }), 'openai');
  expect(screen.getByRole('dialog', { name: '模型设置' })).toBe(dialog);
  expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe(
    'https://api.openai.com/v1',
  );
  await user.type(screen.getByLabelText('API 密钥'), 'test-only-secret');
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(composer.value).toBe('保留这个问题');
  expect(store.getState().data?.settings.model.model).toBe('');
  expect(askAI).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '发送' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '模型提供方' }), 'openai');
  expect((screen.getByLabelText('API 密钥') as HTMLInputElement).value).toBe('');
  await user.type(screen.getByLabelText('API 密钥'), 'test-only-secret');
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '选择模型' }), 'test-chat');
  await user.click(screen.getByRole('button', { name: '保存模型配置' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(composer.value).toBe('保留这个问题');
  expect(askAI).not.toHaveBeenCalled();
  expect(store.getState().data?.settings.model.model).toBe('test-chat');
  expect(JSON.stringify(store.getState().data)).not.toContain('test-only-secret');
  await user.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(askAI).toHaveBeenCalledOnce());
  expect(askAI.mock.calls[0]).toEqual([
    expect.objectContaining({ provider: 'openai', model: 'test-chat', apiKey: 'test-only-secret' }),
  ]);
});

it('requires a successful chat probe before saving a public model catalog, retaining the key and draft on failure', async () => {
  const { user, store, testModel, listModels, askAI } = await actionHarness('');
  testModel.mockRejectedValueOnce(new Error('测试密钥 denied-test-secret 无权访问'));
  await user.type(screen.getByLabelText('向 AI 提问'), '不要发送我的研究材料');
  await user.click(screen.getByRole('button', { name: '发送' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '模型提供方' }), 'openrouter');
  const save = () => screen.getByRole('button', { name: '保存模型配置' }) as HTMLButtonElement;
  expect(save().disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  expect(listModels).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('API 密钥'), 'denied-test-secret');
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await user.click(save());
  expect((await screen.findByRole('alert')).textContent).toContain('[已隐藏密钥]');
  expect(screen.getByRole('alert').textContent).not.toContain('denied-test-secret');
  expect(store.getState().data?.settings.model.model).toBe('');
  expect((screen.getByLabelText('向 AI 提问') as HTMLTextAreaElement).value).toBe(
    '不要发送我的研究材料',
  );
  expect(askAI).not.toHaveBeenCalled();
  expect(testModel.mock.calls[0]).toEqual([
    expect.objectContaining({ model: 'other-model', apiKey: 'denied-test-secret' }),
  ]);
  await user.click(save());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(store.getState().data?.settings.model.modelCatalog).toEqual([
    'other-model',
    'test-chat',
    'test-model',
  ]);
});

it('ignores stale model discovery after changing providers and invalidates results when credentials change', async () => {
  const { user, listModels } = await actionHarness('');
  let finish!: (value: { id: string; name: string }[]) => void;
  listModels.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.type(screen.getByLabelText('向 AI 提问'), '问题');
  await user.click(screen.getByRole('button', { name: '发送' }));
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '模型提供方' }), 'deepseek');
  await act(async () => finish([{ id: 'stale-model', name: 'Stale model' }]));
  expect(screen.queryByRole('option', { name: 'Stale model' })).toBeNull();
  expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe(
    'https://api.deepseek.com/v1',
  );
  await user.type(screen.getByLabelText('API 密钥'), 'test-key');
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  const save = () => screen.getByRole('button', { name: '保存模型配置' }) as HTMLButtonElement;
  expect(save().disabled).toBe(false);
  await user.type(screen.getByLabelText('API 密钥'), 'changed');
  expect(save().disabled).toBe(true);
  expect(screen.queryByRole('option', { name: 'other-model' })).toBeNull();
});

it('supports custom provider protocols and returns no invented models for an empty catalog', async () => {
  const { user, listModels } = await actionHarness('');
  listModels.mockResolvedValueOnce([]);
  await user.type(screen.getByLabelText('向 AI 提问'), '问题');
  await user.click(screen.getByRole('button', { name: '发送' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '模型提供方' }), 'custom');
  await user.selectOptions(screen.getByRole('combobox', { name: '接口协议' }), 'gemini');
  await user.type(screen.getByLabelText('服务地址'), 'https://example.com/gateway/v1beta');
  await user.type(screen.getByLabelText('API 密钥'), 'test-only-key');
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  expect((await screen.findByRole('alert')).textContent).toBe('服务未返回可选的聊天模型。');
  expect(listModels).toHaveBeenCalledWith({
    endpoint: 'https://example.com/gateway/v1beta',
    apiKey: 'test-only-key',
    provider: 'gemini',
  });
  expect((screen.getByRole('button', { name: '保存模型配置' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it('routes a workspace prompt through the harness without a mode toggle', async () => {
  const data = emptyWorkspace();
  data.projects.push({
    id: 'p1',
    name: '项目一',
    question: '',
    createdAt: new Date().toISOString(),
    space: 'personal',
  });
  data.settings.model.model = 'test-model';
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save: async (value: Workspace) => value,
  } as unknown as WorkspaceBackend);
  await store.getState().load();

  const startThread = vi.fn(async () => ({ threadId: 't1', sandbox: 'readOnly' }));
  const startTurn = vi.fn(async () => ({ turnId: 'turn-1', status: 'completed', events: [] }));
  const setupSandbox = vi.fn(async () => ({ started: true, status: 'setupStarted' }));
  const agent = {
    status: vi.fn(),
    handshake: vi.fn(),
    domains: vi.fn(),
    startThread,
    setupSandbox,
    startTurn,
    events: vi.fn(async () => []),
    respond: vi.fn(),
  } as never;
  render(
    <AssistantPanel
      store={store}
      backend={{} as ResearchBackend}
      agent={agent}
      scope="p1"
      context={context}
    />,
  );
  expect(screen.queryByRole('button', { name: '切换到 Agent 模式' })).toBeNull();
  expect(screen.getByText('提问，或直接描述要在当前工作区完成的任务')).toBeTruthy();
  await userEvent.setup().type(screen.getByLabelText('向 AI 提问'), '读取当前项目');
  await userEvent.setup().click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(startThread).toHaveBeenCalledOnce());
  expect(startTurn).toHaveBeenCalledOnce();
  const setup = await screen.findByRole('button', { name: '配置 Windows 沙箱' });
  await userEvent.setup().click(setup);
  await waitFor(() => expect(setupSandbox).toHaveBeenCalledOnce());
  await userEvent.setup().click(screen.getByRole('button', { name: '新建 AI 对话' }));
  expect(screen.queryByText('读取当前项目')).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: '当前 AI 对话' }));
  expect(screen.getByRole('menuitemradio', { name: '读取当前项目' })).toBeTruthy();
});

async function keyHarness(load: () => Promise<string | null>) {
  const data = emptyWorkspace();
  data.settings.model = {
    endpoint: 'https://api.example.com/v1',
    model: 'test-model',
    provider: 'openai',
  };
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save: async (value: Workspace) => value,
  } as unknown as WorkspaceBackend);
  await store.getState().load();
  const askAI = vi.fn(async () => '回答');
  const listModels = vi.fn(async () => [{ id: 'test-chat', name: 'test-chat' }]);
  const credentials = {
    save: vi.fn(async () => undefined),
    load: vi.fn(load),
    clear: vi.fn(async () => undefined),
  };
  render(
    <AssistantPanel
      store={store}
      backend={
        { askAI, listModels, testModel: vi.fn(async () => undefined) } as unknown as ResearchBackend
      }
      scope="p1"
      context={context}
      credentials={credentials}
    />,
  );
  return { store, askAI, listModels, credentials, user: userEvent.setup() };
}

it('recalls the key filed for this endpoint instead of asking for it again', async () => {
  const { askAI, credentials, user } = await keyHarness(async () => 'stored-secret');
  await waitFor(() =>
    expect(credentials.load).toHaveBeenCalledWith({
      provider: 'openai',
      endpoint: 'https://api.example.com/v1',
    }),
  );
  await user.type(screen.getByLabelText('向 AI 提问'), '解释这个结论');
  await user.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(askAI).toHaveBeenCalledOnce());
  expect(askAI.mock.calls[0]).toEqual([
    expect.objectContaining({ provider: 'openai', model: 'test-model', apiKey: 'stored-secret' }),
  ]);
  // The settings dialog must show the recalled key rather than an empty field.
  await user.click(screen.getByRole('button', { name: '对话选项' }));
  await user.click(screen.getByRole('menuitem', { name: '模型设置' }));
  expect((screen.getByLabelText('API 密钥') as HTMLInputElement).value).toBe('stored-secret');
  expect(screen.getByText('已读取本机保存的密钥。')).toBeTruthy();
});

it('files a saved key against its own endpoint so another service cannot pick it up', async () => {
  const { credentials, listModels, user } = await keyHarness(async () => null);
  await user.click(screen.getByRole('button', { name: '对话选项' }));
  await user.click(screen.getByRole('menuitem', { name: '模型设置' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '模型提供方' }), 'deepseek');
  await user.type(screen.getByLabelText('API 密钥'), 'deepseek-key');
  await user.click(screen.getByRole('button', { name: '测试连接' }));
  await waitFor(() => expect(listModels).toHaveBeenCalledOnce());
  await user.click(screen.getByRole('button', { name: '保存模型配置' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // The slot is the protocol plus the endpoint, so the DeepSeek key can never be
  // offered on the OpenAI endpoint the panel started with.
  expect(credentials.save).toHaveBeenCalledWith(
    { provider: 'openai', endpoint: 'https://api.deepseek.com/v1' },
    'deepseek-key',
  );
  expect(credentials.save).not.toHaveBeenCalledWith(
    expect.objectContaining({ endpoint: 'https://api.example.com/v1' }),
    'deepseek-key',
  );
});

it('creates parallel chats, keeps the first binding after navigation, and saves background results after unmount', async () => {
  const data = emptyWorkspace();
  data.projects.push({
    id: 'p1',
    name: '研究项目',
    question: '',
    createdAt: '',
    space: 'personal',
  });
  data.settings.model.model = 'test-model';
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save: async (value: Workspace) => value,
  } as unknown as WorkspaceBackend);
  await store.getState().load();
  const events = new Map<string, AgentEvent[]>();
  const agent: AgentBackend = {
    status: vi.fn(),
    handshake: vi.fn(),
    domains: vi.fn(async () => []),
    startThread: vi.fn(async (projectId, domain, connection, { conversationId }) => ({
      threadId: conversationId,
      conversationId,
      domain,
      projectId,
      cwd: 'C:/' + domain,
      model: connection.model,
      modelProvider: 'scientify',
      instructionSources: [],
    })),
    startTurn: vi.fn(async (request) => ({
      turnId: 'turn-' + request.conversationId,
      status: 'inProgress',
      events: [],
    })),
    events: vi.fn(async (_p, _d, id) => events.get(id)?.splice(0) ?? []),
    respond: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const runtime = getAgentRuntime(store, agent);
  const props = { store, backend: {} as ResearchBackend, agent, scope: 'p1', context };
  const view = render(<AssistantPanel {...props} />);
  const user = userEvent.setup();
  try {
    await user.type(screen.getByLabelText('向 AI 提问'), '任务 A');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(agent.startTurn).toHaveBeenCalledTimes(1));
    const first = vi.mocked(agent.startTurn).mock.calls[0][0];
    expect(first.domain).toBe('literature');
    await user.click(screen.getByRole('button', { name: '新建 AI 对话' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '执行工作区' }), 'code');
    await user.type(screen.getByLabelText('向 AI 提问'), '任务 B');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(agent.startTurn).toHaveBeenCalledTimes(2));
    const second = vi.mocked(agent.startTurn).mock.calls[1][0];
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(second.domain).toBe('code');
    await user.click(screen.getByRole('button', { name: /任务 A/ }));
    view.rerender(<AssistantPanel {...props} context={{ ...context, workspace: 'experiments' }} />);
    expect((screen.getByRole('combobox', { name: '执行工作区' }) as HTMLSelectElement).value).toBe(
      'literature',
    );
    await user.click(screen.getByRole('button', { name: '中止任务' }));
    expect(agent.interrupt).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: first.conversationId }),
    );
    view.unmount();
    for (const [request, text, status] of [
      [first, 'A 停止', 'interrupted'],
      [second, 'B 完成', 'completed'],
    ] as const)
      events.set(request.conversationId, [
        {
          kind: 'notification',
          method: 'turn/completed',
          params: {
            threadId: request.threadId,
            turn: {
              id: 'turn-' + request.conversationId,
              status,
              items: [{ id: 'answer', type: 'agentMessage', text }],
            },
          },
        },
      ]);
    await act(async () => {
      await runtime.poll();
    });
    await waitFor(() => expect(Object.keys(store.getState().agentTasks)).toHaveLength(0));
    expect(
      store.getState().data!.sessions.find((item) => item.id === first.conversationId)?.agentStatus,
    ).toBe('interrupted');
    expect(
      store.getState().data!.sessions.find((item) => item.id === second.conversationId)
        ?.agentStatus,
    ).toBe('completed');
    expect(JSON.stringify(store.getState().data!.sessions)).toContain('B 完成');
  } finally {
    runtime.dispose();
  }
});
