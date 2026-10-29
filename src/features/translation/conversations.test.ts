import { describe, it, expect, vi } from 'vitest';
import { emptyWorkspace } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { ResearchBackend, ChatResult } from '../../platform/research';
import type { CredentialBackend } from '../../platform/credentials';
import { getChatRuntime } from '../assistant/chat-runtime';
import { asConversation, requestMessages } from '../assistant/model';
import { translationConversation, type TranslationConversationRequest } from './conversations';

async function fixture() {
  const data = emptyWorkspace();
  data.projects.push({ id: 'p1', name: 'P1', question: '', space: 'personal', createdAt: '' });
  data.settings.model = {
    provider: 'openai',
    endpoint: 'https://fixture.invalid/v1',
    model: 'fixture',
  };
  const save = vi.fn(async (value) => value);
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'test', legacyAvailable: false }),
    save,
  } as unknown as WorkspaceBackend);
  await store.getState().load();
  let delta!: (text: string) => void;
  let finish!: (result: ChatResult) => void;
  const cancel = vi.fn(async () => {
    finish({ text: '部分回答', interrupted: true });
  });
  const backend = {
    streamAI: vi.fn((_request, output) => {
      delta = output;
      return {
        result: new Promise<ChatResult>((resolve) => {
          finish = resolve;
        }),
        cancel,
      };
    }),
  } as unknown as ResearchBackend;
  const credentials = { load: vi.fn(async () => 'fixture-secret') } as unknown as CredentialBackend;
  const open = vi.fn();
  const id = crypto.randomUUID();
  const call = (op: TranslationConversationRequest['op'], question = '', scope = 'p1') =>
    translationConversation(
      store,
      backend,
      scope,
      {
        id: crypto.randomUUID(),
        conversationId: id,
        op,
        question,
        source: 'Original passage',
        translation: '译文',
        explanation: '',
      },
      open,
      credentials,
    );
  await call('create');
  return {
    call,
    store,
    save,
    backend,
    credentials,
    open,
    id,
    cancel,
    delta: (text: string) => delta(text),
    finish: (text: string) => finish({ text, interrupted: false }),
  };
}

describe('shared Yita / sidebar conversation', () => {
  it('shares one history, model request, partial answer and cancellation across both surfaces', async () => {
    const f = await fixture();
    await f.call('send', '解释这段文字');
    f.delta('部分回答');
    const snapshot = await f.call('read');
    expect(snapshot.running).toBe(true);
    expect(snapshot.messages.map((m) => m.text)).toEqual(['解释这段文字', '部分回答']);
    const runtime = getChatRuntime(f.store, f.backend);
    expect(runtime.get('p1', f.id)?.text).toBe('部分回答');
    await f.call('open', '未发送草稿');
    expect(f.open).toHaveBeenCalledWith(f.id, '未发送草稿');
    expect(f.backend.streamAI).toHaveBeenCalledOnce();
    expect(f.store.getState().data!.sessions).toHaveLength(1);
    await expect(f.call('send', '冲突')).rejects.toThrow('仍在回答');
    await f.call('cancel');
    expect(f.cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(runtime.get('p1', f.id)?.saving).toBe(false));
    expect((await f.call('read')).running).toBe(false);
    expect(JSON.stringify(f.store.getState().data)).not.toContain('fixture-secret');
    expect(JSON.stringify(snapshot)).not.toContain('fixture-secret');
    const request = vi.mocked(f.backend.streamAI!).mock.calls[0][0];
    expect(JSON.stringify(request.messages)).toContain('Original passage');
    await f.call('retry');
    expect(vi.mocked(f.backend.streamAI!)).toHaveBeenCalledTimes(2);
    f.finish('完整回答');
    await vi.waitFor(async () => expect((await f.call('read')).running).toBe(false));
    expect(
      (await f.call('read')).messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
  });

  it('reads messages subsequently sent by the sidebar, without cloning the session', async () => {
    const f = await fixture();
    const chat = asConversation(f.store.getState().data!.sessions[0]);
    chat.messages.push({
      id: 'sidebar-user',
      role: 'user',
      text: 'sidebar question',
      createdAt: '',
    });
    await getChatRuntime(f.store, f.backend).send(chat, {
      ...chat.modelSelection!.settings,
      messages: requestMessages(chat),
    });
    f.finish('sidebar answer');
    await vi.waitFor(async () => expect((await f.call('read')).running).toBe(false));
    expect((await f.call('read')).messages.map((m) => m.text)).toEqual([
      'sidebar question',
      'sidebar answer',
    ]);
  });

  it('refuses cross-project access and never recreates a session deleted while loading credentials', async () => {
    const f = await fixture();
    await expect(f.call('read', '', '__inbox__')).rejects.toThrow('所属');
    vi.mocked(f.credentials.load).mockImplementationOnce(async () => {
      await f.store.getState().update((data) => {
        data.sessions = [];
      });
      return 'fixture-secret';
    });
    await expect(f.call('send', 'lost session')).rejects.toThrow('已删除');
    expect(f.backend.streamAI).not.toHaveBeenCalled();
    expect(f.store.getState().data!.sessions).toHaveLength(0);
  });

  it('keeps disk failures visible and never starts a model request after a failed question save', async () => {
    const f = await fixture();
    f.save.mockRejectedValueOnce(new Error('disk full'));
    await expect(f.call('send', 'keep question')).rejects.toThrow();
    expect(f.backend.streamAI).not.toHaveBeenCalled();
    expect((await f.call('read')).error).toContain('disk full');
  });

  it('bounds the popup snapshot without deleting the persisted history', async () => {
    const f = await fixture();
    await f.store.getState().update((data) => {
      data.sessions[0].messages = Array.from({ length: 110 }, (_, i) => ({
        id: String(i),
        role: 'user',
        text: '文'.repeat(3000),
        createdAt: '',
      }));
    });
    const snapshot = await f.call('read');
    expect(snapshot.historyTruncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThan(2 * 1024 * 1024);
    expect(asConversation(f.store.getState().data!.sessions[0]).messages).toHaveLength(110);
  });
});
