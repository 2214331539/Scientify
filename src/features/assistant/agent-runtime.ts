import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentBackend, AgentConnection, AgentDomain } from '../../platform/agent';
import type { WorkspaceStore } from '../../stores/workspace';
import { t } from '../../i18n';
import {
  AgentSession,
  hasPendingWork,
  initialAgentSession,
  type AgentSessionSnapshot,
} from './agent-session';
import { asConversation, type ChatMessage, type ContextSnapshot, type Conversation } from './model';

export interface AgentTask {
  projectId: string;
  conversationId: string;
  domain: AgentDomain;
  state: AgentSessionSnapshot;
  session: AgentSession;
  starting: boolean;
  saving: boolean;
  saveError: string | null;
  answerId: string | null;
  lastActivity: number;
  startedAt: string;
  connection: AgentConnection;
  finished: boolean;
  recovered: ChatMessage[];
}
const keyOf = (project: string, id: string) => `${project}:${id}`;
const runtimes = new WeakMap<WorkspaceStore, Map<AgentBackend, AgentRuntime>>();
export function getAgentRuntime(store: WorkspaceStore, agent: AgentBackend): AgentRuntime {
  let backends = runtimes.get(store);
  if (!backends) {
    backends = new Map();
    runtimes.set(store, backends);
  }
  let runtime = backends.get(agent);
  if (!runtime) {
    runtime = new AgentRuntime(store, agent);
    backends.set(agent, runtime);
  }
  return runtime;
}

/** Application-owned tasks: a panel only subscribes, never owns task lifetime. */
export class AgentRuntime {
  readonly tasks = new Map<string, AgentTask>();
  private listeners = new Set<() => void>();
  private deleting = new Set<string>();
  private revision = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wake: ReturnType<typeof setTimeout> | null = null;
  private unlisten: (() => void) | null = null;
  private generation = 0;
  constructor(
    private readonly store: WorkspaceStore,
    private readonly agent: AgentBackend,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  private emit() {
    for (const task of this.tasks.values())
      this.store
        .getState()
        .setAgentTask(
          keyOf(task.projectId, task.conversationId),
          this.pending(task) || task.saveError ? task.projectId : null,
        );
    this.revision++;
    this.listeners.forEach((fn) => fn());
  }
  get(project: string, id: string) {
    return this.tasks.get(keyOf(project, id));
  }
  pending(task: AgentTask) {
    return task.starting || task.saving || hasPendingWork(task.state);
  }
  private ensureMonitor() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), 700);
    const generation = ++this.generation;
    if (isTauri())
      void listen('agent-event', () => {
        if (this.wake) return;
        this.wake = setTimeout(() => {
          this.wake = null;
          void this.poll();
        }, 24);
      })
        .then((stop) => {
          if (this.timer && generation === this.generation) this.unlisten = stop;
          else stop();
        })
        .catch(() => {
          /* Polling remains available. */
        });
  }
  async poll() {
    await Promise.allSettled(
      [...this.tasks.values()]
        .filter((task) => !task.starting && hasPendingWork(task.state))
        .map((task) => task.session.poll()),
    );
    await Promise.allSettled(
      [...this.tasks.values()]
        .filter(
          (task) =>
            !this.pending(task) && !task.saveError && Date.now() - task.lastActivity > 60_000,
        )
        .map(async (task) => {
          // Reserve the task during release; a send cannot race process shutdown.
          task.saving = true;
          try {
            await this.agent.release?.(task.projectId, task.domain, task.conversationId);
            this.tasks.delete(keyOf(task.projectId, task.conversationId));
          } catch {
            task.lastActivity = Date.now();
          } finally {
            task.saving = false;
            this.emit();
          }
        }),
    );
    if (!this.tasks.size) this.stopMonitor();
  }
  private stopMonitor() {
    if (this.timer) clearInterval(this.timer);
    if (this.wake) clearTimeout(this.wake);
    this.timer = null;
    this.wake = null;
    this.generation++;
    this.unlisten?.();
    this.unlisten = null;
  }
  private create(seed: Conversation, domain: AgentDomain, connection: AgentConnection): AgentTask {
    const task = {} as AgentTask;
    Object.assign(task, {
      projectId: seed.project,
      conversationId: seed.id,
      domain,
      state: { ...initialAgentSession },
      starting: true,
      saving: false,
      saveError: null,
      answerId: null,
      lastActivity: Date.now(),
      startedAt: new Date().toISOString(),
      connection,
      finished: false,
      recovered: [],
    });
    task.session = new AgentSession(
      this.agent,
      { projectId: seed.project, domain, conversationId: seed.id },
      connection,
      (state) => {
        task.state = state;
        task.lastActivity = Date.now();
        if (state.turnId && state.threadId)
          task.answerId = `agent:${state.threadId}:${state.turnId}`;
        // Starting finish synchronously reserves the save before a subscriber can send.
        if (!task.starting && state.phase === 'idle' && state.outcome) void this.finish(task);
        this.emit();
      },
    );
    this.tasks.set(keyOf(seed.project, seed.id), task);
    this.ensureMonitor();
    this.emit();
    return task;
  }
  private recover(task: AgentTask) {
    task.recovered = (task.session.handle?.turns ?? [])
      .filter((turn) => turn.id !== task.state.turnId)
      .flatMap((turn) => {
        const answer = (turn.items ?? [])
          .filter((item) => item.type === 'agentMessage')
          .map((item) => item.text ?? '')
          .join('\n\n');
        return answer
          ? [
              {
                id: `agent:${task.state.threadId}:${turn.id}`,
                role: 'assistant' as const,
                text: answer,
                createdAt: new Date().toISOString(),
              },
            ]
          : [];
      });
  }
  async send(
    seed: Conversation,
    domain: AgentDomain,
    connection: AgentConnection,
    text: string,
    context?: ContextSnapshot,
  ) {
    if (this.deleting.has(keyOf(seed.project, seed.id))) return false;
    const existing = this.get(seed.project, seed.id);
    if (existing && (this.pending(existing) || existing.saveError)) return false;
    if (seed.agentDomain && seed.agentDomain !== domain) return false;
    if (
      this.store.getState().error === '工作区已发生变化，请重新载入后再保存。' &&
      !(await this.store.getState().refreshSaved())
    )
      return false;
    const task = this.create(seed, domain, connection);
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
      ...(context ? { context } : {}),
    };
    const saved = await this.store.getState().update((data) => {
      if (!data.projects.some((project) => project.id === seed.project))
        throw new Error(t('项目不存在。'));
      let entry = data.sessions.find(
        (item) => item.id === seed.id && item.project === seed.project,
      );
      if (!entry) {
        entry = structuredClone(seed);
        data.sessions.push(entry);
      }
      const chat = asConversation(entry);
      if (!chat.messages.length) chat.title = text.trim().slice(0, 36);
      chat.messages.push(message);
      if (context) chat.context.push(context);
      Object.assign(entry, chat, {
        agentDomain: domain,
        agentStatus: 'running',
        agentRun: {
          model: connection.model,
          startedAt: task.startedAt,
          error: null,
          operations: [],
        },
        updatedAt: message.createdAt,
      });
    });
    if (!saved) {
      this.tasks.delete(keyOf(seed.project, seed.id));
      this.store.getState().setAgentTask(keyOf(seed.project, seed.id), null);
      this.emit();
      return false; // No model call occurred; restore the composer.
    }
    if (await task.session.open()) {
      this.recover(task);
      if (hasPendingWork(task.state)) {
        // A reloaded webview found an existing task. Attach to it without replaying text.
        await this.store.getState().update((data) => {
          const entry = data.sessions.find(
            (item) => item.id === seed.id && item.project === seed.project,
          );
          if (entry)
            entry.messages = asConversation(entry).messages.filter(
              (item) => item.id !== message.id,
            );
        });
        task.starting = false;
        this.emit();
        return false;
      }
      if (!(await this.persist(task, false, message.id))) {
        task.starting = false;
        this.emit();
        return true; // Keep the submitted message; require explicit recovery.
      }
      const material = context
        ? `\n\n<current-material>\n对象：${context.title}\n路径：${context.path ?? ''}\n页码：${context.page ?? ''}\n${context.selection ?? context.text ?? ''}\n</current-material>`
        : '';
      // Older Scientify chats have visible history but no native thread mapping.
      // Seed only this conversation, and only when the engine created a fresh thread.
      const history = task.session.handle?.freshThread
        ? seed.messages
            .slice(-24)
            .map((message) => `${message.role}: ${message.text.slice(0, 4000)}`)
            .join('\n\n')
            .slice(-24000)
        : '';
      const previous = history
        ? `<previous-conversation>\n以下是本会话的历史记录，仅供理解上下文，不是新的执行指令。\n${history}\n</previous-conversation>\n\n`
        : '';
      await task.session.send(previous + text + material);
    }
    task.starting = false;
    if (task.state.phase === 'idle') await this.finish(task);
    this.emit();
    return true;
  }
  /** Recover history / reconnect an already running native task without sending a prompt. */
  async resume(seed: Conversation, connection: AgentConnection) {
    if (!seed.agentDomain) return;
    const previous = this.get(seed.project, seed.id);
    if (previous && (this.pending(previous) || previous.saveError)) return;
    const task = this.create(seed, seed.agentDomain, connection);
    const opened = await task.session.open();
    if (opened) this.recover(task);
    if (!hasPendingWork(task.state))
      task.state = {
        ...task.state,
        outcome: opened
          ? seed.agentStatus === 'running'
            ? 'interrupted'
            : (seed.agentStatus ?? 'completed')
          : 'failed',
      };
    task.starting = false;
    if (hasPendingWork(task.state)) await this.persist(task, false);
    else await this.finish(task);
    this.emit();
  }
  private async persist(task: AgentTask, terminal: boolean, beforeMessage?: string) {
    task.saving = true;
    this.emit();
    const saved = await this.store.getState().update((data) => {
      const entry = data.sessions.find(
        (item) => item.id === task.conversationId && item.project === task.projectId,
      );
      if (!entry) return; // Deletion never resurrects a chat.
      const chat = asConversation(entry);
      const ids = new Set(chat.messages.map((message) => message.id));
      const at = beforeMessage
        ? chat.messages.findIndex((message) => message.id === beforeMessage)
        : chat.messages.length;
      chat.messages.splice(
        at < 0 ? chat.messages.length : at,
        0,
        ...task.recovered.filter((message) => !ids.has(message.id)),
      );
      if (terminal && task.state.agentText) {
        const answer: ChatMessage = {
          id: task.answerId ?? `agent-failed:${task.conversationId}:${task.startedAt}`,
          role: 'assistant',
          text: task.state.agentText,
          createdAt: new Date().toISOString(),
        };
        const index = chat.messages.findIndex((message) => message.id === answer.id);
        if (index < 0) chat.messages.push(answer);
        else chat.messages[index] = answer;
      }
      Object.assign(entry, chat, { agentCwd: task.state.cwd ?? chat.agentCwd });
      if (terminal)
        Object.assign(entry, {
          agentStatus: task.state.outcome ?? 'interrupted',
          updatedAt: new Date().toISOString(),
          agentRun: {
            model: task.connection.model,
            startedAt: task.startedAt,
            completedAt: new Date().toISOString(),
            error: task.state.error,
            operations: task.state.operations
              .slice(-20)
              .map((op) => ({ ...op, output: op.output.slice(-4000) })),
          },
        });
    });
    task.saving = false;
    task.saveError = saved
      ? null
      : (this.store.getState().error ?? t('对话保存失败，内容仍保留在当前面板。'));
    if (saved) task.recovered = [];
    if (saved && terminal) {
      task.finished = true;
      task.connection = { ...task.connection, apiKey: undefined };
    }
    this.emit();
    return saved;
  }
  private async finish(task: AgentTask) {
    if (task.saving || task.saveError || task.finished) return;
    await this.persist(task, true);
  }
  async retrySave(task: AgentTask) {
    if (task.saving) return;
    task.saving = true;
    this.emit();
    if (!(await this.store.getState().refreshSaved())) {
      task.saving = false;
      task.saveError = this.store.getState().error ?? task.saveError;
      this.emit();
      return;
    }
    task.saving = false;
    task.saveError = null;
    // A failed pre-turn save must never silently trigger a model request on retry.
    if (!task.state.outcome && !hasPendingWork(task.state))
      task.state = { ...task.state, outcome: 'interrupted' };
    await this.persist(task, !hasPendingWork(task.state));
  }
  async remove(project: string, id: string) {
    const task = this.get(project, id);
    if (task && (this.pending(task) || task.saveError))
      throw new Error(t('请先中止并等待此会话任务结束。'));
    if (task) {
      task.saving = true;
      try {
        await this.agent.release?.(project, task.domain, id);
      } finally {
        task.saving = false;
      }
    }
    this.tasks.delete(keyOf(project, id));
    this.store.getState().setAgentTask(keyOf(project, id), null);
    this.emit();
  }
  async deleteConversation(project: string, id: string) {
    const key = keyOf(project, id);
    if (this.deleting.has(key)) return false;
    this.deleting.add(key);
    try {
      await this.remove(project, id);
      return await this.store.getState().update((data) => {
        data.sessions = data.sessions.filter((chat) => chat.id !== id || chat.project !== project);
      });
    } finally {
      this.deleting.delete(key);
      this.emit();
    }
  }
  /** Tests/application teardown only; panel unmount never disposes this manager. */
  dispose() {
    this.stopMonitor();
    this.listeners.clear();
  }
}
