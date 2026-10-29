import type { WorkspaceStore } from '../../stores/workspace';
import type { ResearchBackend } from '../../platform/research';
import { nativeCredentials, type CredentialBackend } from '../../platform/credentials';
import { getChatRuntime } from '../assistant/chat-runtime';
import { asConversation, newConversation, requestMessages } from '../assistant/model';

export type TranslationConversationRequest = {
  id: string;
  conversationId: string;
  op: 'create' | 'read' | 'send' | 'retry' | 'cancel' | 'open';
  question: string;
  source: string;
  translation: string;
  explanation: string;
};

/** Yita is a second view of ChatRuntime, never a second history or model client. */
export async function translationConversation(
  store: WorkspaceStore,
  backend: ResearchBackend,
  scope: string,
  request: TranslationConversationRequest,
  open: (id: string, draft: string) => void,
  credentials: CredentialBackend = nativeCredentials,
) {
  const runtime = getChatRuntime(store, backend);
  let entity = store.getState().data?.sessions.find((item) => item.id === request.conversationId);
  if (!entity && request.op === 'create') {
    const data = store.getState().data;
    if (!data) throw new Error('Scientify 工作区尚未载入。');
    const profile = data.settings.modelProfiles?.find(
      (p) => p.id === data.settings.defaultModelProfileId,
    );
    const chat = {
      ...newConversation(scope),
      id: request.conversationId,
      title: request.source.trim().slice(0, 32) || '翻译问答',
      translationContext: {
        source: request.source,
        translation: request.translation,
        explanation: request.explanation,
      },
      modelSelection: {
        profileId: profile?.id ?? 'legacy',
        settings: {
          ...data.settings.model,
          provider: data.settings.model.provider ?? 'ollama',
          ...profile,
        },
      },
    };
    if (
      !(await store.getState().update((workspace) => {
        if (!workspace.sessions.some((item) => item.id === chat.id)) workspace.sessions.push(chat);
      }))
    )
      throw new Error(store.getState().error ?? '会话保存失败。');
    entity = store.getState().data?.sessions.find((item) => item.id === chat.id);
  }
  if (!entity) throw new Error('此会话已删除，请重新打开问答窗口。');
  if (entity.project !== scope)
    throw new Error('请先返回此问答所属的 Scientify 项目，再继续对话。');
  let chat = asConversation(entity);
  if (!chat.translationContext) throw new Error('此会话不属于翻译问答。');
  if (request.op === 'send' || request.op === 'retry') {
    const retry = request.op === 'retry';
    const old = runtime.get(scope, chat.id);
    if (old && (old.pending || old.saving || old.saveError))
      throw new Error('当前会话仍在回答或等待保存，请先完成或中止。');
    if (!retry && !request.question.trim()) throw new Error('请输入问题。');
    if (retry && !['failed', 'interrupted'].includes(chat.chatRun?.status ?? ''))
      throw new Error('当前没有需要重试的回答。');
    const settings = chat.modelSelection?.settings;
    if (!settings?.model || !settings.endpoint)
      throw new Error('请在 Scientify 的 AI 助手中配置模型。');
    const apiKey = await credentials.load({
      provider: settings.provider,
      endpoint: settings.endpoint,
    });
    if (!apiKey && settings.provider !== 'ollama')
      throw new Error('请在 Scientify 的 AI 助手中配置模型密钥。');
    // Loading credentials yields: the sidebar may delete, rename, or finish another turn meanwhile.
    const current = store.getState().data?.sessions.find((item) => item.id === chat.id);
    if (!current) throw new Error('此会话已删除，请重新打开问答窗口。');
    chat = asConversation(current);
    if (JSON.stringify(chat.modelSelection?.settings) !== JSON.stringify(settings))
      throw new Error('会话模型刚刚变更，请重新发送。');
    if (chat.messages.some((message) => message.id === request.id))
      throw new Error('这条问题已经发送，请等待回答。');
    const next = {
      ...chat,
      title: chat.messages.length ? chat.title : request.question.slice(0, 36),
      updatedAt: new Date().toISOString(),
      messages: retry
        ? chat.messages.slice(
            0,
            chat.messages.map((message) => message.role).lastIndexOf('user') + 1,
          )
        : [
            ...chat.messages,
            {
              id: request.id,
              role: 'user' as const,
              text: request.question,
              createdAt: new Date().toISOString(),
            },
          ],
    };
    if (
      !(await runtime.send(next, {
        ...settings,
        apiKey: apiKey ?? undefined,
        messages: requestMessages(next),
      }))
    )
      throw new Error('当前会话正在处理中，请稍后重试。');
  } else if (request.op === 'cancel') {
    const task = runtime.get(scope, chat.id);
    if (task) await runtime.cancel(task);
  } else if (request.op === 'open') open(chat.id, request.question);

  const saved = store.getState().data!.sessions.find((item) => item.id === chat.id);
  if (!saved) throw new Error('此会话已删除。');
  const task = runtime.get(scope, chat.id);
  const messages = asConversation(saved).messages.map(({ id, role, text }) => ({ id, role, text }));
  if (task?.text && !messages.some((message) => message.id === task.answerId))
    messages.push({ id: task.answerId, role: 'assistant', text: task.text });
  // Bound each pipe snapshot, not the persisted history. Full history remains in the sidebar.
  let budget = 180000;
  let historyTruncated = false;
  const visible = [];
  for (const message of [...messages].reverse()) {
    if (budget <= 0 || visible.length >= 100) {
      historyTruncated = true;
      break;
    }
    const text = message.text.slice(0, budget);
    historyTruncated ||= text.length < message.text.length;
    visible.unshift({ ...message, text });
    budget -= text.length;
  }
  return {
    conversationId: chat.id,
    messages: visible,
    historyTruncated,
    canRetry:
      !task?.saveError &&
      ['failed', 'interrupted'].includes(asConversation(saved).chatRun?.status ?? ''),
    running: !!(task?.pending || task?.saving),
    error: task?.saveError ?? task?.error ?? null,
  };
}
