import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { ArrowLeft, Plus } from 'lucide-react';
import { Button } from '../../components/primitives';
import { confirmAction } from '../../components/prompts';
import { t, translateError } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import type { ModelProfile } from '../../domain/workspace';
import { collaboration } from '../../platform/collaboration';
import { nativeCredentials, type CredentialBackend } from '../../platform/credentials';
import { nativeResearch, type ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import type { AISettings } from '../assistant/model';
import { ModelConnectionForm } from '../assistant/ModelSettingsDialog';
import {
  applyConnection,
  connectionProfile,
  connectionSettings,
  loadConnectionKey,
  removeConnection,
  storeConnectionKey,
} from '../assistant/connections';
import { modelServices, serviceFor } from '../assistant/providers';
import { openUpgrade } from '../account/Upgrade';
import '../assistant/model-settings.css';

type Editing = {
  id: string;
  name: string;
  value: AISettings;
  key: string;
  stored: boolean;
  services: readonly string[];
};

/** The first split is who serves the model; other models are grouped by how they connect. */
const OFFICIAL = ['scientify'] as const;
const otherGroups = [
  {
    title: 'ChatGPT 账号',
    note: '用 ChatGPT 订阅登录，不需要密钥。',
    services: ['chatgpt'],
  },
  {
    title: 'API 服务商',
    note: '填自己申请的 API 密钥，用量由服务商计费。',
    services: [
      'openai',
      'anthropic',
      'gemini',
      'deepseek',
      'qwen',
      'moonshot',
      'doubao',
      'zhipu',
      'siliconflow',
      'openrouter',
    ],
  },
  { title: '本地模型', note: '在这台电脑上运行的 Ollama。', services: ['ollama'] },
  {
    title: '自定义服务',
    note: '其他兼容 OpenAI、Anthropic 或 Gemini 接口的服务。',
    services: ['custom'],
  },
] as const;

const isOfficial = (profile: ModelProfile) => serviceFor(profile).id === 'scientify';
const groupOf = (profile: ModelProfile) =>
  otherGroups.find((group) => (group.services as readonly string[]).includes(serviceFor(profile).id)) ??
  otherGroups[otherGroups.length - 1];

/** Settings → AI 模型: the same connections the assistant's model menu uses. */
export function ModelPreferences({
  store,
  backend = nativeResearch,
  credentials = nativeCredentials,
}: {
  store: WorkspaceStore;
  backend?: ResearchBackend;
  credentials?: CredentialBackend;
}) {
  const data = useStore(store, (state) => state.data);
  const busy = useStore(store, (state) => state.busy);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [officialEndpoint, setOfficialEndpoint] = useState('');
  const ticket = useRef(0);
  const settings = data?.settings;
  const saved = settings?.modelProfiles ?? [];
  // Before the first named connection, the workspace holds one unnamed one.
  const profiles: ModelProfile[] =
    saved.length || !settings?.model.model
      ? saved
      : [
          {
            ...settings.model,
            provider: settings.model.provider ?? 'ollama',
            id: 'legacy',
            name: t(
              serviceFor({ ...settings.model, provider: settings.model.provider ?? 'ollama' }).name,
            ),
          },
        ];
  const defaultId = settings?.defaultModelProfileId ?? (saved.length ? undefined : 'legacy');
  const defaultProfile = profiles.find((profile) => profile.id === defaultId);
  // Open on the side the default connection is on; a new user starts with the official models.
  const [kind, setKind] = useState<'official' | 'other'>(() =>
    defaultProfile && !isOfficial(defaultProfile) ? 'other' : 'official',
  );

  useEffect(() => {
    void collaboration
      .status()
      .then((current) => setOfficialEndpoint(current.endpoint))
      .catch(() => {});
  }, []);
  useEffect(() => {
    store.getState().setDirtySource('settings-model', !!editing);
    return () => store.getState().setDirtySource('settings-model', false);
  }, [editing, store]);

  async function edit(profile: ModelProfile | null, services: readonly string[]) {
    const current = ++ticket.current;
    const first = modelServices.find((item) => item.id === services[0]) ?? modelServices[0];
    const value: AISettings = profile
      ? connectionSettings(profile)
      : {
          provider: first.provider,
          serviceId: first.id,
          endpoint:
            first.id === 'scientify'
              ? officialEndpoint || first.endpoints[0]?.url || ''
              : (first.endpoints[0]?.url ?? ''),
          model: '',
        };
    setError('');
    setEditing({
      id: profile?.id ?? crypto.randomUUID(),
      name: profile?.name ?? (first.id === 'custom' ? t('新连接') : t(first.name)),
      value,
      key: '',
      stored: false,
      services,
    });
    try {
      const key = await loadConnectionKey(value, credentials);
      if (current === ticket.current)
        setEditing((draft) => (draft ? { ...draft, key, stored: !!key } : draft));
    } catch (reason) {
      if (current === ticket.current) setError(errorMessage(reason));
    }
  }

  async function save(value: AISettings, key: string) {
    if (!editing) return;
    setSaving(true);
    setError('');
    try {
      await storeConnectionKey(value, key, credentials);
      const profile = connectionProfile(value, editing.id, editing.name);
      if (
        !(await store.getState().update((workspace) => applyConnection(workspace, value, profile)))
      )
        throw new Error(store.getState().error ?? t('模型配置保存失败'));
      ++ticket.current;
      setEditing(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault(profile: ModelProfile) {
    setError('');
    const value = connectionSettings(profile);
    if (!(await store.getState().update((workspace) => applyConnection(workspace, value, profile))))
      setError(store.getState().error ?? t('模型配置保存失败'));
  }

  async function remove(profile: ModelProfile) {
    if (
      !(await confirmAction(
        t('删除连接“{name}”？已有对话保留原来的设置。', { name: profile.name }),
      ))
    )
      return;
    setError('');
    if (!(await store.getState().update((workspace) => removeConnection(workspace, profile.id))))
      setError(store.getState().error ?? t('模型配置保存失败'));
  }

  if (editing)
    return (
      <div className="settings-models">
        <Button
          type="button"
          variant="ghost"
          className="settings-models-back"
          disabled={saving}
          onClick={() => {
            ++ticket.current;
            setEditing(null);
          }}
        >
          <ArrowLeft size={14} />
          {kind === 'official' ? t('官方模型') : t('其他模型')}
        </Button>
        <ModelConnectionForm
          embedded
          profileId={editing.id}
          profileName={editing.name}
          onNameChange={(name) => setEditing((draft) => (draft ? { ...draft, name } : draft))}
          value={editing.value}
          apiKey={editing.key}
          keyStored={editing.stored}
          error={error}
          saving={saving}
          requestBusy={busy}
          backend={backend}
          services={editing.services}
          loadKey={(value) => loadConnectionKey(value, credentials)}
          onChange={(value) => {
            setError('');
            setEditing((draft) => (draft ? { ...draft, value } : draft));
          }}
          onKeyChange={(key) => {
            ++ticket.current;
            setEditing((draft) => (draft ? { ...draft, key, stored: false } : draft));
          }}
          onSave={save}
          onClose={() => {
            ++ticket.current;
            setEditing(null);
          }}
          officialEndpoint={officialEndpoint}
        />
      </div>
    );

  const row = (profile: ModelProfile, services: readonly string[]) => {
    const verified =
      profile.verification?.model === profile.model ? profile.verification : undefined;
    return (
      <li key={profile.id} className="settings-models-row">
        <div className="settings-models-name">
          <strong>{profile.name}</strong>
          <small>
            {t(serviceFor(profile).name)} · {profile.model || t('未选择模型')}
          </small>
        </div>
        <div className="settings-models-tags">
          {profile.id === defaultId ? <span data-tone="default">{t('默认')}</span> : null}
          <span data-tone={verified ? (verified.chat ? 'ok' : 'bad') : 'none'}>{t('聊天')}</span>
          <span data-tone={verified ? (verified.agent ? 'ok' : 'bad') : 'none'}>Agent</span>
        </div>
        <div className="settings-models-actions">
          {profile.id !== defaultId ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void makeDefault(profile)}
            >
              {t('设为默认')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void edit(profile, services)}
          >
            {t('编辑')}
          </Button>
          {profile.id !== 'legacy' ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void remove(profile)}
            >
              {t('删除')}
            </Button>
          ) : null}
        </div>
      </li>
    );
  };
  const official = profiles.filter(isOfficial);
  const others = profiles.filter((profile) => !isOfficial(profile));

  return (
    <div className="settings-models">
      <div className="sf-segmented settings-models-kinds" role="group" aria-label={t('模型来源')}>
        <Button
          variant="ghost"
          aria-pressed={kind === 'official'}
          onClick={() => setKind('official')}
        >
          {t('Scientify 官方模型')}
        </Button>
        <Button variant="ghost" aria-pressed={kind === 'other'} onClick={() => setKind('other')}>
          {t('其他模型')}
        </Button>
      </div>
      {kind === 'official' ? (
        <section className="settings-models-group" aria-label={t('Scientify 官方模型')}>
          <div className="settings-models-heading">
            <div>
              <h3 className="settings-section-heading">{t('Scientify 官方模型')}</h3>
              <p className="settings-note">
                {t('用 Scientify 账号直接使用，不需要密钥，按点数计费。免费版开放部分模型，个人专业版开放全部模型。')}
              </p>
            </div>
            <Button type="button" disabled={busy} onClick={() => void edit(null, OFFICIAL)}>
              <Plus size={14} />
              {t('添加')}
            </Button>
          </div>
          {official.length ? (
            <ul className="settings-models-list">{official.map((profile) => row(profile, OFFICIAL))}</ul>
          ) : (
            <p className="settings-note">{t('还没有添加官方模型。')}</p>
          )}
          <Button type="button" variant="ghost" className="settings-models-upgrade" onClick={() => openUpgrade()}>
            {t('升级到专业版')}
          </Button>
        </section>
      ) : (
        otherGroups.map((group) => {
          const items = others.filter((profile) => groupOf(profile) === group);
          return (
            <section key={group.title} className="settings-models-group" aria-label={t(group.title)}>
              <div className="settings-models-heading">
                <div>
                  <h3 className="settings-section-heading">{t(group.title)}</h3>
                  <p className="settings-note">{t(group.note)}</p>
                </div>
                <Button type="button" disabled={busy} onClick={() => void edit(null, group.services)}>
                  <Plus size={14} />
                  {t('添加')}
                </Button>
              </div>
              {items.length ? (
                <ul className="settings-models-list">{items.map((profile) => row(profile, group.services))}</ul>
              ) : null}
            </section>
          );
        })
      )}
      {error ? (
        <p role="alert" className="error-text">
          {translateError(error)}
        </p>
      ) : null}
      {kind === 'other' ? (
        <p className="settings-note">
          {t('只有你发出的消息和附件会发给模型服务；密钥只保存在这台电脑上。')}
        </p>
      ) : null}
    </div>
  );
}
