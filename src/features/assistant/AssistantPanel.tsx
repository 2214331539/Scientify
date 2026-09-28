import { t, translateError } from '../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Plus, Settings2, ChevronDown, MoreHorizontal, Paperclip } from 'lucide-react';
import { ContextPanel } from '../../components/ai/ContextPanel';
import { AssistantComposer } from '../../components/ai/AssistantComposer';
import { ChatMessageView } from '../../components/ai/ChatMessageView';
import '../../components/ai/ai-panel.css';
import { Button } from '../../components/primitives';
import { ModelSettingsDialog } from './ModelSettingsDialog';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { Modal } from '../../components/Modal';
import { Panel } from '../../components/layout/Panel';
import type { WorkContext } from '../../domain/context';
import type { ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
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
}

export function AssistantPanel({ store, backend, scope, context, onDirtyChange }: Props) {
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
  const history = (data?.sessions ?? []).filter((item) => item.project === scope);
  const key = `assistant:${scope}`;
  const dirty = !!prompt.trim() || unsaved || busy;

  useEffect(() => {
    store.getState().setDirtySource(key, dirty);
    onDirtyChange?.(dirty);
  }, [store, key, dirty, onDirtyChange]);
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
      setSettings(value);
      setApiKey(keyValue);
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

  async function send() {
    if (!prompt.trim() || busyRef.current || settingsBusy || unsaved || retry) return;
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
          value={settingsDraft}
          apiKey={draftKey}
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
          <div className="sf-ai-conversation-empty">{t('从一个问题开始')}</div>
        ) : (
          conversation.messages.map((message) => (
            <ChatMessageView key={message.id} role={message.role} text={message.text} />
          ))
        )}
        {busy ? (
          <div className="sf-ai-progress" role="status">
            {t('正在等待模型回答…')}
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="sf-aux-error" role="alert">
          {translateError(error)}
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
