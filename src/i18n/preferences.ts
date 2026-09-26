import { useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

export type Language = 'zh-CN' | 'en';
export type Theme = 'light' | 'dark' | 'system';
export type Preferences = { language: Language; theme: Theme };
export const preferenceKey = 'scientify.preferences.v1';
const defaults: Preferences = { language: 'zh-CN', theme: 'system' };
let snapshot = defaults;
let lastRaw: string | null | undefined;
const listeners = new Set<() => void>();
const sourceId = crypto.randomUUID();

export function getPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(preferenceKey);
    if (raw !== lastRaw) {
      lastRaw = raw;
      let value: Partial<Preferences> = {};
      try {
        value = JSON.parse(raw ?? '{}') ?? {};
      } catch {
        /* Optional preferences. */
      }
      snapshot = {
        language: value.language === 'en' ? 'en' : 'zh-CN',
        theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system',
      };
    }
  } catch {
    /* Retain the in-memory preference when browser storage is unavailable. */
  }
  return snapshot;
}

export function setPreferences(patch: Partial<Preferences>) {
  snapshot = { ...getPreferences(), ...patch };
  try {
    const raw = JSON.stringify(snapshot);
    localStorage.setItem(preferenceKey, raw);
    lastRaw = raw;
  } catch {
    /* Theme/language switching must also work in memory. */
  }
  listeners.forEach((listener) => listener());
  if (isTauri()) void emit('ui-preferences-changed', { ...snapshot, sourceId }).catch(() => {});
}

export function migrateTheme(theme: string | undefined) {
  try {
    if (!localStorage.getItem(preferenceKey) && ['light', 'dark', 'system'].includes(theme ?? ''))
      setPreferences({ theme: theme as Theme });
  } catch {
    /* No persistent preference is required to use the app. */
  }
}

let stopSync: (() => void) | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const sync = (event: StorageEvent) => {
      if (event.key === preferenceKey || event.key === null)
        listeners.forEach((notify) => notify());
    };
    window.addEventListener('storage', sync);
    let disposed = false;
    const native = isTauri()
      ? listen<Preferences & { sourceId?: string }>('ui-preferences-changed', ({ payload }) => {
          if (
            !payload ||
            payload.sourceId === sourceId ||
            !['zh-CN', 'en'].includes(payload.language) ||
            !['light', 'dark', 'system'].includes(payload.theme)
          )
            return;
          const next = { language: payload.language, theme: payload.theme };
          const raw = JSON.stringify(next);
          if (raw === lastRaw) return;
          snapshot = next;
          try {
            localStorage.setItem(preferenceKey, raw);
            lastRaw = raw;
          } catch {
            /* Memory fallback. */
          }
          listeners.forEach((notify) => notify());
        })
      : undefined;
    let unlisten: (() => void) | undefined;
    void native
      ?.then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    stopSync = () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener('storage', sync);
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopSync?.();
      stopSync = undefined;
    }
  };
}
export const usePreferences = () => useSyncExternalStore(subscribe, getPreferences, getPreferences);

export function applyAppearance(prefs: Preferences, systemDark: boolean) {
  document.documentElement.classList.toggle(
    'dark',
    prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark),
  );
  document.documentElement.lang = prefs.language;
}
