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
import { serviceFor } from '../assistant/providers';
import '../assistant/model-settings.css';

type Editing = { id: string; name: string; value: AISettings; key: string; stored: boolean };

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

  async function edit(profile: ModelProfile | null) {
    const current = ++ticket.current;
    const value: AISettings = profile
      ? connectionSettings(profile)
      : {
          provider: 'openai',
          serviceId: 'openai',
          endpoint: 'https://api.openai.com/v1',
          model: '',
        };
    setError('');
    setEditing({
      id: profile?.id ?? crypto.randomUUID(),
      name: profile?.name ?? t('新连接'),
      value,
      key: '',
      stored: false,
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
          {t('全部连接')}
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

  return (
    <div className="settings-models">
      <div className="settings-models-heading">
        <h3 className="settings-section-heading">{t('连接')}</h3>
        <Button type="button" disabled={busy} onClick={() => void edit(null)}>
          <Plus size={14} />
          {t('新建连接')}
        </Button>
      </div>
      {profiles.length ? (
        <ul className="settings-models-list">
          {profiles.map((profile) => {
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
                  <span data-tone={verified ? (verified.chat ? 'ok' : 'bad') : 'none'}>
                    {t('聊天')}
                  </span>
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
                    onClick={() => void edit(profile)}
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
          })}
        </ul>
      ) : (
        <p className="settings-note">{t('还没有连接模型。')}</p>
      )}
      {error ? (
        <p role="alert" className="error-text">
          {translateError(error)}
        </p>
      ) : null}
      <p className="settings-note">
        {t('只有你发出的消息和附件会发给模型服务；密钥只保存在这台电脑上。')}
      </p>
    </div>
  );
}
