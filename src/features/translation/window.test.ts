import { afterEach, expect, it, vi } from 'vitest';
import { watchTranslationWindow } from './window';

const native = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
afterEach(() => vi.clearAllMocks());

it('reads pending data only after listening, and coalesces notifications during a read', async () => {
  let wake!: () => void;
  let registered!: (stop: () => void) => void;
  native.listen.mockImplementation((_event, callback) => {
    wake = callback;
    return new Promise((resolve) => {
      registered = resolve;
    });
  });
  let finish!: () => void;
  const refresh = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const onError = vi.fn();
  const unlisten = vi.fn();
  const stop = watchTranslationWindow('translation-assistant-handoff', refresh, onError);
  expect(refresh).not.toHaveBeenCalled();
  registered(unlisten);
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  wake();
  wake();
  expect(refresh).toHaveBeenCalledOnce();
  finish();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  stop();
  wake();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(unlisten).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

it('cleans up a late listener without consuming pending selection after unmount', async () => {
  let registered!: (stop: () => void) => void;
  native.listen.mockReturnValue(
    new Promise((resolve) => {
      registered = resolve;
    }),
  );
  const refresh = vi.fn();
  const unlisten = vi.fn();
  const stop = watchTranslationWindow('translation-assistant-handoff', refresh, vi.fn());
  stop();
  registered(unlisten);
  await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  expect(refresh).not.toHaveBeenCalled();
});
