import { describe, expect, it, vi } from 'vitest';
import type { ResearchBackend, ChatResult } from '../../platform/research';
import type { WorkspaceBackend } from '../../platform/desktop';
import { emptyWorkspace } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import { asConversation, newConversation } from './model';
import { ChatRuntime } from './chat-runtime';

async function setup() {
  const data = emptyWorkspace();
  data.projects.push({ id: 'p1', name: 'P1', question: '', space: 'personal', createdAt: '' });
  const save = vi.fn(async (value) => value);
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save,
  } as unknown as WorkspaceBackend);
  await store.getState().load();
  const calls: {
    delta(text: string): void;
    resolve(result: ChatResult): void;
    reject(error: Error): void;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  const backend = {
    streamAI: vi.fn((_request, delta) => {
      let resolve!: (value: ChatResult) => void;
      let reject!: (value: Error) => void;
      const result = new Promise<ChatResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const cancel = vi.fn(async () => {});
      calls.push({ delta, resolve, reject, cancel });
      return { result, cancel };
    }),
  } as unknown as ResearchBackend;
  const runtime = new ChatRuntime(store, backend);
  const request = {
    endpoint: 'http://localhost/v1',
    provider: 'openai' as const,
    model: 'test-model',
    apiKey: 'fixture-secret',
    messages: [{ role: 'user' as const, content: 'hello' }],
  };
  function seed(project = 'p1') {
    const chat = newConversation(project);
    chat.messages.push({ id: crypto.randomUUID(), text: 'hello', role: 'user', createdAt: '' });
    return chat;
  }
  return { store, save, runtime, calls, request, seed };
}

describe('application-owned ordinary chat tasks', () => {
  it('keeps an unsent question in an existing chat after a failed save without invoking the model', async () => {
    const { store, save, runtime, calls, request, seed } = await setup();
    const chat = seed();
    await store.getState().update((data) => {
      data.sessions.push(structuredClone(chat));
    });
    chat.messages.push({
      id: 'unsent-question',
      role: 'user',
      text: 'Keep this question',
      createdAt: '',
    });
    save.mockRejectedValueOnce(new Error('disk failure'));
    expect(await runtime.send(chat, request)).toBe(false);
    const task = runtime.get('p1', chat.id)!;
    expect(task.questionSaved).toBe(false);
    expect(await runtime.retrySave(task)).toBe(true);
    expect(calls).toHaveLength(0);
    expect(
      asConversation(store.getState().data!.sessions[0]).messages.map((message) => message.id),
    ).toContain('unsent-question');
    expect(asConversation(store.getState().data!.sessions[0]).chatRun?.status).toBe('failed');
  });
  it('streams two conversations independently and preserves concurrent metadata changes', async () => {
    const { store, runtime, calls, request, seed } = await setup();
    const a = seed(),
      b = seed();
    await runtime.send(a, request);
    await runtime.send(b, { ...request, model: 'second-model' });
    expect(Object.keys(store.getState().agentTasks)).toHaveLength(2);
    calls[0].delta('第一');
    calls[1].delta('第二');
    calls[0].delta('个回答');
    expect(runtime.get('p1', a.id)?.text).toBe('第一个回答');
    expect(runtime.get('p1', b.id)?.text).toBe('第二');
    await store.getState().update((data) => {
      data.sessions.find((item) => item.id === a.id)!.title = 'Renamed while running';
    });
    calls[1].resolve({ text: '第二个回答', interrupted: false });
    calls[0].resolve({ text: '第一个回答', interrupted: false });
    await vi.waitFor(() => expect(Object.keys(store.getState().agentTasks)).toHaveLength(0));
    const chats = store.getState().data!.sessions.map(asConversation);
    expect(chats.find((chat) => chat.id === a.id)?.title).toBe('Renamed while running');
    expect(chats.find((chat) => chat.id === b.id)?.messages[1].text).toBe('第二个回答');
    expect(chats.find((chat) => chat.id === b.id)?.chatRun?.model).toBe('second-model');
    expect(JSON.stringify(chats)).not.toContain('fixture-secret');
  });

  it('continues after subscribers leave and stops only the selected request, saving partial output', async () => {
    const { store, runtime, calls, request, seed } = await setup();
    const chat = seed();
    const listener = vi.fn(),
      unsubscribe = runtime.subscribe(listener);
    await runtime.send(chat, request);
    unsubscribe();
    calls[0].delta('部分内容');
    const task = runtime.get('p1', chat.id)!;
    await runtime.cancel(task);
    expect(calls[0].cancel).toHaveBeenCalledOnce();
    calls[0].resolve({ text: '部分内容', interrupted: true });
    await vi.waitFor(() => expect(task.saving || task.pending).toBe(false));
    const saved = asConversation(store.getState().data!.sessions[0]);
    expect(saved.messages[1].text).toBe('部分内容');
    expect(saved.chatRun?.status).toBe('interrupted');
    expect(await runtime.send(saved, request)).toBe(true);
    calls[1].resolve({ text: '下一次回答', interrupted: false });
    await vi.waitFor(() => expect(runtime.get('p1', chat.id)?.pending).toBe(false));
  });

  it('retains partial output on failure, redacts keys, and does not replay requests', async () => {
    const { store, runtime, calls, request, seed } = await setup();
    const chat = seed();
    await runtime.send(chat, request);
    calls[0].delta('已收到的内容');
    calls[0].reject(new Error('fixture-secret: disconnected'));
    await vi.waitFor(() => expect(runtime.get('p1', chat.id)?.pending).toBe(false));
    expect(calls).toHaveLength(1);
    await vi.waitFor(() =>
      expect(asConversation(store.getState().data!.sessions[0]).chatRun?.status).toBe('failed'),
    );
    expect(JSON.stringify(store.getState().data)).not.toContain('fixture-secret');
    expect(asConversation(store.getState().data!.sessions[0]).messages[1].text).toBe(
      '已收到的内容',
    );
  });

  it('reports cancellation failure, keeps streaming, and retries only the selected task', async () => {
    const { store, runtime, calls, request, seed } = await setup();
    const a = seed(),
      b = seed();
    await runtime.send(a, request);
    await runtime.send(b, request);
    const task = runtime.get('p1', a.id)!;
    calls[0].cancel.mockRejectedValueOnce(new Error('cancel failed'));
    await runtime.cancel(task);
    expect(task.pending).toBe(true);
    expect(task.stopping).toBe(false);
    expect(task.error).toBe('中止任务失败，请重试。');
    calls[0].delta('仍在回答');
    expect(task.text).toBe('仍在回答');
    await runtime.cancel(task);
    expect(task.error).toBeNull();
    expect(calls[0].cancel).toHaveBeenCalledTimes(2);
    expect(calls[1].cancel).not.toHaveBeenCalled();
    calls[0].resolve({ text: '仍在回答', interrupted: true });
    calls[1].resolve({ text: '独立回答', interrupted: false });
    await vi.waitFor(() => expect(Object.keys(store.getState().agentTasks)).toHaveLength(0));
    expect(
      asConversation(store.getState().data!.sessions.find((chat) => chat.id === a.id)!).chatRun,
    ).toMatchObject({ status: 'interrupted', error: null });
  });

  it('does not persist a cancellation error as a failed answer when the stream completes normally', async () => {
    const { store, runtime, calls, request, seed } = await setup();
    const chat = seed();
    await runtime.send(chat, request);
    const task = runtime.get('p1', chat.id)!;
    calls[0].cancel.mockRejectedValueOnce(new Error('cancel failed'));
    await runtime.cancel(task);
    expect(task.error).toBe('中止任务失败，请重试。');
    calls[0].resolve({ text: '完整回答', interrupted: false });
    await vi.waitFor(() => expect(task.pending || task.saving).toBe(false));
    expect(task.error).toBeNull();
    expect(asConversation(store.getState().data!.sessions[0]).chatRun).toMatchObject({
      status: 'completed',
      error: null,
    });
    expect(calls).toHaveLength(1);
  });

  it('ignores a late cancellation failure after the answer has already been saved', async () => {
    const { store, runtime, calls, request, seed } = await setup();
    const chat = seed();
    await runtime.send(chat, request);
    const task = runtime.get('p1', chat.id)!;
    let rejectCancel!: (reason: Error) => void;
    calls[0].cancel.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCancel = reject;
        }),
    );
    const cancelling = runtime.cancel(task);
    calls[0].resolve({ text: '已完成', interrupted: false });
    await vi.waitFor(() => expect(task.pending || task.saving).toBe(false));
    rejectCancel(new Error('late IPC error'));
    await cancelling;
    expect(task.error).toBeNull();
    expect(asConversation(store.getState().data!.sessions[0]).chatRun).toMatchObject({
      status: 'completed',
      error: null,
    });
  });

  it('protects inbox requests and prevents sending when the question could not be saved', async () => {
    const { save, runtime, calls, request, seed } = await setup();
    const chat = seed('__inbox__');
    save.mockRejectedValueOnce(new Error('disk unavailable'));
    expect(await runtime.send(chat, request)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(runtime.get('__inbox__', chat.id)?.saveError).toBe('disk unavailable');
    await runtime.retrySave(runtime.get('__inbox__', chat.id)!);
    expect(calls).toHaveLength(0);
  });
});
