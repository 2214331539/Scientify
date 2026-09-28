import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AIProtocol } from './research';

/**
 * Where one key is filed. A slot is the provider plus its endpoint, because two
 * endpoints of the same vendor are two accounts with two keys.
 */
export interface CredentialSlot {
  provider: AIProtocol;
  endpoint: string;
}

export interface CredentialBackend {
  save(slot: CredentialSlot, apiKey: string): Promise<void>;
  load(slot: CredentialSlot): Promise<string | null>;
  clear(slot: CredentialSlot): Promise<void>;
}

/**
 * Mirrors the slot rule in `src-tauri/src/credentials.rs`. Only used to cache
 * recalled keys in the panel, so a mismatch costs one extra read, not a wrong
 * key.
 */
export function credentialSlot(provider: AIProtocol, endpoint: string) {
  return `${provider.trim()}|${endpoint.trim().replace(/\/+$/, '')}`;
}

function command<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(new Error('浏览器预览没有本机凭据存储。'));
  }
  return invoke<T>(name, args);
}

/**
 * Keys live in one plaintext JSON file in the application data directory, next
 * to `workspace.json`, so they survive a restart and can be inspected or
 * deleted by hand. The file is outside the repository and is never sent
 * anywhere by this application.
 */
export const nativeCredentials: CredentialBackend = {
  async save({ provider, endpoint }, apiKey) {
    await command<void>('secret_save', { provider, endpoint, apiKey });
  },
  async load({ provider, endpoint }) {
    const stored = await command<string | null>('secret_load', { provider, endpoint });
    // Normalising here keeps "no key" a plain null for every caller.
    return stored ?? null;
  },
  async clear({ provider, endpoint }) {
    await command<void>('secret_clear', { provider, endpoint });
  },
};
