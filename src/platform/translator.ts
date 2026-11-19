import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Where a paper's full-text translation stands. */
export type TranslationStatus = {
  state: 'done' | 'translating' | 'waiting';
  /** 0–100 while translating. */
  progress: number;
};
export type TranslationEvent = {
  projectId: string;
  fingerprint: string;
  status: TranslationStatus;
};

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('全文翻译只能在 Scientify 桌面应用中使用。'));
  return invoke<T>(name, args);
}

/**
 * BabelDOC full-text translation. It runs in the background by itself; opening a paper
 * in translation only moves that paper to the front.
 */
export const translator = {
  status: (projectId: string, paperId: string) =>
    command<TranslationStatus>('translation_status', { projectId, paperId }),
  open: (projectId: string, paperId: string) =>
    command<TranslationStatus>('translation_open', { projectId, paperId }),
  pdf: async (projectId: string, paperId: string) =>
    new Uint8Array(await command<ArrayBuffer>('translation_pdf', { projectId, paperId })),
  events: (callback: (event: TranslationEvent) => void) =>
    isTauri()
      ? listen<TranslationEvent>('translation-progress', (event) => callback(event.payload))
      : Promise.resolve(() => {}),
};
export type Translator = typeof translator;
