import { t, translateError } from '../../i18n';
import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import {
  Plus,
  Settings2,
  ChevronDown,
  MoreHorizontal,
  Paperclip,
  LoaderCircle,
  Pencil,
  Trash2,
} from 'lucide-react';
import { ContextPanel } from '../../components/ai/ContextPanel';
import { ApprovalCard } from '../../components/ai/ApprovalCard';
import { AssistantComposer } from '../../components/ai/AssistantComposer';
import { ChatMessageView } from '../../components/ai/ChatMessageView';
import '../../components/ai/ai-panel.css';
import { Button, Dropdown } from '../../components/primitives';
import { ModelSettingsDialog } from './ModelSettingsDialog';
import { AssistantRuns } from './AssistantRuns';
import { getFileRuntime } from '../../editor/sessions';
import { Menu, menuAnchor, type MenuAnchor } from '../../components/primitives/Menu';
import { Modal } from '../../components/Modal';
import { Panel } from '../../components/layout/Panel';
import { confirmAction, requestText } from '../../components/prompts';
import type { WorkContext } from '../../domain/context';
import {
  domainForWorkspace,
  engineSupports,
  nativeAgent,
  type AgentBackend,
  type AgentConnection,
  type AgentDomain,
} from '../../platform/agent';
import type { AIProtocol, ResearchBackend } from '../../platform/research';
import {
  credentialSlot,
  nativeCredentials,
  type CredentialBackend,
} from '../../platform/credentials';
import type { WorkspaceStore } from '../../stores/workspace';
import { hasPendingWork, initialAgentSession } from './agent-session';
import { getAgentRuntime } from './agent-runtime';
import {
  asConversation,
  freezeContext,
  newConversation,
  persistConversation,
  requestMessages,
  type AISettings,
  type ChatMessage,
  type Conversation,
} from './model';

interface Props {
  store: WorkspaceStore;
  backend: ResearchBackend;
  scope: string;
  context: WorkContext;
  onDirtyChange?: (dirty: boolean) => void;
  /** Injected so tests can drive the engine without a desktop backend. */
  agent?: AgentBackend;
  /** Injected so tests can drive key storage without a desktop backend. */
  credentials?: CredentialBackend;
}

export function AssistantPanel({
  store,
  backend,
  scope,
  context,
  onDirtyChange,
  agent = nativeAgent,
  credentials = nativeCredentials,
}: Props) {
  const data = useStore(store, (state) => state.data);
  const model = data?.settings.model;
  const [settings, setSettings] = useState<AISettings>(() => ({
    endpoint: model?.endpoint ?? 'http://127.0.0.1:11434',
    model: model?.model ?? '',
    provider: model?.provider ?? 'ollama',
    serviceId: model?.serviceId,
    modelCatalog: model?.modelCatalog,
  }));
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [draftKey, setDraftKey] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [menu, setMenu] = useState<{
    kind: 'sessions' | 'tools' | 'models';
    anchor: MenuAnchor;
  } | null>(null);
  const [sessionAction, setSessionAction] = useState<{
    id: string;
    anchor: MenuAnchor;
  } | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const [apiKey, setApiKey] = useState('');
  // True while `apiKey` is the key read back from this machine rather than one
  // typed in this session, so the settings dialog can say so.
  const [keyStored, setKeyStored] = useState(false);
  // Keys read back once per provider endpoint; a second open of the dialog must
  // not wait on the disk again.
  const keyCache = useRef(new Map<string, string>());
  const keyTicket = useRef(0);
  const [localConversation, setConversation] = useState<Conversation>(() => {
    const recent = data?.sessions
      .filter((item) => item.project === scope)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    return recent ? asConversation(recent) : newConversation(scope);
  });
  const activeConversationId = useRef(localConversation.id);
  activeConversationId.current = localConversation.id;
  const [unsaved, setUnsaved] = useState(false);
  const savedConversation = data?.sessions.find(
    (item) => item.project === scope && item.id === localConversation.id,
  );
  const conversation =
    savedConversation && !unsaved ? asConversation(savedConversation) : localConversation;
  const runtime = getAgentRuntime(store, agent);
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const activeTask = runtime.get(scope, conversation.id);
  const agentState = activeTask?.state ?? initialAgentSession;
  const agentPending = !!activeTask && (activeTask.starting || hasPendingWork(agentState));
  const [newDomain, setNewDomain] = useState<AgentDomain | null>(null);
  const domain =
    conversation.agentDomain ?? newDomain ?? domainForWorkspace(context.workspace) ?? 'code';
  const [prompt, setPrompt] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<Conversation | null>(null);
  const busyRef = useRef(false);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const agentProject = context.projectId;
  const agentConnection: AgentConnection = {
    endpoint: settings.endpoint,
    model: settings.model,
    provider: settings.provider,
    ...(apiKey ? { apiKey } : {}),
  };
  const history = (data?.sessions ?? []).filter((item) => item.project === scope);
  const key = `assistant:${scope}`;
  const dirty = !!prompt.trim() || unsaved;
  const conversationActionsDisabled = dirty || !!retry || busy || settingsBusy;
  const backgroundTasks = [...runtime.tasks.values()].filter(
    (task) =>
      (runtime.pending(task) || task.saveError) &&
      task.projectId === scope &&
      task.conversationId !== conversation.id,
  );
  const needsReconnect = conversation.agentStatus === 'running' && !activeTask;
  const operations = activeTask?.state.operations ?? conversation.agentRun?.operations ?? [];
  const [domainRoots, setDomainRoots] = useState<Partial<Record<AgentDomain, string>>>({});
  useEffect(() => {
    let disposed = false;
    if (agentProject)
      void Promise.resolve(agent.domains(agentProject))
        .then((bindings) => {
          if (!disposed)
            setDomainRoots(
              Object.fromEntries(
                (bindings ?? []).map((binding) => [
                  binding.domain,
                  binding.root ?? binding.reason ?? '',
                ]),
              ),
            );
        })
        .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [agent, agentProject, context.workspace]);
  useEffect(() => {
    if (!model) return;
    setSettings({
      endpoint: model.endpoint,
      model: model.model,
      provider: model.provider ?? 'ollama',
      serviceId: model.serviceId,
      modelCatalog: model.modelCatalog,
    });
  }, [model?.endpoint, model?.model, model?.provider, model?.serviceId, model?.modelCatalog]);
  useEffect(() => {
    store.getState().setDirtySource(key, dirty);
    onDirtyChange?.(dirty);
  }, [store, key, dirty, onDirtyChange]);
  /**
   * Read the key filed for one provider endpoint. A failure is not fatal: the
   * panel then behaves as it did before, with a key for this session only.
   */
  const recallKey = useCallback(
    async (provider: AIProtocol, endpoint: string) => {
      const slot = credentialSlot(provider, endpoint);
      const remembered = keyCache.current.get(slot);
      if (remembered !== undefined) return remembered;
      let stored: string | null = null;
      try {
        stored = await credentials.load({ provider, endpoint: endpoint.trim() });
      } catch {
        stored = null;
      }
      if (stored) keyCache.current.set(slot, stored);
      return stored ?? '';
    },
    [credentials],
  );
  /** Write or forget the key of one endpoint. A failure only costs a retype. */
  const fileKey = useCallback(
    async (provider: AIProtocol, endpoint: string, stored: string) => {
      try {
        if (stored) await credentials.save({ provider, endpoint }, stored);
        else await credentials.clear({ provider, endpoint });
      } catch {
        // A key that cannot be filed stays usable until the app closes.
      }
    },
    [credentials],
  );
  // A saved key has to survive a restart, so fill the field from this machine
  // instead of asking for it again.
  useEffect(() => {
    const ticket = ++keyTicket.current;
    void recallKey(settings.provider, settings.endpoint).then((stored) => {
      if (ticket !== keyTicket.current) return;
      setApiKey(stored);
      setKeyStored(!!stored);
    });
  }, [recallKey, settings.provider, settings.endpoint]);
  useEffect(() => () => store.getState().setDirtySource(key, false), [store, key]);

  const safeError = useCallback(
    (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      return apiKey ? message.split(apiKey).join(t('[已隐藏密钥]')) : message;
    },
    [apiKey],
  );

  function openSettings() {
    setMenu(null);
    setSettingsDraft(settings);
    setDraftKey(apiKey);
    setSettingsError('');
    setShowSettings(true);
  }
  function openMenu(kind: 'sessions' | 'tools' | 'models', trigger: HTMLButtonElement) {
    const r = trigger.getBoundingClientRect();
    setMenu({
      kind,
      anchor: {
        x: r.left,
        y: kind === 'models' ? r.top - 6 : r.bottom + 4,
        placement: kind === 'models' ? 'top' : 'bottom',
        trigger,
      },
    });
  }
  const recentModels = Array.isArray(model?.recentModels)
    ? model.recentModels.filter((value): value is string => typeof value === 'string').slice(0, 12)
    : [];
  const models = [
    ...new Set([
      settings.model,
      ...(model?.endpoint === settings.endpoint ? (model?.modelCatalog ?? recentModels) : []),
    ]),
  ].filter(Boolean);
  useEffect(() => {
    const pane = messagesRef.current;
    if (pane && pinnedToBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [conversation.messages.length, conversation.id, agentState.agentText, agentPending, busy]);

  async function saveSettings(value = settingsDraft, keyValue = draftKey) {
    if (settingsBusy || busyRef.current) return;
    value = { ...value, endpoint: value.endpoint.trim(), model: value.model.trim() };
    if (!value.endpoint || !value.model) {
      setSettingsError(t('请先填写模型名称与服务地址。'));
      return;
    }
    setSettingsBusy(true);
    const result = await store.getState().update((workspace) => {
      const previous = workspace.settings.model;
      const sameService =
        previous.endpoint === value.endpoint && (previous.provider ?? 'ollama') === value.provider;
      const remembered = sameService
        ? [
            previous.model,
            ...(Array.isArray(previous.recentModels)
              ? previous.recentModels.filter((m) => typeof m === 'string')
              : []),
          ]
        : [];
      workspace.settings.model = {
        ...previous,
        ...value,
        recentModels: [...new Set([value.model.trim(), ...remembered])]
          .filter(Boolean)
          .slice(0, 12),
      };
    });
    setSettingsBusy(false);
    if (result) {
      const stored = keyValue.trim();
      const slot = credentialSlot(value.provider, value.endpoint);
      // Remember before the effect above runs, so the panel cannot restore the
      // previous key for this endpoint.
      if (stored) keyCache.current.set(slot, stored);
      else keyCache.current.delete(slot);
      void fileKey(value.provider, value.endpoint, stored);
      setSettings(value);
      setApiKey(keyValue);
      setKeyStored(!!stored);
      setShowSettings(false);
      setError('');
    } else if (showSettings) setSettingsError(store.getState().error ?? t('模型配置保存失败'));
    else setError(store.getState().error ?? t('模型配置保存失败'));
  }

  async function saveConversation(value = conversation) {
    const success = await persistConversation(store, value);
    setUnsaved(!success);
    if (!success) setError(store.getState().error || t('对话保存失败，内容仍保留在当前面板。'));
    else setError('');
    return success;
  }

  async function runRequest(value: Conversation) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setRetry(null);
    try {
      if (!(await saveConversation(value))) {
        setRetry(value);
        return;
      }
      setPrompt('');
      const answer = await backend.askAI({
        endpoint: settings.endpoint,
        provider: settings.provider,
        model: settings.model,
        ...(apiKey ? { apiKey } : {}),
        messages: requestMessages(value),
      });
      if (!answer.trim()) throw new Error(t('模型没有返回文本，请检查模型配置后重试。'));
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: answer,
        createdAt: new Date().toISOString(),
      };
      const next = {
        ...value,
        messages: [...value.messages, message],
        updatedAt: new Date().toISOString(),
      };
      setConversation(next);
      await saveConversation(next);
    } catch (reason) {
      setError(safeError(reason));
      setRetry(value);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function renameConversation(id: string) {
    if (conversationActionsDisabled) return;
    const item = history.find((entry) => entry.id === id);
    if (!item) return;
    const value = await requestText(t('重命名对话'), String(item.title || t('历史对话')));
    const title = value?.trim();
    if (!title) return;
    const updatedAt = new Date().toISOString();
    const saved = await store.getState().update((workspace) => {
      const target = workspace.sessions.find((entry) => entry.id === id && entry.project === scope);
      if (target) {
        target.title = title;
        target.updatedAt = updatedAt;
      }
    });
    if (!saved) {
      setError(store.getState().error || t('对话重命名失败，请重试。'));
      return;
    }
    if (conversation.id === id) setConversation((current) => ({ ...current, title, updatedAt }));
  }

  async function deleteConversation(id: string) {
    if (conversationActionsDisabled) return;
    const item = history.find((entry) => entry.id === id);
    if (!item) return;
    const targetTask = runtime.get(scope, id);
    if (targetTask && (runtime.pending(targetTask) || targetTask.saveError)) {
      setError(t('请先中止并等待此会话任务结束。'));
      return;
    }
    const name = String(item.title || t('历史对话'));
    if (!(await confirmAction(t('删除对话“{name}”？', { name })))) return;
    let saved = false;
    try {
      saved = await runtime.deleteConversation(scope, id);
    } catch (reason) {
      setError(safeError(reason));
      return;
    }
    if (!saved) {
      setError(store.getState().error || t('对话删除失败，请重试。'));
      return;
    }
    if (conversation.id !== id) return;
    setConversation(newConversation(scope));
    setError('');
  }

  /** Run the prompt through the built-in engine instead of a single request. */
  async function sendToAgent() {
    const text = prompt.trim();
    if (!agentProject) {
      setError(t('个人收集箱没有可操作的目录，请先进入一个项目。'));
      return;
    }
    if (!domain) {
      setError(t('当前页面没有可操作的目录，请进入文献库或项目文件后再让 Agent 执行。'));
      return;
    }
    if (!engineSupports(settings.provider)) {
      setError(t('内置 Agent 引擎使用 OpenAI Responses 协议，暂不支持该服务商的原始协议。'));
      return;
    }
    if (!settings.model.trim() || !settings.endpoint.trim()) {
      openSettings();
      return;
    }
    setError('');
    const sendingId = conversation.id;
    if (domain === 'code') {
      const drafts = [...getFileRuntime(backend).sessions.values()].filter(
        (session) => session.projectId === scope && session.getSnapshot().dirty,
      );
      if (drafts.length) {
        busyRef.current = true;
        setBusy(true);
        try {
          if (
            !(await confirmAction(
              t('运行前保存此项目的 {count} 个未保存文件？保存失败时不会启动。', {
                count: drafts.length,
              }),
            ))
          )
            return;
          for (const session of drafts)
            if (!(await session.save())) {
              setError(t('文件保存失败，请处理冲突后再运行。'));
              return;
            }
        } catch (reason) {
          setError(safeError(reason));
          return;
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      }
    }
    if (activeConversationId.current !== sendingId) return;
    const snapshot =
      includeContext &&
      (!domainForWorkspace(context.workspace) || domainForWorkspace(context.workspace) === domain)
        ? freezeContext(context)
        : undefined;
    setPrompt('');
    pinnedToBottom.current = true;
    const sent = await runtime.send(conversation, domain, agentConnection, text, snapshot);
    if (sent === false) {
      if (activeConversationId.current === sendingId) {
        setError(store.getState().error ?? t('当前输入尚未发送，请在任务结束后重试。'));
        setPrompt(text);
      }
    }
  }

  async function send() {
    if (
      !prompt.trim() ||
      busyRef.current ||
      settingsBusy ||
      agentPending ||
      activeTask?.saving ||
      activeTask?.saveError ||
      needsReconnect
    )
      return;
    // The global assistant automatically uses the local harness whenever the
    // current page has a project root and the configured provider speaks an
    // OpenAI-shaped protocol. Users should describe the outcome; they should
    // not have to choose a transport mode before every request.
    const harnessAvailable = agent !== nativeAgent || isTauri();
    if (harnessAvailable && agentProject && domain && engineSupports(settings.provider)) {
      await sendToAgent();
      return;
    }
    if (unsaved || retry) return;
    if (
      !settings.model.trim() ||
      !settings.endpoint.trim() ||
      (settings.provider !== 'ollama' && !apiKey)
    ) {
      openSettings();
      return;
    }
    const snapshot = includeContext ? freezeContext(context) : undefined;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: prompt.trim(),
      createdAt: new Date().toISOString(),
      ...(snapshot ? { context: snapshot } : {}),
    };
    pinnedToBottom.current = true;
    const next: Conversation = {
      ...conversation,
      title: conversation.messages.length ? conversation.title : prompt.trim().slice(0, 36),
      messages: [...conversation.messages, message],
      context: [...conversation.context, ...(snapshot ? [snapshot] : [])],
      updatedAt: new Date().toISOString(),
    };
    setConversation(next);
    setUnsaved(true);
    await runRequest(next);
  }

  function selectConversation(id: string) {
    if (dirty || retry || busy) return;
    pinnedToBottom.current = true;
    const existing = store
      .getState()
      .data?.sessions.find((item) => item.id === id && item.project === scope);
    setConversation(existing ? asConversation(existing) : newConversation(scope));
    setNewDomain(null);
    setError('');
  }

  async function setupWindowsSandbox() {
    if (!agentProject || !domain || !agent.setupSandbox) return;
    setSandboxBusy(true);
    setError('');
    try {
      const result = await agent.setupSandbox(agentProject, domain, agentConnection);
      // A setup request may start an elevated helper. Reopen the Codex thread
      // after the user completes that flow so it picks up the new sandbox.
      if (activeTask && !runtime.pending(activeTask)) await runtime.remove(scope, conversation.id);
      if (result.status === 'setupCompleted') {
        setError(t('Windows 沙箱配置已完成，请再次发送任务。'));
      } else if (result.started) {
        setError(t('Windows 沙箱配置未完成，请检查系统权限后重试。'));
      } else {
        setError(t('Windows 沙箱配置没有启动，请重试或查看系统权限设置。'));
      }
    } catch (reason) {
      setError(safeError(reason));
    } finally {
      setSandboxBusy(false);
    }
  }

  async function interruptAgent() {
    const session = activeTask?.session;
    if (!session) return;
    setError('');
    if (!(await session.interrupt())) setError(session.state.error ?? t('中止任务失败，请重试。'));
  }

  return (
    <Panel
      className="sf-assistant-panel sf-project-assistant"
      role="region"
      aria-label={t('AI 助手内容')}
    >
      <div className="sf-ai-session-header">
        <Button
          variant="ghost"
          className="sf-ai-session-title"
          aria-label={t('当前 AI 对话')}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'sessions'}
          disabled={conversationActionsDisabled}
          title={conversation.title}
          onClick={(event) => openMenu('sessions', event.currentTarget)}
        >
          <span>
            {conversation.messages.length || conversation.title !== t('新对话')
              ? conversation.title
              : t('新对话')}
          </span>
          <ChevronDown size={12} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('新建 AI 对话')}
          tooltip={dirty ? t('先发送或清空草稿，并保存对话') : t('新建 AI 对话')}
          disabled={conversationActionsDisabled}
          onClick={() => selectConversation('')}
        >
          <Plus size={15} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('对话选项')}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'tools'}
          onClick={(event) => openMenu('tools', event.currentTarget)}
        >
          <MoreHorizontal size={16} />
        </Button>
      </div>
      {agentProject ? (
        <div className="sf-ai-binding">
          <Dropdown
            aria-label={t('执行工作区')}
            value={domain}
            disabled={!!conversation.agentDomain || agentPending}
            onChange={(event) => setNewDomain(event.target.value as AgentDomain)}
          >
            <option value="literature">{t('文献目录')}</option>
            <option value="code">{t('代码目录')}</option>
          </Dropdown>
          <span title={agentState.cwd ?? conversation.agentCwd ?? domainRoots[domain] ?? ''}>
            {agentState.cwd ?? conversation.agentCwd ?? domainRoots[domain] ?? t('发送时绑定目录')}
          </span>
        </div>
      ) : null}
      {backgroundTasks.length ? (
        <div className="sf-ai-background-tasks" aria-label={t('后台任务')}>
          {backgroundTasks.map((task) => (
            <Button
              key={task.conversationId}
              variant="ghost"
              size="sm"
              onClick={() => selectConversation(task.conversationId)}
            >
              <LoaderCircle className="sf-ai-spinner" size={12} />
              <span>
                {String(
                  history.find((item) => item.id === task.conversationId)?.title ?? t('历史对话'),
                )}
              </span>
              <span>
                {task.saveError
                  ? t('待保存')
                  : task.state.phase === 'waiting'
                    ? t('等待审批')
                    : task.state.phase === 'stopping'
                      ? t('正在中止…')
                      : t('运行中')}
              </span>
            </Button>
          ))}
        </div>
      ) : null}
      <Menu
        anchor={menu?.anchor ?? null}
        label={
          menu?.kind === 'sessions'
            ? t('历史对话')
            : menu?.kind === 'models'
              ? t('选择模型')
              : t('对话选项')
        }
        onClose={() => setMenu(null)}
      >
        {menu?.kind === 'sessions' ? (
          <>
            <Button
              role="menuitem"
              variant="ghost"
              onClick={() => {
                selectConversation('');
                setMenu(null);
              }}
            >
              <Plus size={14} />
              {t('新建 AI 对话')}
            </Button>
            <div className="sf-ai-session-list">
              {[...history]
                .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
                .map((item) => (
                  <Button
                    key={item.id}
                    role="menuitemradio"
                    aria-checked={item.id === conversation.id}
                    variant="ghost"
                    onContextMenu={(event) => {
                      if (conversationActionsDisabled) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setMenu(null);
                      setSessionAction({ id: item.id, anchor: menuAnchor(event) });
                    }}
                    onKeyDown={(event) => {
                      if (
                        (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) &&
                        !conversationActionsDisabled
                      ) {
                        event.preventDefault();
                        setMenu(null);
                        setSessionAction({ id: item.id, anchor: menuAnchor(event) });
                      }
                    }}
                    onClick={() => {
                      selectConversation(item.id);
                      setMenu(null);
                    }}
                  >
                    <span className="sf-ai-session-name">
                      {String(item.title || t('历史对话'))}
                    </span>
                    {runtime.get(scope, item.id) &&
                    runtime.pending(runtime.get(scope, item.id)!) ? (
                      <LoaderCircle
                        className="sf-ai-spinner"
                        size={12}
                        aria-label={t('任务进行中')}
                      />
                    ) : null}
                  </Button>
                ))}
            </div>
          </>
        ) : menu?.kind === 'models' ? (
          <>
            {models.map((name) => (
              <Button
                key={name}
                role="menuitemradio"
                aria-checked={name === settings.model}
                variant="ghost"
                disabled={settingsBusy || busy}
                onClick={() => {
                  setMenu(null);
                  void saveSettings({ ...settings, model: name }, apiKey);
                }}
              >
                <span className="sf-ai-model-option">{name}</span>
              </Button>
            ))}
            <Button role="menuitem" variant="ghost" onClick={openSettings}>
              <Settings2 size={14} />
              {t('配置其他模型')}
            </Button>
          </>
        ) : (
          <>
            <Button
              role="menuitem"
              variant="ghost"
              onClick={() => {
                setMenu(null);
                setShowContext(true);
              }}
            >
              <Paperclip size={14} />
              {t('查看当前材料')}
            </Button>
            <Button role="menuitem" variant="ghost" onClick={openSettings}>
              <Settings2 size={14} />
              {t('模型设置')}
            </Button>
          </>
        )}
      </Menu>
      <Menu
        anchor={sessionAction?.anchor ?? null}
        label={t('对话操作')}
        onClose={() => setSessionAction(null)}
      >
        {sessionAction ? (
          <>
            <Button
              variant="ghost"
              role="menuitem"
              disabled={conversationActionsDisabled}
              onClick={() => void renameConversation(sessionAction.id)}
            >
              <Pencil size={14} />
              {t('重命名对话')}
            </Button>
            <div role="separator" className="sf-menu-separator" />
            <Button
              variant="ghost"
              role="menuitem"
              className="sf-menu-danger"
              disabled={
                conversationActionsDisabled ||
                !!(
                  runtime.get(scope, sessionAction.id) &&
                  runtime.pending(runtime.get(scope, sessionAction.id)!)
                )
              }
              onClick={() => void deleteConversation(sessionAction.id)}
            >
              <Trash2 size={14} />
              {t('删除对话')}
            </Button>
          </>
        ) : null}
      </Menu>
      {showContext && (
        <Modal
          title={t('当前材料')}
          className="sf-ai-context-dialog"
          onClose={() => setShowContext(false)}
        >
          <ContextPanel
            context={context}
            projectName={data?.projects.find((project) => project.id === scope)?.name}
            includeContext={includeContext}
            onIncludeContextChange={setIncludeContext}
            actionDisabledReason={
              busy || unsaved || retry
                ? t('等待当前请求或保存完成')
                : prompt.length > 0
                  ? t('先发送或清空当前草稿')
                  : undefined
            }
            onAction={(value) => {
              if (prompt.length || busy || unsaved || retry) return;
              setShowContext(false);
              setPrompt(value);
              requestAnimationFrame(() => composerRef.current?.focus());
            }}
          />
        </Modal>
      )}
      {showSettings && (
        <ModelSettingsDialog
          backend={backend}
          credentials={credentials}
          value={settingsDraft}
          apiKey={draftKey}
          keyStored={keyStored}
          error={settingsError}
          saving={settingsBusy}
          requestBusy={busy}
          onChange={(value) => {
            setSettingsDraft(value);
            setSettingsError('');
          }}
          onKeyChange={setDraftKey}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
      <div
        ref={messagesRef}
        className="sf-chat-messages sf-aux-scroll"
        role="log"
        aria-label={t('对话消息')}
        aria-live="polite"
        onScroll={(event) => {
          const pane = event.currentTarget;
          pinnedToBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
        }}
      >
        <AssistantRuns key={conversation.id} projectId={scope} conversationId={conversation.id} />
        {!conversation.messages.length ? (
          <div className="sf-ai-conversation-empty">
            {t('提问，或直接描述要在当前工作区完成的任务')}
          </div>
        ) : (
          conversation.messages.map((message) => (
            <ChatMessageView key={message.id} role={message.role} text={message.text} />
          ))
        )}
        {agentState.agentText &&
        !conversation.messages.some((message) => message.id === activeTask?.answerId) ? (
          <ChatMessageView role="assistant" text={agentState.agentText} streaming={agentPending} />
        ) : null}
        {agentPending && !agentState.approvals.length ? (
          <div className="sf-ai-progress sf-ai-agent-progress" role="status">
            <LoaderCircle className="sf-ai-spinner" size={14} aria-hidden="true" />
            <span>
              {agentState.phase === 'stopping'
                ? t('正在中止…')
                : activeTask?.starting
                  ? t('正在连接 Agent…')
                  : t('Agent 正在工作…')}
            </span>
          </div>
        ) : null}
        {agentState.sandbox === 'readOnly' ? (
          <div className="sf-agent-sandbox-notice" role="status">
            <span>
              {t(
                '当前 Windows 沙箱尚未配置，Agent 目前只能读取工作区。需要修改、删除或运行文件时，请先完成配置。',
              )}
            </span>
            {agent.setupSandbox ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={sandboxBusy || busy || agentPending || !!activeTask?.saving}
                onClick={() => void setupWindowsSandbox()}
              >
                {sandboxBusy ? t('正在配置…') : t('配置 Windows 沙箱')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {operations.length ? (
          <details className="sf-ai-task-details">
            <summary>
              {t('执行记录')} · {operations.length}
            </summary>
            {operations.map((op) => (
              <div key={op.id}>
                <strong>{op.label}</strong>
                <span>{t(op.status)}</span>
                {op.output ? <pre>{op.output}</pre> : null}
              </div>
            ))}
          </details>
        ) : null}
        {agentState.unsupportedRequests.length ? (
          <div role="alert" className="sf-aux-error">
            {t('此任务需要当前界面尚未支持的交互，请中止后重试。')}
            <code>{agentState.unsupportedRequests.join(', ')}</code>
          </div>
        ) : null}
        {agentState.approvals.map((approval) => (
          <ApprovalCard
            key={String(approval.id)}
            event={approval}
            busy={busy}
            onDecide={(decision) => void activeTask?.session.decide(approval, decision)}
          />
        ))}
        {busy && !agentPending ? (
          <div className="sf-ai-progress" role="status">
            <LoaderCircle className="sf-ai-spinner" size={14} aria-hidden="true" />
            {t('正在处理…')}
          </div>
        ) : null}
      </div>
      {needsReconnect ? (
        <div className="sf-agent-sandbox-notice" role="status">
          <span>{t('上次任务的状态需要确认。恢复连接会读取已有结果，不会重复发送任务。')}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runtime.resume(conversation, agentConnection)}
          >
            {t('恢复连接')}
          </Button>
        </div>
      ) : null}
      {!agentPending && conversation.agentStatus && !needsReconnect ? (
        <div className="sf-ai-task-status" role="status">
          {activeTask?.saving ? t('正在保存结果…') : t(conversation.agentStatus)}
          {conversation.agentRun?.model ? <span>{conversation.agentRun.model}</span> : null}
        </div>
      ) : null}
      {error ||
      agentState.error ||
      activeTask?.saveError ||
      (!activeTask && conversation.agentRun?.error) ? (
        <div className="sf-aux-error" role="alert">
          {translateError(
            activeTask?.saveError || error || agentState.error || conversation.agentRun?.error,
          )}
          <div>
            {activeTask?.saveError ? (
              <Button variant="ghost" size="sm" onClick={() => void runtime.retrySave(activeTask)}>
                {t('重试保存对话')}
              </Button>
            ) : null}
            {retry ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void runRequest(retry)}
              >
                {t('重试本次请求')}
              </Button>
            ) : null}
            {unsaved && !retry ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void saveConversation()}
              >
                {t('重试保存对话')}
              </Button>
            ) : null}
            {retry && !unsaved ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setRetry(null);
                  setError('');
                }}
              >
                {t('保留对话，继续提问')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <AssistantComposer
        inputRef={composerRef}
        prompt={prompt}
        disabled={
          settingsBusy ||
          unsaved ||
          !!retry ||
          !!activeTask?.saving ||
          !!activeTask?.saveError ||
          needsReconnect
        }
        isBusy={busy || agentPending}
        canInterrupt={agentPending && !!agentState.turnId && agentState.phase !== 'stopping'}
        model={settings.model}
        endpoint={settings.endpoint}
        includeContext={includeContext}
        onPromptChange={setPrompt}
        onSend={() => void send()}
        onInterrupt={() => void interruptAgent()}
        contextLabel={context.path || context.title || t('当前材料')}
        modelMenuOpen={menu?.kind === 'models'}
        onContext={() => setShowContext(true)}
        onModelMenu={(event) => openMenu('models', event.currentTarget)}
      />
    </Panel>
  );
}
