import { t, translateError } from '../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Plus, Settings2, ChevronDown, MoreHorizontal, Paperclip, Bot } from 'lucide-react';
import { ContextPanel } from '../../components/ai/ContextPanel';
import { ApprovalCard } from '../../components/ai/ApprovalCard';
import { AssistantComposer } from '../../components/ai/AssistantComposer';
import { ChatMessageView } from '../../components/ai/ChatMessageView';
import '../../components/ai/ai-panel.css';
import { Button } from '../../components/primitives';
import { ModelSettingsDialog } from './ModelSettingsDialog';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { Modal } from '../../components/Modal';
import { Panel } from '../../components/layout/Panel';
import type { WorkContext } from '../../domain/context';
import {
  domainForWorkspace,
  engineSupports,
  nativeAgent,
  type AgentBackend,
  type AgentConnection,
} from '../../platform/agent';
import type { AIProtocol, ResearchBackend } from '../../platform/research';
import {
  credentialSlot,
  nativeCredentials,
  type CredentialBackend,
} from '../../platform/credentials';
import type { WorkspaceStore } from '../../stores/workspace';
import { AgentSession, hasPendingWork, initialAgentSession } from './agent-session';
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
  const [conversation, setConversation] = useState<Conversation>(() => {
    const recent = data?.sessions
      .filter((item) => item.project === scope)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    return recent ? asConversation(recent) : newConversation(scope);
  });
  const [prompt, setPrompt] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<Conversation | null>(null);
  const busyRef = useRef(false);
  // Agent mode is additive: with it off, the panel behaves exactly as before.
  const [agentMode, setAgentMode] = useState(false);
  const [agentState, setAgentState] = useState(() => ({ ...initialAgentSession }));
  const sessionRef = useRef<AgentSession | null>(null);
  const agentProject = context.projectId;
  const domain = domainForWorkspace(context.workspace);
  const agentConnection: AgentConnection = {
    endpoint: settings.endpoint,
    model: settings.model,
    provider: settings.provider,
    ...(apiKey ? { apiKey } : {}),
  };
  const history = (data?.sessions ?? []).filter((item) => item.project === scope);
  const key = `assistant:${scope}`;
  const dirty = !!prompt.trim() || unsaved || busy;

  useEffect(() => {
    store.getState().setDirtySource(key, dirty);
    onDirtyChange?.(dirty);
  }, [store, key, dirty, onDirtyChange]);
  // A turn the engine is still running, or an approval it is waiting on, is
  // unfinished work: quitting now would abandon it.
  const agentPending = hasPendingWork(agentState);
  useEffect(() => {
    store.getState().setDirtySource(`agent:${scope}`, agentPending);
    return () => store.getState().setDirtySource(`agent:${scope}`, false);
  }, [store, scope, agentPending]);
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
  // The engine answers a request before it emits approvals, so the queue has to
  // be read while a turn runs; nothing is pushed yet.
  useEffect(() => {
    if (agentState.phase !== 'running' && agentState.phase !== 'waiting') return;
    const timer = setInterval(() => void sessionRef.current?.poll(), 1200);
    return () => clearInterval(timer);
  }, [agentState.phase]);
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
  }, [conversation.messages.length, busy, conversation.id]);

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
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (!sessionRef.current || sessionRef.current.state.threadId === null) {
        sessionRef.current = new AgentSession(
          agent,
          { projectId: agentProject, domain },
          agentConnection,
          setAgentState,
        );
        if (!(await sessionRef.current.open())) {
          setError(sessionRef.current.state.error ?? '');
          return;
        }
      }
      setPrompt('');
      if (!(await sessionRef.current.send(text))) {
        setError(sessionRef.current.state.error ?? '');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function send() {
    if (!prompt.trim() || busyRef.current || settingsBusy) return;
    if (agentMode) {
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
    if (dirty || retry) return;
    pinnedToBottom.current = true;
    const existing = history.find((item) => item.id === id);
    setConversation(existing ? asConversation(existing) : newConversation(scope));
    setError('');
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
          disabled={dirty || !!retry}
          title={conversation.title}
          onClick={(event) => openMenu('sessions', event.currentTarget)}
        >
          <span>{conversation.messages.length ? conversation.title : t('新对话')}</span>
          <ChevronDown size={12} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('新建 AI 对话')}
          tooltip={dirty ? t('先发送或清空草稿，并保存对话') : t('新建 AI 对话')}
          disabled={dirty || !!retry}
          onClick={() => selectConversation('')}
        >
          <Plus size={15} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className="toggle"
          aria-label={t('本地执行模式')}
          aria-pressed={agentMode}
          tooltip={
            agentMode ? t('本地执行：内置引擎可以读写文件') : t('对话模式：只回答问题，不改动文件')
          }
          disabled={busy}
          onClick={() => setAgentMode((value) => !value)}
        >
          <Bot size={15} />
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
            {[...history]
              .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
              .map((item) => (
                <Button
                  key={item.id}
                  role="menuitemradio"
                  aria-checked={item.id === conversation.id}
                  variant="ghost"
                  onClick={() => {
                    selectConversation(item.id);
                    setMenu(null);
                  }}
                >
                  {String(item.title || t('历史对话'))}
                </Button>
              ))}
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
        {!conversation.messages.length ? (
          <div className="sf-ai-conversation-empty">
            {agentMode ? t('描述一个要在这个目录里执行的任务') : t('从一个问题开始')}
          </div>
        ) : (
          conversation.messages.map((message) => (
            <ChatMessageView key={message.id} role={message.role} text={message.text} />
          ))
        )}
        {agentState.approvals.map((approval) => (
          <ApprovalCard
            key={String(approval.id)}
            event={approval}
            busy={busy}
            onDecide={(decision) => void sessionRef.current?.decide(approval, decision)}
          />
        ))}
        {busy ? (
          <div className="sf-ai-progress" role="status">
            {agentMode ? t('正在执行…') : t('正在等待模型回答…')}
          </div>
        ) : null}
      </div>
      {error || agentState.error ? (
        <div className="sf-aux-error" role="alert">
          {translateError(error || agentState.error)}
          <div>
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
        disabled={busy || settingsBusy || unsaved || !!retry}
        model={settings.model}
        endpoint={settings.endpoint}
        includeContext={includeContext}
        onPromptChange={setPrompt}
        onSend={() => void send()}
        contextLabel={context.path || context.title || t('当前材料')}
        modelMenuOpen={menu?.kind === 'models'}
        onContext={() => setShowContext(true)}
        onModelMenu={(event) => openMenu('models', event.currentTarget)}
      />
    </Panel>
  );
}
