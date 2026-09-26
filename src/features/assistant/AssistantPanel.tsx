import { t, translateError } from '../../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Check, FilePlus2, Plus, Settings2 } from 'lucide-react';
import { ContextPanel } from '../../components/ai/ContextPanel';
import { AssistantComposer } from '../../components/ai/AssistantComposer';
import '../../components/ai/ai-panel.css';
import { Button, Dropdown, Input } from '../../components/primitives';
import { Panel } from '../../components/layout/Panel';
import type { WorkContext } from '../../domain/context';
import type { ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { captureSource, createNote, persistNote } from '../notes/model';
import { Markdown } from '../notes/Markdown';
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
    provider: (model as unknown as AISettings)?.provider === 'openai' ? 'openai' : 'ollama',
  }));
  const [showSettings, setShowSettings] = useState(false);
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
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState<Conversation | null>(null);
  const [savedNotes, setSavedNotes] = useState<string[]>([]);
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

  async function saveSettings() {
    const result = await store.getState().update((workspace) => {
      workspace.settings.model = { ...workspace.settings.model, ...settings };
    });
    if (result) {
      setShowSettings(false);
      setError('');
      setNotice(t('模型配置已保存；密钥仅在本次打开的应用中使用。'));
    } else setError(store.getState().error ?? t('模型配置保存失败'));
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
    setNotice('');
    setRetry(null);
    try {
      if (!(await saveConversation(value))) {
        setRetry(value);
        return;
      }
      setPrompt('');
      const answer = await backend.askAI({
        ...settings,
        ...(settings.provider === 'openai' && apiKey ? { apiKey } : {}),
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
    if (!prompt.trim() || busyRef.current || unsaved || retry) return;
    if (!settings.model.trim() || !settings.endpoint.trim()) {
      setShowSettings(true);
      setError(t('请先填写模型名称与服务地址。'));
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

  async function saveAsNote(message: ChatMessage, index: number) {
    setError('');
    const original = conversation.messages
      .slice(0, index)
      .reverse()
      .find((item) => item.role === 'user');
    const note = createNote(scope, original?.text.slice(0, 48) || t('AI 研究笔记'), message.text);
    if (original?.context) note.sources = [captureSource(original.context, message.id)];
    note.aiMessageId = message.id;
    note.aiSessionId = conversation.id;
    if (await persistNote(store, note)) {
      setSavedNotes((items) => [...items, message.id]);
      setNotice(t('回答已保存到当前范围的研究笔记。'));
    } else setError(store.getState().error || t('笔记保存失败，请重试。'));
  }

  function selectConversation(id: string) {
    if (dirty || retry) return;
    const existing = history.find((item) => item.id === id);
    setConversation(existing ? asConversation(existing) : newConversation(scope));
    setError('');
    setNotice('');
    setSavedNotes([]);
  }

  return (
    <Panel
      className="sf-assistant-panel sf-project-assistant"
      role="region"
      aria-label={t('AI 助手内容')}
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
          setPrompt(value);
          composerRef.current?.focus();
        }}
      />
      <div className="sf-aux-toolbar sf-ai-conversation-toolbar">
        <h3>{t('Conversation')}</h3>
        <Dropdown
          aria-label={t('当前 AI 对话')}
          value={history.some((item) => item.id === conversation.id) ? conversation.id : ''}
          disabled={dirty || !!retry}
          onChange={(event) => selectConversation(event.target.value)}
        >
          {!history.some((item) => item.id === conversation.id) ? (
            <option value="">{t('New')}</option>
          ) : null}
          {history.map((item) => (
            <option value={item.id} key={item.id}>
              {String(item.title || t('历史对话'))}
            </option>
          ))}
        </Dropdown>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('新建 AI 对话')}
          title={dirty ? t('先发送或清空草稿，并保存对话') : t('新建 AI 对话')}
          disabled={dirty || !!retry}
          onClick={() => selectConversation('')}
        >
          <Plus size={16} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('模型设置')}
          title={t('模型设置')}
          aria-expanded={showSettings}
          onClick={() => setShowSettings(!showSettings)}
        >
          <Settings2 size={16} />
        </Button>
      </div>
      {showSettings ? (
        <form
          className="sf-ai-settings"
          onSubmit={(event) => {
            event.preventDefault();
            void saveSettings();
          }}
        >
          <label>
            {t('模型提供方')}
            <Dropdown
              disabled={busy}
              value={settings.provider}
              onChange={(event) => {
                setApiKey('');
                setSettings({
                  ...settings,
                  provider: event.target.value as AISettings['provider'],
                  endpoint:
                    event.target.value === 'ollama'
                      ? 'http://127.0.0.1:11434'
                      : 'https://api.openai.com/v1',
                });
              }}
            >
              <option value="ollama">{t('Ollama 本地模型')}</option>
              <option value="openai">{t('OpenAI 兼容服务')}</option>
            </Dropdown>
          </label>
          <label>
            {t('服务地址')}
            <Input
              type="url"
              required
              disabled={busy}
              value={settings.endpoint}
              placeholder="http://127.0.0.1:11434"
              onChange={(event) => {
                setApiKey('');
                setSettings({ ...settings, endpoint: event.target.value });
              }}
            />
          </label>
          <label>
            {t('模型名称')}
            <Input
              required
              disabled={busy}
              value={settings.model}
              placeholder={t('填写服务中的模型名称')}
              onChange={(event) => setSettings({ ...settings, model: event.target.value })}
            />
          </label>
          {settings.provider === 'openai' ? (
            <label>
              {t('API 密钥')}
              <Input
                type="password"
                autoComplete="off"
                disabled={busy}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={t('仅在本次应用会话中使用')}
              />
            </label>
          ) : null}
          <small>{t('只保存地址和模型名称。密钥不写入工作区。')}</small>
          <Button variant="ghost" size="sm" type="submit" disabled={busy}>
            {t('保存模型配置')}
          </Button>
        </form>
      ) : null}
      <div className="sf-chat-messages sf-aux-scroll" aria-live="polite">
        {!conversation.messages.length ? (
          <div className="sf-ai-conversation-empty">{t('No conversation yet.')}</div>
        ) : (
          conversation.messages.map((message, index) => (
            <article key={message.id} className={`sf-chat-message sf-chat-${message.role}`}>
              <div className="sf-message-meta">
                <strong>{message.role === 'user' ? t('你') : t('AI 助手')}</strong>
                {message.context ? (
                  <span
                    title={`${message.context.capturedAt} · ${message.context.path || message.context.title}`}
                  >
                    {message.context.title}
                  </span>
                ) : null}
              </div>
              <Markdown>{message.text}</Markdown>
              {message.role === 'assistant' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="sf-note-from-answer"
                  disabled={savedNotes.includes(message.id)}
                  onClick={() => void saveAsNote(message, index)}
                >
                  {savedNotes.includes(message.id) ? <Check size={13} /> : <FilePlus2 size={13} />}
                  {savedNotes.includes(message.id) ? t('已存为笔记') : t('保存为笔记')}
                </Button>
              ) : null}
            </article>
          ))
        )}
        {busy ? (
          <div className="sf-ai-progress" role="status">
            {t('正在等待模型回答…')}
          </div>
        ) : null}
      </div>
      {notice ? (
        <div className="sf-aux-notice" role="status">
          {translateError(notice)}
        </div>
      ) : null}
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
        disabled={busy || unsaved || !!retry}
        model={settings.model}
        endpoint={settings.endpoint}
        includeContext={includeContext}
        onPromptChange={setPrompt}
        onSend={() => void send()}
        onConfigure={() => setShowSettings(true)}
      />
    </Panel>
  );
}
