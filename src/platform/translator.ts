import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Where a paper's full-text translation stands. */
export type TranslationStatus = {
  state: 'idle' | 'queued' | 'preparing' | 'translating' | 'done' | 'failed';
  /** 0–100 while translating. */
  progress: number;
  message: string;
};
/** The model a translation calls: the assistant's, as the settings name it. */
export type TranslationModel = {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
};
export type TranslationEvent = {
  projectId: string;
  paperId: string;
  fingerprint: string;
  status: TranslationStatus;
};

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('全文翻译只能在 Scientify 桌面应用中使用。'));
  return invoke<T>(name, args);
}

/** BabelDOC full-text translation, run on this computer one paper at a time. */
export const translator = {
  status: (projectId: string, paperId: string) =>
    command<TranslationStatus>('translation_status', { projectId, paperId }),
  request: (projectId: string, paperId: string, model: TranslationModel, force = false) =>
    command<TranslationStatus>('translation_request', { projectId, paperId, model, force }),
  cancel: (projectId: string, paperId: string) =>
    command<void>('translation_cancel', { projectId, paperId }),
  pdf: async (projectId: string, paperId: string) =>
    new Uint8Array(await command<ArrayBuffer>('translation_pdf', { projectId, paperId })),
  events: (callback: (event: TranslationEvent) => void) =>
    isTauri()
      ? listen<TranslationEvent>('translation-progress', (event) => callback(event.payload))
      : Promise.resolve(() => {}),
};
export type Translator = typeof translator;
