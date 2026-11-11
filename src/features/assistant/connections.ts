import { isTauri } from '@tauri-apps/api/core';
import { t } from '../../i18n';
import { collaboration } from '../../platform/collaboration';
import { nativeCredentials, type CredentialBackend } from '../../platform/credentials';
import type { ModelProfile, Workspace } from '../../domain/workspace';
import type { AISettings } from './model';

/** Shared by the assistant's model dialog and Settings → AI 模型. */
export function connectionProfile(value: AISettings, id: string, name: string): ModelProfile {
  return { ...value, id, name: (name.trim() || value.serviceId || value.model).slice(0, 80) };
}

/** Read the key this machine holds for a connection; the official service uses the session token. */
export async function loadConnectionKey(
  value: Pick<AISettings, 'provider' | 'endpoint' | 'serviceId'>,
  credentials: CredentialBackend = nativeCredentials,
) {
  if (value.serviceId === 'scientify') return collaboration.accessToken();
  if (credentials === nativeCredentials && !isTauri()) return '';
  return (
    (await credentials.load({ provider: value.provider, endpoint: value.endpoint.trim() })) ?? ''
  );
}

/** Put the key in its machine-only slot before the connection is persisted. */
export async function storeConnectionKey(
  value: AISettings,
  key: string,
  credentials: CredentialBackend = nativeCredentials,
) {
  try {
    if (value.serviceId === 'scientify') {
      // The server access token is short-lived and stays in memory; never
      // persist it in the provider credential store.
      await collaboration.accessToken();
    } else if (key.trim())
      await credentials.save({ provider: value.provider, endpoint: value.endpoint }, key.trim());
    else if (value.provider !== 'ollama') throw new Error(t('请填写 API 密钥。'));
    else await credentials.clear({ provider: value.provider, endpoint: value.endpoint });
  } catch (reason) {
    // The browser preview has no credential store.
    if (credentials !== nativeCredentials || isTauri()) throw reason;
  }
}

/** Save a connection and make it the default for new chats. */
export function applyConnection(workspace: Workspace, value: AISettings, profile: ModelProfile) {
  const previous = workspace.settings.model;
  const previousSelection = {
    profileId: workspace.settings.defaultModelProfileId ?? 'legacy',
    settings: { ...previous, provider: previous.provider ?? 'ollama' },
  };
  // Existing chats keep the connection they were using.
  for (const chat of workspace.sessions) chat.modelSelection ??= structuredClone(previousSelection);
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
    recentModels: [...new Set([value.model.trim(), ...remembered])].filter(Boolean).slice(0, 12),
  };
  workspace.settings.modelProfiles ??= [];
  const index = workspace.settings.modelProfiles.findIndex((item) => item.id === profile.id);
  if (index < 0) workspace.settings.modelProfiles.push(profile);
  else workspace.settings.modelProfiles[index] = profile;
  workspace.settings.defaultModelProfileId = profile.id;
}

/** Remove a connection; chats that used it keep their own copy of the settings. */
export function removeConnection(workspace: Workspace, id: string) {
  workspace.settings.modelProfiles = (workspace.settings.modelProfiles ?? []).filter(
    (profile) => profile.id !== id,
  );
  if (workspace.settings.defaultModelProfileId === id)
    delete workspace.settings.defaultModelProfileId;
}

/** The settings of a saved connection, without its id and name. */
export function connectionSettings({ id: _id, name: _name, ...value }: ModelProfile): AISettings {
  return value;
}
