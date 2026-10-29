import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type WindowAction =
  { type: 'takeConversations' } | { type: 'conversationReply'; id: string; result: unknown };

export function translationWindow<T = void>(action: WindowAction) {
  return invoke<T>('translation_window', { action });
}

/** Register before reading pending data so a window boot cannot lose the first event. */
export function watchTranslationWindow(
  event: 'translation-conversation-request',
  refresh: () => Promise<void>,
  onError: (reason: unknown) => void,
) {
  if (!isTauri()) return () => undefined;
  let disposed = false;
  let stop: (() => void) | undefined;
  let pending = false;
  let running = false;
  const run = async () => {
    pending = true;
    if (running) return;
    running = true;
    try {
      while (pending && !disposed) {
        pending = false;
        await refresh();
      }
    } catch (reason) {
      if (!disposed) onError(reason);
    } finally {
      running = false;
    }
  };
  void listen(event, () => void run())
    .then((unlisten) => {
      if (disposed) unlisten();
      else {
        stop = unlisten;
        void run();
      }
    })
    .catch((reason: unknown) => {
      if (!disposed) onError(reason);
    });
  return () => {
    disposed = true;
    stop?.();
  };
}
