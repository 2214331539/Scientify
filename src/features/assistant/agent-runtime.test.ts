import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from './agent-runtime';
import { newConversation, asConversation } from './model';
import { createWorkspaceStore } from '../../stores/workspace';
import { emptyWorkspace, type Workspace } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { AgentBackend, AgentEvent } from '../../platform/agent';

const connection = {
  endpoint: 'http://localhost/v1',
  model: 'test-model',
  provider: 'openai' as const,
};
const runtimes: AgentRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  vi.useRealTimers();
});
async function harness() {
  const data = emptyWorkspace();
  for (const id of ['p1', 'p2'])
    data.projects.push({ id, name: id, question: '', space: 'personal', createdAt: '' });
  let disk = data;
  const save = vi.fn(async (draft: Workspace, revision: number) => {
    if (disk.revision !== revision) throw new Error('工作区已发生变化，请重新载入后再保存。');
    disk = structuredClone(draft);
    return disk;
  });
  const store = createWorkspaceStore({
    load: async () => ({ workspace: disk, directory: 'test', legacyAvailable: false }),
    save,
  } as unknown as WorkspaceBackend);
  await store.getState().load();
  const queues = new Map<string, AgentEvent[]>();
  const drain = (id: string) => queues.get(id)?.splice(0) ?? [];
  const agent: AgentBackend = {
    status: vi.fn(),
    handshake: vi.fn(),
    domains: vi.fn(),
    startThread: vi.fn(async (projectId, domain, _, options) => ({
      threadId: `thread-${options.conversationId}`,
      conversationId: options.conversationId,
      projectId,
      domain,
      cwd: `C:/${projectId}/${domain}`,
      model: 'test-model',
      modelProvider: 'scientify',
      instructionSources: [],
      sandbox: 'workspaceWrite',
    })),
    startTurn: vi.fn(async (request) => ({
      turnId: `turn-${request.conversationId}`,
      status: 'inProgress',
      events: [],
    })),
    events: vi.fn(async (_project, _domain, id) => drain(id)),
    interrupt: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const runtime = new AgentRuntime(store, agent);
  runtimes.push(runtime);
  function complete(id: string, text: string, status = 'completed') {
    queues.set(id, [
      {
        kind: 'notification',
        method: 'item/agentMessage/delta',
        params: { threadId: `thread-${id}`, turnId: `turn-${id}`, itemId: 'answer', delta: text },
      },
      {
        kind: 'notification',
        method: 'turn/completed',
        params: { threadId: `thread-${id}`, turn: { id: `turn-${id}`, status } },
      },
    ]);
  }
  return {
    store,
    save,
    agent,
    runtime,
    queues,
    complete,
    externalEdit: () => {
      disk = structuredClone(disk);
      disk.revision++;
      disk.projects[1].name = '其他窗口的修改';
    },
  };
}

describe('local task ownership', () => {
  it('passes each conversation root independently and resumes its saved binding', async () => {
    const { store, runtime, agent, complete } = await harness();
    vi.mocked(agent.startThread).mockImplementation(async (projectId, domain, _, options) => ({
      threadId: `thread-${options.conversationId}`,
      conversationId: options.conversationId,
      projectId,
      domain,
      cwd: options.workspaceRoot!,
      model: 'test-model',
      modelProvider: 'scientify',
      instructionSources: [],
    }));
    const a = { ...newConversation('p1'), agentCwd: 'F:/repo/main' };
    const b = { ...newConversation('p1'), agentCwd: 'F:/repo/worktree' };
    await Promise.all([
      runtime.send(a, 'code', connection, 'A'),
      runtime.send(b, 'code', connection, 'B'),
    ]);
    expect(agent.startThread).toHaveBeenCalledWith('p1', 'code', connection, {
      conversationId: a.id,
      workspaceRoot: a.agentCwd,
    });
    expect(agent.startThread).toHaveBeenCalledWith('p1', 'code', connection, {
      conversationId: b.id,
      workspaceRoot: b.agentCwd,
    });
    complete(a.id, 'A done');
    complete(b.id, 'B done');
    await runtime.poll();
    await vi.waitFor(() => expect(runtime.get('p1', a.id)?.finished).toBe(true));
    const saved = asConversation(store.getState().data!.sessions.find((s) => s.id === a.id)!);
    expect(saved.agentCwd).toBe(a.agentCwd);
    await runtime.resume(saved, connection);
    expect(agent.startThread).toHaveBeenLastCalledWith('p1', 'code', connection, {
      conversationId: a.id,
      workspaceRoot: a.agentCwd,
    });
  });
  it('runs two chats in one directory independently; approvals and stopping stay with the selected chat', async () => {
    const { store, agent, runtime, queues, complete } = await harness();
    const a = newConversation('p1'),
      b = newConversation('p1');
    await Promise.all([
      runtime.send(a, 'code', connection, '任务 A'),
      runtime.send(b, 'code', { ...connection, model: 'other-model' }, '任务 B'),
    ]);
    expect(agent.startThread).toHaveBeenCalledTimes(2);
    expect(Object.keys(store.getState().agentTasks)).toHaveLength(2);
    expect(store.getState().dirty).toBe(false);
    queues.set(a.id, [
      {
        kind: 'request',
        id: 'approval',
        method: 'item/fileChange/requestApproval',
        params: { threadId: `thread-${a.id}`, turnId: `turn-${a.id}` },
      },
    ]);
    await runtime.poll();
    expect(runtime.get('p1', a.id)?.state.phase).toBe('waiting');
    expect(runtime.get('p1', b.id)?.state.phase).toBe('running');
    await runtime.get('p1', a.id)!.session.interrupt();
    expect(agent.interrupt).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: a.id, turnId: `turn-${a.id}` }),
    );
    expect(runtime.get('p1', a.id)?.state.phase).toBe('stopping');
    complete(a.id, 'A 部分结果', 'interrupted');
    complete(b.id, 'B 完整结果');
    await runtime.poll();
    await vi.waitFor(() => expect(Object.keys(store.getState().agentTasks)).toHaveLength(0));
    const chats = store.getState().data!.sessions.map(asConversation);
    expect(chats.find((chat) => chat.id === a.id)?.messages.map((message) => message.text)).toEqual(
      ['任务 A', 'A 部分结果'],
    );
    expect(chats.find((chat) => chat.id === b.id)?.messages.map((message) => message.text)).toEqual(
      ['任务 B', 'B 完整结果'],
    );
    expect(chats.find((chat) => chat.id === a.id)?.agentStatus).toBe('interrupted');
    expect(chats.find((chat) => chat.id === b.id)?.agentStatus).toBe('completed');
  });
  it('persists across projects without subscribers and preserves a rename during execution', async () => {
    const { store, runtime, complete } = await harness();
    const a = newConversation('p1'),
      b = newConversation('p2');
    const unsubscribe = runtime.subscribe(() => {});
    await Promise.all([
      runtime.send(a, 'literature', connection, 'A'),
      runtime.send(b, 'code', connection, 'B'),
    ]);
    unsubscribe();
    await store.getState().update((data) => {
      data.sessions.find((chat) => chat.id === a.id)!.title = '人工命名';
    });
    complete(a.id, '结果 A');
    complete(b.id, '结果 B');
    await runtime.poll();
    await vi.waitFor(() => expect(runtime.get('p2', b.id)?.finished).toBe(true));
    expect(store.getState().data!.sessions.find((chat) => chat.id === a.id)?.title).toBe(
      '人工命名',
    );
    expect(
      asConversation(store.getState().data!.sessions.find((chat) => chat.id === b.id)!).messages.at(
        -1,
      )?.text,
    ).toBe('结果 B');
  });
  it('keeps failed result saves for retry without duplication or repeating the model call', async () => {
    const { store, save, agent, runtime, complete } = await harness();
    const chat = newConversation('p1');
    await runtime.send(chat, 'code', connection, '任务');
    save.mockRejectedValueOnce(new Error('disk full'));
    complete(chat.id, '需要保留的结果');
    await runtime.poll();
    const task = runtime.get('p1', chat.id)!;
    await vi.waitFor(() => expect(task.saveError).toBe('disk full'));
    expect(Object.keys(store.getState().agentTasks)).toHaveLength(1);
    await expect(runtime.remove('p1', chat.id)).rejects.toThrow();
    await runtime.retrySave(task);
    await runtime.poll();
    expect(agent.startTurn).toHaveBeenCalledOnce();
    expect(asConversation(store.getState().data!.sessions[0]).messages.map((m) => m.text)).toEqual([
      '任务',
      '需要保留的结果',
    ]);
    const calls = save.mock.calls.length;
    await runtime.poll();
    expect(save).toHaveBeenCalledTimes(calls);
  });
  it('never launches a model if the user message cannot be saved; a manual retry is usable', async () => {
    const { store, save, agent, runtime } = await harness();
    const chat = newConversation('p1');
    save.mockRejectedValueOnce(new Error('disk full'));
    expect(await runtime.send(chat, 'code', connection, '任务')).toBe(false);
    expect(agent.startThread).not.toHaveBeenCalled();
    expect(runtime.get('p1', chat.id)).toBeUndefined();
    expect(Object.keys(store.getState().agentTasks)).toHaveLength(0);
    expect(await runtime.send(chat, 'code', connection, '任务')).toBe(true);
  });
  it('blocks deletion and root replacement while allowing unrelated saves and navigation', async () => {
    const { store, runtime } = await harness();
    const chat = newConversation('p1');
    await runtime.send(chat, 'code', connection, '任务');
    await expect(runtime.remove('p1', chat.id)).rejects.toThrow();
    expect(
      await store.getState().update((data) => {
        data.projects = data.projects.filter((project) => project.id !== 'p1');
      }),
    ).toBe(false);
    expect(
      await store.getState().update((data) => {
        data.projects[0].path = 'C:/another';
      }),
    ).toBe(false);
    expect(
      await store.getState().update((data) => {
        data.settings.name = 'new name';
      }),
    ).toBe(true);
    expect(await store.getState().replace('restore')).toBe(false);
    expect(store.getState().dirty).toBe(false);
  });
  it('restores native history by stable turn id without replaying a prompt', async () => {
    const { store, agent, runtime } = await harness();
    const chat = {
      ...newConversation('p1'),
      agentDomain: 'code' as const,
      agentStatus: 'running' as const,
    };
    await store.getState().update((data) => {
      data.sessions.push(chat);
    });
    vi.mocked(agent.startThread).mockResolvedValue({
      threadId: 'native-history',
      conversationId: chat.id,
      projectId: 'p1',
      domain: 'code',
      cwd: 'C:/p1/code',
      model: 'test',
      modelProvider: 'scientify',
      instructionSources: [],
      turns: [
        {
          id: 'past-turn',
          status: 'completed',
          items: [{ id: 'answer', type: 'agentMessage', text: '从引擎恢复' }],
        },
      ],
    });
    await runtime.resume(chat, connection);
    await runtime.resume(chat, connection);
    expect(agent.startTurn).not.toHaveBeenCalled();
    expect(asConversation(store.getState().data!.sessions[0]).messages.map((m) => m.text)).toEqual([
      '从引擎恢复',
    ]);
    expect(store.getState().data!.sessions[0].agentStatus).toBe('interrupted');
  });
  it('releases an idle sidecar and resumes the same conversation on the next request', async () => {
    const { store, agent, runtime, complete } = await harness();
    const chat = newConversation('p1');
    await runtime.send(chat, 'code', connection, '首次');
    complete(chat.id, '完成');
    await runtime.poll();
    await vi.waitFor(() => expect(runtime.get('p1', chat.id)?.finished).toBe(true));
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    await runtime.poll();
    expect(agent.release).toHaveBeenCalledWith('p1', 'code', chat.id);
    expect(runtime.get('p1', chat.id)).toBeUndefined();
    await runtime.send(
      asConversation(store.getState().data!.sessions[0]),
      'code',
      connection,
      '接着做',
    );
    expect(agent.startThread).toHaveBeenLastCalledWith('p1', 'code', connection, {
      conversationId: chat.id,
      workspaceRoot: 'C:/p1/code',
    });
  });
  it('clears close protection when idle release overlaps another chat update', async () => {
    const { store, agent, runtime, complete, queues } = await harness();
    const a = newConversation('p1'),
      b = newConversation('p2');
    await runtime.send(a, 'code', connection, 'A');
    complete(a.id, 'A 已中止', 'interrupted');
    await runtime.poll();
    await vi.waitFor(() => expect(runtime.get('p1', a.id)?.finished).toBe(true));
    await runtime.send(b, 'code', connection, 'B');
    runtime.get('p1', a.id)!.lastActivity = Date.now() - 61_000;
    let released!: () => void;
    vi.mocked(agent.release!).mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          released = done;
        }),
    );
    const recycling = runtime.poll();
    await vi.waitFor(() => expect(released).toBeTypeOf('function'));
    queues.set(b.id, [
      {
        kind: 'notification',
        method: 'item/agentMessage/delta',
        params: { threadId: `thread-${b.id}`, turnId: `turn-${b.id}`, delta: 'B 正在输出' },
      },
    ]);
    await runtime.get('p2', b.id)!.session.poll();
    released();
    await recycling;
    expect(runtime.get('p1', a.id)).toBeUndefined();
    expect(store.getState().agentTasks).toEqual({ [`p2:${b.id}`]: 'p2' });
    complete(b.id, 'B 完成');
    await runtime.poll();
    await vi.waitFor(() => expect(store.getState().agentTasks).toEqual({}));
  });
});

it('seeds a legacy conversation only into its own newly created native thread', async () => {
  const { store, agent, runtime } = await harness();
  const chat = newConversation('p1');
  chat.messages.push({ id: 'old', role: 'user', text: '本会话已有结论', createdAt: '' });
  await store.getState().update((data) => {
    data.sessions.push(chat);
    data.sessions.push({
      ...newConversation('p1'),
      messages: [{ id: 'other', role: 'user', text: '另一会话的私有内容', createdAt: '' }],
    });
  });
  const original = agent.startThread;
  agent.startThread = vi.fn(async (...args: Parameters<AgentBackend['startThread']>) => ({
    ...(await original(...args)),
    freshThread: true,
  }));
  await runtime.send(chat, 'code', connection, '继续');
  expect(vi.mocked(agent.startTurn).mock.calls[0][0].text).toContain('本会话已有结论');
  expect(vi.mocked(agent.startTurn).mock.calls[0][0].text).not.toContain('另一会话的私有内容');
});

it('rebases a failed result save on the current disk revision without losing another window’s edit', async () => {
  const { store, runtime, complete, externalEdit } = await harness();
  const chat = newConversation('p1');
  await runtime.send(chat, 'code', connection, '任务');
  externalEdit();
  complete(chat.id, '应保留的结果');
  await runtime.poll();
  const task = runtime.get('p1', chat.id)!;
  await vi.waitFor(() => expect(task.saveError).toContain('工作区已发生变化'));
  await runtime.retrySave(task);
  expect(task.saveError).toBeNull();
  expect(store.getState().data!.projects[1].name).toBe('其他窗口的修改');
  expect(asConversation(store.getState().data!.sessions[0]).messages.at(-1)?.text).toBe(
    '应保留的结果',
  );
});
