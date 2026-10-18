import type { AIRequest, ChatStream, ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { t } from '../../i18n';
import { asConversation, type Conversation } from './model';

export interface ChatTask {
  projectId: string;
  conversationId: string;
  answerId: string;
  seed: Conversation;
  text: string;
  pending: boolean;
  saving: boolean;
  stopping: boolean;
  error: string | null;
  saveError: string | null;
  startedAt: string;
  model: string;
  stream?: ChatStream;
  resultStatus: 'completed' | 'interrupted' | 'failed';
  questionSaved: boolean;
}
const runtimes = new WeakMap<WorkspaceStore, Map<ResearchBackend, ChatRuntime>>();
export function getChatRuntime(store: WorkspaceStore, backend: ResearchBackend) {
  let entries = runtimes.get(store);
  if (!entries) {
    entries = new Map();
    runtimes.set(store, entries);
  }
  let runtime = entries.get(backend);
  if (!runtime) {
    runtime = new ChatRuntime(store, backend);
    entries.set(backend, runtime);
  }
  return runtime;
}
const keyOf = (project: string, id: string) => `${project}:${id}`;

/** Network tasks belong to the workspace, including when its panel is closed. */
export class ChatRuntime {
  readonly tasks = new Map<string, ChatTask>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private flush: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private store: WorkspaceStore,
    private backend: ResearchBackend,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  get(project: string, id: string) {
    return this.tasks.get(keyOf(project, id));
  }
  private emit() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }
  private schedule() {
    if (this.flush) return;
    this.flush = setTimeout(() => {
      this.flush = null;
      this.emit();
    }, 32);
  }
  private mark(task: ChatTask) {
    // Reuse the application's existing task/close/storage protection.
    this.store
      .getState()
      .setAgentTask(
        `${keyOf(task.projectId, task.conversationId)}:chat`,
        task.pending || task.saving || task.saveError ? task.projectId : null,
      );
    this.emit();
  }
  async send(seed: Conversation, request: AIRequest) {
    const old = this.get(seed.project, seed.id);
    if (old && (old.pending || old.saving || old.saveError)) return false;
    const task: ChatTask = {
      projectId: seed.project,
      conversationId: seed.id,
      answerId: crypto.randomUUID(),
      seed: structuredClone(seed),
      text: '',
      pending: true,
      saving: false,
      stopping: false,
      error: null,
      saveError: null,
      startedAt: new Date().toISOString(),
      model: request.model,
      resultStatus: 'completed',
      questionSaved: false,
    };
    this.tasks.set(keyOf(seed.project, seed.id), task);
    this.mark(task);
    const saved = await this.saveQuestion(task);
    if (!saved) {
      task.pending = false;
      task.resultStatus = 'failed';
      task.error = t('当前输入尚未发送，请在任务结束后重试。');
      task.saveError = this.store.getState().error ?? t('对话保存失败，内容仍保留在当前面板。');
      this.mark(task);
      return false;
    }
    // Do not wait for the response in the component; this also permits parallel chats.
    void this.run(task, request);
    return true;
  }
  private async saveQuestion(task: ChatTask) {
    const seed = task.seed;
    const saved = await this.store.getState().update((data) => {
      let entry = data.sessions.find(
        (item) => item.id === seed.id && item.project === seed.project,
      );
      if (!entry) {
        entry = structuredClone(seed);
        data.sessions.push(entry);
      } else {
        const current = asConversation(entry);
        entry.messages = [
          ...current.messages,
          ...structuredClone(
            seed.messages.filter(
              (message) => !current.messages.some((old) => old.id === message.id),
            ),
          ),
        ];
        entry.context = [
          ...current.context,
          ...structuredClone(
            seed.context.filter(
              (context) => !current.context.some((old) => old.capturedAt === context.capturedAt),
            ),
          ),
        ];
        entry.modelSelection ??= structuredClone(seed.modelSelection);
        entry.updatedAt = seed.updatedAt;
      }
      entry.chatRun = { status: 'running', model: task.model, startedAt: task.startedAt };
    });
    task.questionSaved = saved;
    return saved;
  }
  private async run(task: ChatTask, request: AIRequest) {
    try {
      if (task.stopping) {
        task.resultStatus = 'interrupted';
        return;
      }
      if (this.backend.streamAI) {
        task.stream = this.backend.streamAI(request, (text) => {
          if (!task.pending) return;
          task.text += text;
          this.schedule();
        });
        if (task.stopping) await task.stream.cancel();
        const result = await task.stream.result;
        task.text = result.text;
        task.resultStatus = result.interrupted ? 'interrupted' : 'completed';
      } else {
        // Compatibility for browser/test adapters; the native adapter always streams.
        task.text = await this.backend.askAI(request);
      }
      if (task.resultStatus === 'completed' && !task.text.trim())
        throw new Error(t('模型没有返回文本，请检查模型配置后重试。'));
      task.error = null;
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      task.error = request.apiKey ? error.split(request.apiKey).join(t('[已隐藏密钥]')) : error;
      task.resultStatus = 'failed';
    } finally {
      task.pending = false;
      await this.save(task, request.model);
    }
  }
  private async save(task: ChatTask, model: string) {
    task.saving = true;
    this.mark(task);
    const saved = await this.store.getState().update((data) => {
      const entry = data.sessions.find(
        (item) => item.id === task.conversationId && item.project === task.projectId,
      );
      if (!entry) throw new Error(t('对话不存在。'));
      const chat = asConversation(entry);
      if (task.text && !chat.messages.some((message) => message.id === task.answerId)) {
        chat.messages.push({
          id: task.answerId,
          role: 'assistant',
          text: task.text,
          createdAt: new Date().toISOString(),
        });
      }
      entry.messages = chat.messages;
      entry.chatRun = {
        status: task.resultStatus,
        model,
        startedAt: task.startedAt,
        completedAt: new Date().toISOString(),
        error: task.error,
      };
      entry.updatedAt = new Date().toISOString();
    });
    task.saveError = saved
      ? null
      : (this.store.getState().error ?? t('对话保存失败，内容仍保留在当前面板。'));
    task.saving = false;
    this.mark(task);
  }
  async retrySave(task: ChatTask) {
    if (task.pending || task.saving) return false;
    if (!task.questionSaved) {
      task.saving = true;
      this.mark(task);
      const saved = await this.saveQuestion(task);
      task.saving = false;
      if (!saved) {
        this.mark(task);
        return false;
      }
    }
    await this.save(task, task.model);
    return !task.saveError;
  }
  async cancel(task: ChatTask) {
    if (!task.pending || task.stopping) return;
    task.stopping = true;
    task.error = null;
    this.mark(task);
    try {
      await task.stream?.cancel();
    } catch {
      // A delayed cancel failure cannot turn an already finished answer into
      // a failed request or overwrite its saved result.
      if (!task.pending) return;
      task.stopping = false;
      task.error = t('中止任务失败，请重试。');
      this.mark(task);
    }
  }
  forget(project: string, id: string) {
    const task = this.get(project, id);
    if (task && (task.pending || task.saving || task.saveError)) return false;
    this.tasks.delete(keyOf(project, id));
    this.emit();
    return true;
  }
}
