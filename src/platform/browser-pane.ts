import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { localCommand } from './library';
export type BrowserTab = {
  id: string;
  projectId: string;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  error: string | null;
};

/** The first page shown by every embedded browser tab. */
export const DEFAULT_BROWSER_URL = 'https://www.google.com';

export const browserCommand = <T = void>(request: Record<string, unknown>) =>
  localCommand<T>('browser_command', { request });
export const browserEvents = (event: string, callback: (tab: BrowserTab) => void) =>
  isTauri() ? listen<BrowserTab>(event, (e) => callback(e.payload)) : Promise.resolve(() => {});

// All native layout commands use a single queue so a late show never overrides hide.
let tail = Promise.resolve();
export function browserLayout(request: Record<string, unknown>) {
  const next = tail.catch(() => {}).then(() => browserCommand(request));
  tail = next.catch(() => {});
  return next;
}
