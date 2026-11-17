// In-app updates. Release builds carry the address of the preview channel's
// manifest (src-tauri/tauri.updater.conf.json, written by
// scripts/publish-installer.mjs); Tauri's updater fetches it, downloads the
// package and checks its signature against the key built into the app.
// Development builds have no address and never offer updates.
//
// The manifest's `rollout` (0–100) limits an update to that share of devices,
// decided by a hash of this device's id; asking from Settings ignores it
// unless the update has been stopped (0).

import { invoke, isTauri } from '@tauri-apps/api/core';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Update } from '@tauri-apps/plugin-updater';
import { t } from '../../i18n';

export type UpdatePhase =
  | 'off'
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export type UpdateSnapshot = {
  phase: UpdatePhase;
  version?: string;
  notes?: string;
  /** Bytes received and expected while downloading. */
  received?: number;
  total?: number;
  error?: string;
  checkedAt?: number;
  /** "稍后" hides the notice until the next check. */
  dismissed?: boolean;
};

export const updateStore = createStore<UpdateSnapshot>(() => ({ phase: 'idle' }));

export function useUpdate() {
  return useStore(updateStore);
}

const FIRST_CHECK = 10_000;
const EVERY = 6 * 3600_000;
const prefsKey = 'scientify.update';
const deviceKey = 'scientify.device';

type Prefs = { autoDownload: boolean; skipped?: string };

export function updatePrefs(): Prefs {
  try {
    const value = JSON.parse(localStorage.getItem(prefsKey) ?? '{}');
    return { autoDownload: value.autoDownload !== false, skipped: value.skipped };
  } catch {
    return { autoDownload: true };
  }
}

export function setUpdatePrefs(change: Partial<Prefs>) {
  try {
    localStorage.setItem(prefsKey, JSON.stringify({ ...updatePrefs(), ...change }));
  } catch {
    /* Preferences are a convenience. */
  }
}

function deviceId() {
  try {
    let id = localStorage.getItem(deviceKey);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(deviceKey, id);
    }
    return id;
  } catch {
    return 'device';
  }
}

/** This device's place, 0–99, in the rollout of `version`: stable per device and version. */
export function rolloutBucket(device: string, version: string) {
  let hash = 2166136261;
  for (const char of `${device}:${version}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

/** Whether a device in `bucket` gets an update rolled out to `rollout` percent. */
export function inRollout(rollout: unknown, bucket: number, manual: boolean) {
  const share = typeof rollout === 'number' && Number.isFinite(rollout) ? rollout : 100;
  if (share <= 0) return false;
  return manual || bucket < share;
}

/** What went wrong, for people. */
export function describeUpdateError(reason: unknown) {
  const text = String(reason instanceof Error ? reason.message : reason);
  if (/platform .* not found|was not found on the response/i.test(text))
    return t('新版本的安装包还在准备中，请稍后再试。');
  if (/signature/i.test(text)) return t('安装包签名校验失败，已停止更新。');
  if (/network|timed? ?out|dns|connect|request/i.test(text))
    return t('连不上更新服务器，请检查网络后重试。');
  return t('更新失败：{reason}', { reason: text });
}

let pending: Update | null = null;
let exitGuard: (() => Promise<boolean>) | null = null;
let checking: Promise<void> | null = null;

/** The window's close protection: saves drafts and asks about running AI tasks. */
export function setExitGuard(guard: (() => Promise<boolean>) | null) {
  exitGuard = guard;
}

function set(change: Partial<UpdateSnapshot>) {
  updateStore.setState(change);
}

/** Checks now. Automatic checks stay quiet when they fail; `manual` ones say why. */
export function checkForUpdates(manual = false): Promise<void> {
  const { phase } = updateStore.getState();
  if (phase === 'off' || phase === 'downloading' || phase === 'installing')
    return Promise.resolve();
  if (phase === 'ready' && !manual) return Promise.resolve();
  checking ??= run(manual).finally(() => (checking = null));
  return checking;
}

async function run(manual: boolean) {
  const before = updateStore.getState();
  if (manual) set({ phase: 'checking', error: undefined });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: 30_000 });
    const prefs = updatePrefs();
    const offered =
      update &&
      inRollout(
        (update.rawJson as { rollout?: unknown }).rollout,
        rolloutBucket(deviceId(), update.version),
        manual,
      ) &&
      (manual || prefs.skipped !== update.version);
    if (!update || !offered) {
      if (pending && before.phase === 'ready') {
        set({ phase: 'ready', checkedAt: Date.now() });
        return;
      }
      void update?.close();
      set({ phase: 'latest', version: undefined, notes: undefined, checkedAt: Date.now() });
      return;
    }
    if (pending && before.phase === 'ready' && before.version === update.version) {
      void update.close();
      set({ phase: 'ready', checkedAt: Date.now(), dismissed: false });
      return;
    }
    void pending?.close();
    pending = update;
    set({
      phase: 'available',
      version: update.version,
      notes: update.body?.trim() || undefined,
      checkedAt: Date.now(),
      dismissed: false,
      error: undefined,
    });
    if (prefs.autoDownload) await downloadUpdate();
  } catch (reason) {
    if (manual) set({ phase: 'error', error: describeUpdateError(reason) });
    else if (before.phase === 'checking') set({ phase: 'idle' });
    console.warn('Scientify update check failed', reason);
  }
}

/** Downloads the offered update in the background. */
export async function downloadUpdate() {
  const update = pending;
  if (!update || updateStore.getState().phase === 'downloading') return;
  set({ phase: 'downloading', received: 0, total: undefined, error: undefined });
  try {
    await update.download((event) => {
      if (event.event === 'Started') set({ total: event.data.contentLength });
      else if (event.event === 'Progress')
        set({ received: (updateStore.getState().received ?? 0) + event.data.chunkLength });
    });
    set({ phase: 'ready' });
  } catch (reason) {
    set({ phase: 'error', error: describeUpdateError(reason) });
  }
}

/**
 * Saves and closes everything as quitting would, then installs and restarts.
 * On Windows the installer takes over as soon as the app exits.
 */
export async function installUpdate() {
  const update = pending;
  if (!update) return;
  if (updateStore.getState().phase !== 'ready') {
    await downloadUpdate();
    if (updateStore.getState().phase !== 'ready') return;
  }
  if (exitGuard && !(await exitGuard())) return;
  set({ phase: 'installing' });
  try {
    await invoke('updates_prepare');
    await update.install();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (reason) {
    set({ phase: 'error', error: describeUpdateError(reason) });
  }
}

/** Never offers this version again on its own; asking from Settings still finds it. */
export function skipUpdate() {
  const { version } = updateStore.getState();
  if (version) setUpdatePrefs({ skipped: version });
  void pending?.close();
  pending = null;
  set({ phase: 'latest', version: undefined, notes: undefined, dismissed: false });
}

export function dismissUpdate() {
  set({ dismissed: true });
}

/** Starts the checks: once shortly after launch, then every six hours. */
export function startUpdateChecks(): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  void invoke<boolean>('updates_configured')
    .then((configured) => {
      if (stopped) return;
      if (!configured) {
        set({ phase: 'off' });
        return;
      }
      timer = setTimeout(() => void checkForUpdates(), FIRST_CHECK);
      interval = setInterval(() => void checkForUpdates(), EVERY);
    })
    .catch(() => set({ phase: 'off' }));
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(interval);
  };
}
