import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AIModel } from './research';

export type ChatGPTAccount = {
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  /** A sign-in page is open in the browser. */
  waiting: boolean;
};
/** One usage window of the plan, such as five hours or a week. */
export type ChatGPTWindow = {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
} | null;
export type ChatGPTUsage = { primary: ChatGPTWindow; secondary: ChatGPTWindow };
export type ChatGPTSignIn = { success: boolean; error: string | null };

function command<T>(name: string): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('ChatGPT 账号只能在 Scientify 桌面应用中登录。'));
  return invoke<T>(name);
}

/** A ChatGPT plan signed in to the built-in Agent engine; requests use the person's own plan. */
export const chatgpt = {
  account: () => command<ChatGPTAccount>('chatgpt_account'),
  /** Opens the sign-in page in the browser; `signedIn` reports how it ended. */
  login: () => command<void>('chatgpt_login'),
  cancel: () => command<void>('chatgpt_login_cancel'),
  logout: () => command<void>('chatgpt_logout'),
  usage: () => command<ChatGPTUsage>('chatgpt_usage'),
  models: () => command<AIModel[]>('chatgpt_models'),
  signedIn: (callback: (event: ChatGPTSignIn) => void) =>
    isTauri()
      ? listen<ChatGPTSignIn>('chatgpt-account', (event) => callback(event.payload))
      : Promise.resolve(() => {}),
};
export type ChatGPTBackend = typeof chatgpt;
