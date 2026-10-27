import { t, translateError } from '../../i18n';
import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { Settings2, Paperclip } from 'lucide-react';
import { ContextPanel } from '../../components/ai/ContextPanel';
import { AssistantComposer, type ComposerCommand } from '../../components/ai/AssistantComposer';
import '../../components/ai/ai-panel.css';
import { Button } from '../../components/primitives';
import { ModelSettingsDialog } from './ModelSettingsDialog';
import { AssistantConversations, type AssistantMenu } from './AssistantConversations';
import { AssistantTranscript } from './AssistantTranscript';
import { getFileRuntime, reloadDirectorySessions } from '../../editor/sessions';
import { codeContext } from '../../workspaces/experiments/code-context';
import { Menu } from '../../components/primitives/Menu';
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
  type ApprovalDecision,
  type ApprovalRequest,
  type AgentSkillListing,
  type AgentSkillRef,
  type PermissionMode,
} from '../../platform/agent';
import type { AIProtocol, ResearchBackend } from '../../platform/research';
import {
  credentialSlot,
  nativeCredentials,
  type CredentialBackend,
} from '../../platform/credentials';
import type { WorkspaceStore } from '../../stores/workspace';
import type { ModelProfile } from '../../domain/workspace';
import { hasPendingWork, initialAgentSession } from './agent-session';
import { getAgentRuntime } from './agent-runtime';
import { getChatRuntime } from './chat-runtime';
import { readAttachment } from './attachments';
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
import { errorMessage } from '../../domain/errors';

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
  const selectedCodeRoot = useStore(codeContext, (state) => state.roots[scope]);
  const selectedExperimentId = useStore(codeContext, (state) => state.experiments[scope]);
  const model = data?.settings.model;
  const defaultSettings: AISettings = {
    endpoint: model?.endpoint ?? 'http://127.0.0.1:11434',
    model: model?.model ?? '',
    provider: model?.provider ?? 'ollama',
    serviceId: model?.serviceId,
    modelCatalog: model?.modelCatalog,
    verification: model?.verification,
  };
  const profiles = data?.settings.modelProfiles ?? [];
  const defaultSelection = {
    profileId: data?.settings.defaultModelProfileId ?? 'legacy',
    settings:
      profiles.find((profile) => profile.id === data?.settings.defaultModelProfileId) ??
      defaultSettings,
  };
  const [settings, setSettings] = useState<AISettings>(defaultSelection.settings);
  const verification =
    settings.verification?.model === settings.model &&
    (!settings.verification.endpoint ||
      credentialSlot(settings.provider, settings.endpoint) ===
        credentialSlot(
          settings.verification.provider ?? settings.provider,
          settings.verification.endpoint,
        ))
      ? settings.verification
      : undefined;
  const [editingProfileId, setEditingProfileId] = useState(defaultSelection.profileId);
  const [profileName, setProfileName] = useState('');
  const profileRecall = useRef(0);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [draftKey, setDraftKey] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [menu, setMenu] = useState<AssistantMenu | null>(null);
  const pinnedToBottom = useRef(true);

  const [credential, setCredential] = useState({ slot: '', key: '', stored: false });
  const selectedSlot = credentialSlot(settings.provider, settings.endpoint);
  // A key belongs to its endpoint even during an asynchronous session switch.
  const apiKey = credential.slot === selectedSlot ? credential.key : '';
  const keyStored = credential.slot === selectedSlot && credential.stored;
  const credentialsReady = credential.slot === selectedSlot || settings.provider === 'ollama';
  // Keys read back once per provider endpoint; a second open of the dialog must
  // not wait on the disk again.
  const keyCache = useRef(new Map<string, string>());
  const keyTicket = useRef(0);
  const [localConversation, setConversation] = useState<Conversation>(() => {
    const recent = data?.sessions
      .filter((item) => item.project === scope)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    const chat = recent ? asConversation(recent) : newConversation(scope);
    return { ...chat, modelSelection: chat.modelSelection ?? structuredClone(defaultSelection) };
  });
  const activeConversationId = useRef(localConversation.id);
  activeConversationId.current = localConversation.id;
  const [unsaved, setUnsaved] = useState(false);
  const savedConversation = data?.sessions.find(
    (item) => item.project === scope && item.id === localConversation.id,
  );
  const chatRuntime = getChatRuntime(store, backend);
  useSyncExternalStore(chatRuntime.subscribe, chatRuntime.getSnapshot);
  const chatTask = chatRuntime.get(scope, localConversation.id);
  const conversation = useMemo(() => {
    if (chatTask?.saveError && !chatTask.questionSaved) return chatTask.seed;
    const chat =
      savedConversation && !unsaved ? asConversation(savedConversation) : localConversation;
    return { ...chat, modelSelection: chat.modelSelection ?? localConversation.modelSelection };
  }, [savedConversation, unsaved, localConversation, chatTask?.saveError, chatTask?.questionSaved]);
  const runtime = getAgentRuntime(store, agent);
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const activeTask = runtime.get(scope, conversation.id);
  const chatPending = !!chatTask?.pending;
  const agentState = activeTask?.state ?? initialAgentSession;
  const agentPending = !!activeTask && (activeTask.starting || hasPendingWork(agentState));
  const [newDomain, setNewDomain] = useState<AgentDomain | null>(null);
  const domain =
    conversation.agentDomain ?? newDomain ?? domainForWorkspace(context.workspace) ?? 'code';
  const [prompt, updatePrompt] = useState('');
  const [attachments, updateAttachments] = useState<NonNullable<ChatMessage['attachments']>>([]);
  const [selectedSkills, setSelectedSkills] = useState<AgentSkillRef[]>([]);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const savingPermission = useRef(false);
  const skillCache = useRef(new Map<string, Promise<AgentSkillListing>>());
  const [skillListings, setSkillListings] = useState<
    Record<string, { loading: boolean; listing: AgentSkillListing }>
  >({});
  const attachmentValues = useRef(attachments);
  const pendingAttachments = useRef(0);
  function setAttachments(
    value: typeof attachments | ((current: typeof attachments) => typeof attachments),
  ) {
    // Reserve against the latest input, including drops before React renders.
    const next = typeof value === 'function' ? value(attachmentValues.current) : value;
    attachmentValues.current = next;
    updateAttachments(next);
  }
  const [attachmentReads, setAttachmentReads] = useState(0);
  const [preparingContexts, setPreparingContexts] = useState<string[]>([]);
  const preparing = useRef(new Set<string>());
  const preparingContext = preparingContexts.includes(conversation.id);
  const attachmentTicket = useRef(0);
  useEffect(
    () => () => {
      ++attachmentTicket.current;
    },
    [],
  );
  const drafts = useRef(new Map<string, string>());
  const draftChats = useRef(new Map<string, Conversation>());
  const [, refreshDrafts] = useState(0);
  function setPrompt(value: string) {
    drafts.current.set(activeConversationId.current, value);
    updatePrompt(value);
  }
  function attachImages(files: File[]) {
    if (files.length + attachmentValues.current.length + pendingAttachments.current > 4) {
      setError(t('每条消息最多附带 4 个文件。'));
      return;
    }
    const conversationId = activeConversationId.current;
    const ticket = attachmentTicket.current;
    setError('');
    pendingAttachments.current += files.length;
    setAttachmentReads((count) => count + 1);
    void Promise.all(files.map(readAttachment))
      .then((next) => {
        if (ticket !== attachmentTicket.current || conversationId !== activeConversationId.current)
          return;
        setAttachments((current) => [...current, ...next]);
      })
      .catch((reason) => {
        if (ticket === attachmentTicket.current && conversationId === activeConversationId.current)
          setError(safeError(reason));
      })
      .finally(() => {
        if (ticket === attachmentTicket.current) {
          pendingAttachments.current -= files.length;
          setAttachmentReads((count) => count - 1);
        }
      });
  }
  function restorePrompt(id: string, text: string) {
    const restored = [text, drafts.current.get(id)].filter(Boolean).join('\n\n');
    drafts.current.set(id, restored);
    if (activeConversationId.current === id) updatePrompt(restored);
    refreshDrafts((revision) => revision + 1);
  }
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = chatTask?.error && !chatTask.saveError && !chatPending ? chatTask.seed : null;
  const busyRef = useRef(false);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const agentProject = context.projectId;
  const agentConnection: AgentConnection = {
    endpoint: settings.endpoint,
    model: settings.model,
    provider: settings.provider,
    ...(apiKey ? { apiKey } : {}),
  };
  const savedHistory = (data?.sessions ?? []).filter((item) => item.project === scope);
  const history = [
    ...savedHistory,
    ...[...draftChats.current.values()].filter(
      (chat) => !savedHistory.some((saved) => saved.id === chat.id),
    ),
  ];
  const key = `assistant:${scope}`;
  const dirty =
    !!prompt.trim() ||
    !!attachments?.length ||
    !!selectedSkills.length ||
    attachmentReads > 0 ||
    [...drafts.current.values()].some((draft) => !!draft.trim()) ||
    unsaved;
  const conversationActionsDisabled =
    unsaved ||
    busy ||
    settingsBusy ||
    permissionSaving ||
    !!attachments?.length ||
    !!selectedSkills.length ||
    attachmentReads > 0;
  const needsReconnect = conversation.agentStatus === 'running' && !activeTask;
  const permission = conversation.agentPermission ?? 'ask';
  const permissionDisabled =
    busy ||
    settingsBusy ||
    permissionSaving ||
    preparingContext ||
    sandboxBusy ||
    agentPending ||
    chatPending ||
    !!activeTask?.saving ||
    !!activeTask?.saveError ||
    !!chatTask?.saving ||
    !!chatTask?.saveError ||
    unsaved ||
    needsReconnect;
  const skillsAvailable =
    !!agent.skills &&
    !!agentProject &&
    (agent !== nativeAgent || isTauri()) &&
    engineSupports(settings.provider);
  const skillRoot = conversation.agentCwd ?? (domain === 'code' ? selectedCodeRoot : undefined);
  const skillKey = JSON.stringify([scope, conversation.id, domain, skillRoot]);
  const skillListing = skillListings[skillKey];
  const selection = conversation.modelSelection;
  useEffect(() => {
    if (selection) setSettings(selection.settings);
  }, [selection]);
  useEffect(() => {
    store.getState().setDirtySource(key, dirty);
    onDirtyChange?.(dirty);
  }, [store, key, dirty, onDirtyChange]);
  const safeError = useCallback(
    (reason: unknown) => {
      const message = errorMessage(reason);
      return apiKey ? message.split(apiKey).join(t('[已隐藏密钥]')) : message;
    },
    [apiKey],
  );
  const loadSkills = useCallback(
    (refresh = false) => {
      if (!skillsAvailable || !agent.skills) return;
      const previous = skillCache.current.get(skillKey);
      if (previous && !refresh) return;
      setSkillListings((current) => ({
        ...current,
        [skillKey]: { loading: true, listing: { skills: [], errors: [] } },
      }));
      const request = agent.skills({
        projectId: scope,
        domain,
        conversationId: conversation.id,
        workspaceRoot: skillRoot,
      });
      skillCache.current.set(skillKey, request);
      void request
        .then((listing) => {
          if (skillCache.current.get(skillKey) === request)
            setSkillListings((current) => ({
              ...current,
              [skillKey]: { loading: false, listing },
            }));
        })
        .catch((reason) => {
          if (skillCache.current.get(skillKey) === request) {
            setSkillListings((current) => ({
              ...current,
              [skillKey]: { loading: false, listing: { skills: [], errors: [safeError(reason)] } },
            }));
          }
        });
    },
    [skillsAvailable, agent, skillKey, scope, domain, conversation.id, skillRoot, safeError],
  );
  const recallKey = useCallback(
    async (provider: AIProtocol, endpoint: string) => {
      const slot = credentialSlot(provider, endpoint);
      const remembered = keyCache.current.get(slot);
      if (remembered !== undefined) return remembered;
      if (credentials === nativeCredentials && !isTauri()) return '';
      const stored = (await credentials.load({ provider, endpoint: endpoint.trim() })) ?? '';
      keyCache.current.set(slot, stored);
      return stored;
    },
    [credentials],
  );
  // A saved key has to survive a restart, so fill the field from this machine
  // instead of asking for it again.
  useEffect(() => {
    const ticket = ++keyTicket.current;
    void recallKey(settings.provider, settings.endpoint)
      .then((stored) => {
        if (ticket === keyTicket.current)
          setCredential({ slot: selectedSlot, key: stored, stored: !!stored });
      })
      .catch((reason) => {
        if (ticket !== keyTicket.current) return;
        setCredential({ slot: selectedSlot, key: '', stored: false });
        setError(safeError(reason));
      });
    return () => {
      ++keyTicket.current;
    };
  }, [recallKey, settings.provider, settings.endpoint, selectedSlot, safeError]);
  useEffect(() => () => store.getState().setDirtySource(key, false), [store, key]);

  useEffect(() => {
    const onPrefill = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope: string;
          source?: string;
          translation?: string;
          question?: string;
        }>
      ).detail;
      if (detail?.scope !== scope || (!detail.source && !detail.translation)) return;
      const text = [
        detail.question ?? '请基于下面的原文和译文继续分析。',
        detail.source ? `原文：\n${detail.source}` : '',
        detail.translation ? `译文：\n${detail.translation}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      setPrompt(
        [drafts.current.get(activeConversationId.current), text].filter(Boolean).join('\n\n'),
      );
      requestAnimationFrame(() => composerRef.current?.focus());
    };
    window.addEventListener('scientify-assistant-prefill', onPrefill);
    return () => window.removeEventListener('scientify-assistant-prefill', onPrefill);
  }, [scope]);

  function openSettings() {
    ++profileRecall.current;
    setMenu(null);
    setSettingsDraft(settings);
    setEditingProfileId(conversation.modelSelection?.profileId ?? 'legacy');
    setProfileName(
      profiles.find((profile) => profile.id === conversation.modelSelection?.profileId)?.name ??
        settings.serviceId ??
        t('模型配置'),
    );
    setDraftKey(apiKey);
    setSettingsError('');
    setShowSettings(true);
  }
  function openMenu(kind: AssistantMenu['kind'], trigger: HTMLButtonElement) {
    const r = trigger.getBoundingClientRect();
    const upward = kind === 'models' || kind === 'permissions';
    setMenu({
      kind,
      anchor: {
        x: r.left,
        y: upward ? r.top - 6 : r.bottom + 4,
        placement: upward ? 'top' : 'bottom',
        trigger,
      },
    });
  }
  async function choosePermission(value: PermissionMode) {
    if (permissionDisabled || savingPermission.current) return;
    setMenu(null);
    if (value === permission) return;
    const id = conversation.id;
    savingPermission.current = true;
    setPermissionSaving(true);
    setError('');
    try {
      const saved = await store.getState().update((data) => {
        let entry = data.sessions.find((item) => item.id === id && item.project === scope);
        if (!entry) {
          entry = structuredClone(conversation);
          data.sessions.push(entry);
        }
        entry.agentPermission = value;
      });
      if (!saved && activeConversationId.current === id)
        setError(store.getState().error ?? t('权限保存失败，请重试。'));
    } finally {
      savingPermission.current = false;
      setPermissionSaving(false);
    }
  }
  const recentModels = Array.isArray(model?.recentModels)
    ? model.recentModels.filter((value): value is string => typeof value === 'string').slice(0, 12)
    : [];
  const models = [
    ...new Set([
      settings.model,
      ...(settings.modelCatalog ?? (model?.endpoint === settings.endpoint ? recentModels : [])),
    ]),
  ].filter(Boolean);
  async function saveSettings(value = settingsDraft, keyValue = draftKey) {
    if (
      settingsBusy ||
      busyRef.current ||
      agentPending ||
      chatPending ||
      activeTask?.saving ||
      chatTask?.saving
    )
      return;
    value = { ...value, endpoint: value.endpoint.trim(), model: value.model.trim() };
    if (!value.endpoint || !value.model) {
      setSettingsError(t('请先填写模型名称与服务地址。'));
      return;
    }
    setSettingsBusy(true);
    const profile: ModelProfile = {
      ...value,
      id: editingProfileId,
      name: (profileName.trim() || value.serviceId || value.model).slice(0, 80),
    };
    // Put the key in the existing machine-only slot before persisting the selection.
    try {
      if (keyValue.trim())
        await credentials.save(
          { provider: value.provider, endpoint: value.endpoint },
          keyValue.trim(),
        );
      else if (value.provider !== 'ollama') throw new Error(t('请填写 API 密钥。'));
      else await credentials.clear({ provider: value.provider, endpoint: value.endpoint });
    } catch (reason) {
      if (credentials !== nativeCredentials || isTauri()) {
        setSettingsBusy(false);
        setSettingsError(safeError(reason));
        return;
      }
    }
    const result = await store.getState().update((workspace) => {
      const previous = workspace.settings.model;
      const previousSelection = {
        profileId: workspace.settings.defaultModelProfileId ?? 'legacy',
        settings: { ...previous, provider: previous.provider ?? 'ollama' },
      };
      for (const chat of workspace.sessions)
        chat.modelSelection ??= structuredClone(previousSelection);
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
      workspace.settings.modelProfiles ??= [];
      const index = workspace.settings.modelProfiles.findIndex((item) => item.id === profile.id);
      if (index < 0) workspace.settings.modelProfiles.push(profile);
      else workspace.settings.modelProfiles[index] = profile;
      workspace.settings.defaultModelProfileId = profile.id;
      const chat = workspace.sessions.find(
        (item) => item.id === conversation.id && item.project === scope,
      );
      if (chat) chat.modelSelection = { profileId: profile.id, settings: value };
    });
    setSettingsBusy(false);
    if (result) {
      const stored = keyValue.trim();
      const slot = credentialSlot(value.provider, value.endpoint);
      // Remember before the effect above runs, so the panel cannot restore the
      // previous key for this endpoint.
      keyCache.current.set(slot, stored);
      setSettings(value);
      setConversation((chat) => ({
        ...chat,
        modelSelection: { profileId: profile.id, settings: value },
      }));
      setCredential({ slot, key: stored, stored: !!stored });
      setShowSettings(false);
      setError('');
    } else if (showSettings) setSettingsError(store.getState().error ?? t('模型配置保存失败'));
    else setError(store.getState().error ?? t('模型配置保存失败'));
  }

  async function reverifyConnection() {
    if (!backend.verifyModel || settingsBusy || !credentialsReady || agentPending || chatPending)
      return;
    const connection = { ...settings };
    const matches = (value: AISettings) =>
      value.model === connection.model &&
      value.provider === connection.provider &&
      value.endpoint.trim().replace(/\/$/, '') === connection.endpoint.trim().replace(/\/$/, '');
    setSettingsBusy(true);
    setError('');
    try {
      const result = await backend.verifyModel({ ...connection, apiKey });
      const verification = {
        ...result,
        model: connection.model,
        endpoint: connection.endpoint,
        provider: connection.provider,
        checkedAt: new Date().toISOString(),
      };
      const saved = await store.getState().update((workspace) => {
        const model = workspace.settings.model;
        if (matches({ ...model, provider: model.provider ?? 'ollama' }))
          model.verification = verification;
        for (const profile of workspace.settings.modelProfiles ?? [])
          if (matches(profile)) profile.verification = verification;
        for (const entity of workspace.sessions) {
          const chat = entity as Conversation;
          const tasks = store.getState().agentTasks;
          if (tasks[`${chat.project}:${chat.id}`] || tasks[`${chat.project}:${chat.id}:chat`])
            continue;
          if (chat.modelSelection && matches(chat.modelSelection.settings))
            chat.modelSelection.settings.verification = verification;
        }
      });
      if (!saved) throw new Error(store.getState().error ?? t('模型配置保存失败'));
      for (const chat of draftChats.current.values())
        if (chat.modelSelection && matches(chat.modelSelection.settings))
          chat.modelSelection.settings.verification = verification;
      setSettings((current) => (matches(current) ? { ...current, verification } : current));
      setConversation((chat) =>
        chat.modelSelection && matches(chat.modelSelection.settings)
          ? {
              ...chat,
              modelSelection: {
                ...chat.modelSelection,
                settings: { ...chat.modelSelection.settings, verification },
              },
            }
          : chat,
      );
    } catch (reason) {
      setError(safeError(reason));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function chooseModel(profileId: string, value: AISettings) {
    if (agentPending || chatPending || settingsBusy || activeTask?.saving || chatTask?.saving)
      return;
    const next = {
      ...conversation,
      modelSelection: { profileId, settings: structuredClone(value) },
    };
    if (savedConversation && !(await persistConversation(store, next))) {
      setError(store.getState().error ?? t('模型配置保存失败'));
      return;
    }
    setConversation(next);
    setSettings(value);
  }

  async function deleteProfile(id: string) {
    if (!(await confirmAction(t('删除此连接配置？已有会话保留原配置。')))) return;
    const saved = await store.getState().update((workspace) => {
      workspace.settings.modelProfiles = (workspace.settings.modelProfiles ?? []).filter(
        (profile) => profile.id !== id,
      );
      if (workspace.settings.defaultModelProfileId === id)
        delete workspace.settings.defaultModelProfileId;
    });
    if (!saved) setSettingsError(store.getState().error ?? t('模型配置保存失败'));
  }

  async function saveConversation(value = conversation) {
    const success = await persistConversation(store, value);
    setUnsaved(!success);
    if (!success) setError(store.getState().error || t('对话保存失败，内容仍保留在当前面板。'));
    else setError('');
    return success;
  }

  async function runRequest(value: Conversation) {
    setError('');
    const sent = await chatRuntime.send(value, {
      endpoint: settings.endpoint,
      provider: settings.provider,
      model: settings.model,
      ...(apiKey ? { apiKey } : {}),
      messages: requestMessages(value),
    });
    if (activeConversationId.current === value.id) {
      setUnsaved(!sent && !!chatRuntime.get(scope, value.id)?.saveError);
      if (!sent)
        setError(
          chatRuntime.get(scope, value.id)?.saveError ??
            t('当前输入尚未发送，请在任务结束后重试。'),
        );
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
      } else workspace.sessions.push({ ...asConversation(item), title, updatedAt });
    });
    if (!saved) {
      setError(store.getState().error || t('对话重命名失败，请重试。'));
      return;
    }
    const draft = draftChats.current.get(id);
    if (draft) draftChats.current.set(id, { ...draft, title, updatedAt });
    if (activeConversationId.current === id)
      setConversation((current) => ({ ...current, title, updatedAt }));
  }

  async function deleteConversation(id: string) {
    if (conversationActionsDisabled) return;
    const item = history.find((entry) => entry.id === id);
    if (!item) return;
    const targetTask = runtime.get(scope, id);
    const targetChat = chatRuntime.get(scope, id);
    if (targetChat && (targetChat.pending || targetChat.saving || targetChat.saveError)) {
      setError(t('请先中止并等待此会话任务结束。'));
      return;
    }
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
    drafts.current.delete(id);
    chatRuntime.forget(scope, id);
    draftChats.current.delete(id);
    if (conversation.id !== id) return;
    const next = { ...newConversation(scope), modelSelection: structuredClone(defaultSelection) };
    activeConversationId.current = next.id;
    setConversation(next);
    setPrompt('');
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
    const boundRoot = conversation.agentCwd ?? (domain === 'code' ? selectedCodeRoot : undefined);
    if (domain === 'code') {
      const drafts = [...getFileRuntime(backend).sessions.values()].filter(
        (session) =>
          session.projectId === scope &&
          (session.workspaceRoot ?? '') === (boundRoot ?? '') &&
          session.getSnapshot().dirty,
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
    const submittedAttachments = attachments ?? [];
    const submittedSkills = selectedSkills;
    const snapshot = await captureContext(boundRoot);
    if (activeConversationId.current !== sendingId) return;
    const cleared = drafts.current.get(sendingId)?.trim() === text;
    if (cleared) setPrompt('');
    pinnedToBottom.current = true;
    const root = snapshot?.workspaceRoot ?? boundRoot;
    const seed = {
      ...conversation,
      ...(root ? { agentCwd: root } : {}),
      ...(domain === 'code'
        ? { experimentId: conversation.experimentId ?? selectedExperimentId }
        : {}),
    };
    const sent = await runtime.send(
      seed,
      domain,
      agentConnection,
      text,
      snapshot,
      submittedAttachments,
      submittedSkills,
    );
    if (sent === false) {
      if (cleared) restorePrompt(sendingId, text);
      if (activeConversationId.current === sendingId) {
        setError(store.getState().error ?? t('当前输入尚未发送，请在任务结束后重试。'));
      }
    } else if (activeConversationId.current === sendingId) {
      setAttachments((current) => current?.filter((item) => !submittedAttachments.includes(item)));
      setSelectedSkills((current) => current.filter((item) => !submittedSkills.includes(item)));
    }
  }

  async function captureContext(boundRoot?: string) {
    if (!includeContext) return undefined;
    const matches = context.browser
      ? context.projectId === scope
      : (!context.experimentId ||
          !conversation.experimentId ||
          context.experimentId === conversation.experimentId) &&
        (!context.workspaceRoot || !boundRoot || context.workspaceRoot === boundRoot) &&
        (!domainForWorkspace(context.workspace) ||
          domainForWorkspace(context.workspace) === domain);
    const visible = matches ? freezeContext(context) : undefined;
    if (!agent.context || !agentProject || (agent === nativeAgent && !isTauri())) return visible;
    const discovered = await agent.context({
      projectId: scope,
      domain,
      conversationId: conversation.id,
      workspaceRoot: boundRoot,
      ...(visible ? { path: visible.path, resourceId: visible.resourceId } : {}),
    });
    return {
      ...(visible ??
        freezeContext({
          workspace: domain === 'code' ? 'experiments' : 'literature',
          title: t('当前会话工作区'),
          projectId: scope,
        })),
      workspaceRoot: discovered.root,
      materials: discovered.materials,
      warnings: discovered.warnings,
    };
  }

  async function send() {
    const sendingId = conversation.id;
    if (preparing.current.has(sendingId)) return;
    preparing.current.add(sendingId);
    setPreparingContexts([...preparing.current]);
    try {
      await submitMessage();
    } catch (reason) {
      if (activeConversationId.current === sendingId) setError(safeError(reason));
    } finally {
      preparing.current.delete(sendingId);
      setPreparingContexts([...preparing.current]);
    }
  }

  async function submitMessage() {
    if (
      (!prompt.trim() && !attachments?.length) ||
      busyRef.current ||
      settingsBusy ||
      savingPermission.current ||
      attachmentReads > 0 ||
      !credentialsReady ||
      agentPending ||
      chatPending ||
      chatTask?.saving ||
      chatTask?.saveError ||
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
    if (unsaved) return;
    if (selectedSkills.length) {
      setError(t('技能需要内置 Agent 执行，当前连接仅支持聊天。请更换连接或移除技能。'));
      return;
    }
    if (verification && !verification.chat) {
      setError(t('此连接未通过聊天验证，请进入项目使用 Agent 或更换模型。'));
      return;
    }
    if (
      !settings.model.trim() ||
      !settings.endpoint.trim() ||
      (settings.provider !== 'ollama' && !apiKey)
    ) {
      openSettings();
      return;
    }
    const sendingId = conversation.id;
    const submittedAttachments = attachments ?? [];
    const snapshot = await captureContext(
      conversation.agentCwd ?? (domain === 'code' ? selectedCodeRoot : undefined),
    );
    if (activeConversationId.current !== sendingId) return;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: prompt.trim(),
      createdAt: new Date().toISOString(),
      ...(snapshot ? { context: snapshot } : {}),
      ...(attachments?.length ? { attachments: structuredClone(attachments) } : {}),
    };
    pinnedToBottom.current = true;
    const next: Conversation = {
      ...conversation,
      ...(snapshot?.workspaceRoot ? { agentCwd: snapshot.workspaceRoot, agentDomain: domain } : {}),
      title: conversation.messages.length
        ? conversation.title
        : prompt.trim().slice(0, 36) || submittedAttachments[0]?.name || t('新对话'),
      messages: [...conversation.messages, message],
      context: [...conversation.context, ...(snapshot ? [snapshot] : [])],
      updatedAt: new Date().toISOString(),
    };
    setConversation(next);
    if (drafts.current.get(sendingId)?.trim() === message.text) setPrompt('');
    setAttachments((current) => current?.filter((item) => !submittedAttachments.includes(item)));
    await runRequest(next);
  }

  function selectConversation(
    id: string,
    currentPrompt = prompt,
    binding?: Pick<Conversation, 'agentDomain' | 'agentCwd' | 'modelSelection'>,
  ) {
    if (conversationActionsDisabled) return;
    pinnedToBottom.current = true;
    const existing = store
      .getState()
      .data?.sessions.find((item) => item.id === id && item.project === scope);
    drafts.current.set(conversation.id, currentPrompt);
    draftChats.current.set(conversation.id, conversation);
    const next = existing
      ? asConversation(existing)
      : (draftChats.current.get(id) ?? {
          ...newConversation(scope),
          modelSelection: structuredClone(defaultSelection),
          ...binding,
        });
    next.modelSelection ??= structuredClone(defaultSelection);
    activeConversationId.current = next.id;
    setConversation(next);
    setPrompt(drafts.current.get(next.id) ?? '');
    setAttachments([]);
    setSelectedSkills([]);
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

  async function decideApproval(approval: ApprovalRequest, decision: ApprovalDecision) {
    if (approval.method === 'scientify/git/requestApproval' && decision === 'accept') {
      const params = approval.params as {
        cwd?: string;
        request?: { kind?: string; target?: string };
      };
      const target =
        params.request?.kind === 'worktree-remove' ? params.request.target : params.cwd;
      const drafts = [...getFileRuntime(backend).sessions.values()].filter(
        (file) =>
          file.projectId === scope && (!file.workspaceRoot || file.workspaceRoot === target),
      );
      if (
        drafts.some(
          (file) =>
            file.getSnapshot().dirty || ['loading', 'saving'].includes(file.getSnapshot().phase),
        )
      ) {
        setError(t('此目录有未保存或正在读写的文件，请先保存后再批准 Git 操作。'));
        return;
      }
    }
    await activeTask?.session.decide(approval, decision);
    if (approval.method === 'scientify/git/requestApproval')
      await reloadDirectorySessions(backend, scope, agentState.cwd ?? undefined);
  }

  async function interruptAgent() {
    if (chatTask?.pending) {
      await chatRuntime.cancel(chatTask);
      return;
    }
    const session = activeTask?.session;
    if (!session) return;
    setError('');
    if (!(await session.interrupt())) setError(session.state.error ?? t('中止任务失败，请重试。'));
  }
  async function steerAgent() {
    const text = prompt.trim();
    if (!activeTask || !text || activeTask.steering) return;
    const id = conversation.id;
    setPrompt('');
    if (!(await runtime.steer(activeTask, text))) {
      restorePrompt(id, text);
      if (activeConversationId.current === id) {
        setError(activeTask.session.state.error ?? t('补充指令未发送，请重试。'));
      }
    }
  }
  function runCommand(command: ComposerCommand) {
    if (command === 'context') setShowContext(true);
    else if (command === 'new') selectConversation('', '');
    else if (command === 'stop') void interruptAgent();
  }

  useEffect(() => {
    const onNewConversation = () => {
      if (!document.querySelector('.sf-dock-session:not([hidden]) .sf-assistant-panel')) return;
      if (!conversationActionsDisabled) selectConversation('', '');
    };
    window.addEventListener('scientify-new-conversation', onNewConversation);
    return () => window.removeEventListener('scientify-new-conversation', onNewConversation);
  }, [conversationActionsDisabled, selectConversation]);

  return (
    <Panel
      className="sf-assistant-panel sf-project-assistant"
      role="region"
      aria-label={t('AI 助手内容')}
    >
      <AssistantConversations
        scope={scope}
        conversation={conversation}
        history={history}
        runtime={runtime}
        chatRuntime={chatRuntime}
        disabled={conversationActionsDisabled}
        menu={menu}
        onOpenMenu={openMenu}
        onCloseMenu={() => setMenu(null)}
        onSelect={selectConversation}
        onRename={renameConversation}
        onDelete={deleteConversation}
      />
      <Menu
        anchor={menu && menu.kind !== 'sessions' ? menu.anchor : null}
        label={
          menu?.kind === 'models'
            ? t('选择模型')
            : menu?.kind === 'permissions'
              ? t('执行权限')
              : t('对话选项')
        }
        onClose={() => setMenu(null)}
      >
        {menu?.kind === 'permissions' ? (
          <>
            <div className="sf-ai-permission-note">
              {t('仅影响当前会话，下次任务生效。纯聊天连接不具备本地执行能力。')}
            </div>
            {(['ask', 'full'] as const).map((value) => (
              <Button
                key={value}
                role="menuitemradio"
                aria-checked={permission === value}
                variant="ghost"
                disabled={permissionDisabled}
                className="sf-ai-permission-option"
                onClick={() => void choosePermission(value)}
              >
                <strong>{value === 'ask' ? t('询问') : t('完全允许')}</strong>
                <span>
                  {value === 'ask'
                    ? t('在工作区沙箱内执行；需要提升权限及 Git 写操作时询问。')
                    : t('取消执行沙箱，允许访问工作区外文件和网络，不再询问执行审批。')}
                </span>
              </Button>
            ))}
          </>
        ) : menu?.kind === 'models' ? (
          <>
            {verification ? (
              <div className="sf-ai-model-verification" role="status">
                {verification.agent ? t('Agent 工具验证通过') : t('Agent 连接验证未通过')}
              </div>
            ) : null}
            {models.map((name) => (
              <Button
                key={name}
                role="menuitemradio"
                aria-checked={name === settings.model}
                variant="ghost"
                disabled={settingsBusy || busy}
                onClick={() => {
                  setMenu(null);
                  void chooseModel(conversation.modelSelection?.profileId ?? 'legacy', {
                    ...settings,
                    model: name,
                    verification:
                      settings.verification?.model === name ? settings.verification : undefined,
                  });
                }}
              >
                <span className="sf-ai-model-option">{name}</span>
              </Button>
            ))}
            {profiles
              .filter((profile) => profile.id !== conversation.modelSelection?.profileId)
              .map((profile) => (
                <Button
                  key={profile.id}
                  role="menuitemradio"
                  aria-checked={false}
                  variant="ghost"
                  onClick={() => {
                    setMenu(null);
                    void chooseModel(profile.id, profile);
                  }}
                >
                  <span className="sf-ai-model-option">
                    {profile.name} · {profile.model}
                  </span>
                </Button>
              ))}
            <Button role="menuitem" variant="ghost" onClick={openSettings}>
              <Settings2 size={14} />
              {t('配置其他模型')}
            </Button>
          </>
        ) : (
          <>
            {agentProject
              ? (['literature', 'code'] as const).map((option) => (
                  <Button
                    key={option}
                    role="menuitemradio"
                    aria-checked={domain === option}
                    variant="ghost"
                    disabled={!!conversation.agentDomain || agentPending}
                    onClick={() => {
                      setNewDomain(option);
                      setMenu(null);
                    }}
                  >
                    {option === 'literature' ? t('文献任务') : t('实验代码任务')}
                  </Button>
                ))
              : null}
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
            lastContext={
              [...conversation.messages].reverse().find((message) => message.context)?.context
            }
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
          loadKey={(value) => recallKey(value.provider, value.endpoint)}
          value={settingsDraft}
          profiles={profiles}
          profileId={editingProfileId}
          profileName={profileName}
          onNameChange={setProfileName}
          onProfileChange={async (profile) => {
            const ticket = ++profileRecall.current;
            const next = profile ?? { ...defaultSettings, model: '', modelCatalog: undefined };
            setEditingProfileId(profile?.id ?? crypto.randomUUID());
            setProfileName(profile?.name ?? t('新连接'));
            setSettingsDraft(next);
            setDraftKey('');
            try {
              const stored = await recallKey(next.provider, next.endpoint);
              if (ticket === profileRecall.current) setDraftKey(stored);
            } catch (reason) {
              if (ticket === profileRecall.current) setSettingsError(safeError(reason));
            }
          }}
          onDeleteProfile={deleteProfile}
          apiKey={draftKey}
          keyStored={keyStored}
          error={settingsError}
          saving={settingsBusy}
          requestBusy={busy || agentPending || chatPending}
          onChange={(value) => {
            setSettingsDraft(value);
            setSettingsError('');
          }}
          onKeyChange={(value) => {
            profileRecall.current++;
            setDraftKey(value);
          }}
          onSave={saveSettings}
          onClose={() => {
            ++profileRecall.current;
            setShowSettings(false);
          }}
        />
      )}
      <AssistantTranscript
        scope={scope}
        conversation={conversation}
        activeTask={activeTask}
        chatTask={chatTask}
        agentPending={agentPending}
        busy={busy}
        sandboxBusy={sandboxBusy}
        pinnedToBottom={pinnedToBottom}
        onSetupSandbox={agent.setupSandbox ? () => void setupWindowsSandbox() : undefined}
        onDecide={decideApproval}
      />
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
      {conversation.chatRun?.status === 'running' && !chatTask ? (
        <div className="sf-agent-sandbox-notice" role="status">
          {t('上次回答连接已断开，可以继续提问。')}
        </div>
      ) : null}
      {activeTask?.session.handle?.browserTools === false ? (
        <div className="sf-agent-sandbox-notice" role="status">
          {t('此历史会话保留原有工具。使用浏览器搜索与网页读取，请新建会话；原对话仍会保留。')}
        </div>
      ) : null}
      {activeTask?.session.handle?.paperTools === false && domain === 'literature' ? (
        <div className="sf-agent-sandbox-notice" role="status">
          {t('此历史会话尚未启用论文读取工具。请在同目录新建会话，原对话仍会保留。')}
          <Button
            variant="ghost"
            size="sm"
            disabled={conversationActionsDisabled}
            onClick={() =>
              selectConversation('', prompt, {
                agentDomain: 'literature',
                agentCwd: conversation.agentCwd ?? activeTask.session.handle?.cwd,
                modelSelection: conversation.modelSelection,
              })
            }
          >
            {t('新建会话')}
          </Button>
        </div>
      ) : null}
      {agentProject && verification && !verification.agent ? (
        <div className="sf-agent-sandbox-notice sf-agent-verification-notice" role="status">
          <span>
            {engineSupports(settings.provider)
              ? t('Agent 连接验证未通过。发送消息仍会尝试 Agent，不会自动降级为聊天。')
              : t('此连接协议尚未接入内置 Agent，请配置 OpenAI Responses 兼容连接。')}
            {verification.agentError && <small>{translateError(verification.agentError)}</small>}
          </span>
          {backend.verifyModel && (
            <Button
              variant="ghost"
              size="sm"
              disabled={settingsBusy || !credentialsReady || agentPending || chatPending}
              onClick={() => void reverifyConnection()}
            >
              {settingsBusy ? t('正在验证…') : t('重新验证')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={openSettings}>
            {t('模型设置')}
          </Button>
        </div>
      ) : null}
      {activeTask?.saving ? (
        <div className="sf-ai-task-status" role="status">
          {t('正在保存结果…')}
        </div>
      ) : null}
      {preparingContext && !agentPending && !chatPending ? (
        <div className="sf-ai-task-status" role="status">
          {t('正在准备材料…')}
        </div>
      ) : null}
      {error ||
      chatTask?.error ||
      chatTask?.saveError ||
      agentState.error ||
      activeTask?.saveError ||
      (!activeTask && conversation.agentRun?.error) ? (
        <div className="sf-aux-error" role="alert">
          {translateError(
            chatTask?.saveError ||
              chatTask?.error ||
              activeTask?.saveError ||
              error ||
              agentState.error ||
              conversation.agentRun?.error,
          )}
          <div>
            {chatTask?.saveError ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (await chatRuntime.retrySave(chatTask)) setUnsaved(false);
                }}
              >
                {t('重试保存对话')}
              </Button>
            ) : null}
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
                  chatRuntime.forget(scope, conversation.id);
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
          permissionSaving ||
          (preparingContext && !agentPending && !chatPending) ||
          attachmentReads > 0 ||
          !credentialsReady ||
          unsaved ||
          !!chatTask?.saving ||
          !!chatTask?.saveError ||
          !!activeTask?.saving ||
          !!activeTask?.saveError ||
          !!activeTask?.steering ||
          needsReconnect
        }
        isBusy={busy || agentPending || chatPending}
        canInterrupt={
          (agentPending && !!agentState.turnId && agentState.phase !== 'stopping') ||
          (chatPending && !!backend.streamAI && !chatTask.stopping)
        }
        canSteer={
          !!agent.steer && !!agentState.turnId && ['running', 'waiting'].includes(agentState.phase)
        }
        onSteer={() => void steerAgent()}
        model={settings.model}
        endpoint={settings.endpoint}
        onPromptChange={setPrompt}
        attachments={attachments ?? []}
        onAttach={attachImages}
        onRemoveAttachment={(index) =>
          setAttachments((current) => (current ?? []).filter((_, item) => item !== index))
        }
        onSend={() => void send()}
        onInterrupt={() => void interruptAgent()}
        modelMenuOpen={menu?.kind === 'models'}
        onModelMenu={(event) => openMenu('models', event.currentTarget)}
        permission={permission}
        permissionDisabled={permissionDisabled}
        permissionMenuOpen={menu?.kind === 'permissions'}
        onPermissionMenu={(trigger) => openMenu('permissions', trigger)}
        onCommand={runCommand}
        canNewConversation={!conversationActionsDisabled}
        skillsAvailable={skillsAvailable}
        skills={skillListing?.listing.skills ?? []}
        skillsLoading={skillListing?.loading ?? false}
        skillsErrors={skillListing?.listing.errors ?? []}
        onSkillsOpen={loadSkills}
        onSkillsRefresh={() => loadSkills(true)}
        selectedSkills={selectedSkills}
        shortcuts={data?.settings.shortcuts}
        onSelectSkill={(skill) =>
          setSelectedSkills((current) =>
            current.length < 4 && !current.some((item) => item.path === skill.path)
              ? [...current, skill]
              : current,
          )
        }
        onRemoveSkill={(index) =>
          setSelectedSkills((current) => current.filter((_, item) => item !== index))
        }
      />
    </Panel>
  );
}
