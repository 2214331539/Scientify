import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getPreferences, setPreferences, usePreferences } from './preferences';

const events = vi.hoisted(() => ({
  receive: undefined as undefined | ((event: { payload: unknown }) => void),
  emit: vi.fn(async (..._args: unknown[]) => {}),
  stop: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: events.emit,
  listen: vi.fn(async (_name, receive) => {
    events.receive = receive;
    return events.stop;
  }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

it('ignores a delayed echo from this window after a newer choice', async () => {
  render(<Probe />);
  await waitFor(() => expect(events.receive).toBeDefined());
  act(() => setPreferences({ language: 'en', theme: 'dark' }));
  const first = events.emit.mock.calls[0][1];
  act(() => setPreferences({ language: 'zh-CN', theme: 'light' }));
  act(() => events.receive?.({ payload: first }));
  expect(screen.getByText('zh-CN:light')).toBeTruthy();
  expect(events.emit).toHaveBeenCalledTimes(2);
});

function Probe() {
  const prefs = usePreferences();
  return (
    <output>
      {prefs.language}:{prefs.theme}
    </output>
  );
}

it('broadcasts a local preference change and applies another window without rebroadcasting', async () => {
  render(<Probe />);
  await waitFor(() => expect(events.receive).toBeDefined());
  act(() => setPreferences({ language: 'en', theme: 'dark' }));
  expect(screen.getByText('en:dark')).toBeTruthy();
  expect(events.emit).toHaveBeenCalledWith(
    'ui-preferences-changed',
    expect.objectContaining({
      language: 'en',
      theme: 'dark',
    }),
  );
  act(() => events.receive?.({ payload: { language: 'zh-CN', theme: 'light' } }));
  expect(screen.getByText('zh-CN:light')).toBeTruthy();
  expect(events.emit).toHaveBeenCalledTimes(1);
  act(() => events.receive?.({ payload: { language: 'invalid', theme: 'dark' } }));
  expect(getPreferences()).toEqual({ language: 'zh-CN', theme: 'light' });
  cleanup();
  await waitFor(() => expect(events.stop).toHaveBeenCalledTimes(1));
});
