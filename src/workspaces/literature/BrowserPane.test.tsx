import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { BrowserPane } from './BrowserPane';
import { DEFAULT_BROWSER_URL } from '../../platform/browser-pane';
const bridge = vi.hoisted(() => ({
  command: vi.fn(),
  layout: vi.fn(async () => {}),
  receive: undefined as ((tab: unknown) => void) | undefined,
}));
vi.mock('../../platform/browser-pane', () => ({
  DEFAULT_BROWSER_URL: 'https://www.google.com',
  browserCommand: bridge.command,
  browserLayout: bridge.layout,
  browserEvents: async (_event: string, receive: (tab: unknown) => void) => {
    bridge.receive = receive;
    return () => {
      bridge.receive = undefined;
    };
  },
}));
const initial = {
  id: 'web',
  projectId: 'p',
  url: '',
  title: '',
  loading: false,
  canBack: false,
  canForward: false,
  error: null,
};
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
beforeEach(() => {
  vi.clearAllMocks();
  bridge.command.mockImplementation(async (request: { op: string; address?: string }) =>
    request.op === 'snapshot' ? [initial] : { ...initial, url: request.address, loading: true },
  );
});
afterEach(() => cleanup());

it('opens Google by default, navigates entered addresses, and preserves text being edited during title updates', async () => {
  const user = userEvent.setup();
  render(<BrowserPane id="web" onChanged={() => {}} />);
  const address = screen.getByRole('textbox', { name: '网址或搜索词' });
  expect((address as HTMLInputElement).value).toBe(DEFAULT_BROWSER_URL);
  await waitFor(() =>
    expect(bridge.command).toHaveBeenCalledWith({
      op: 'navigate',
      id: 'web',
      address: DEFAULT_BROWSER_URL,
    }),
  );
  await user.clear(address);
  await user.type(address, 'https://example.com');
  await user.click(screen.getByRole('button', { name: '打开' }));
  expect(bridge.command).toHaveBeenCalledWith({
    op: 'navigate',
    id: 'web',
    address: 'https://example.com',
  });
  await user.clear(address);
  await user.type(address, 'next query');
  act(() =>
    bridge.receive?.({
      ...initial,
      url: 'https://example.com',
      title: 'Loaded title',
      canBack: true,
    }),
  );
  expect((address as HTMLInputElement).value).toBe('next query');
  expect((screen.getByRole('button', { name: '后退' }) as HTMLButtonElement).disabled).toBe(false);
});
it('hides native content when a modal appears and when the view unmounts', async () => {
  bridge.command.mockResolvedValueOnce([{ ...initial, url: 'https://example.com' }]);
  const result = render(<BrowserPane id="web" onChanged={() => {}} />);
  await waitFor(() =>
    expect(bridge.layout).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'layout', bounds: expect.objectContaining({ visible: true }) }),
    ),
  );
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  act(() => document.body.appendChild(dialog));
  await waitFor(() =>
    expect(bridge.layout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: 'layout',
        bounds: expect.objectContaining({ visible: false }),
      }),
    ),
  );
  dialog.remove();
  result.unmount();
  expect(bridge.layout).toHaveBeenLastCalledWith({ op: 'hideAll' });
});
it('keeps verification pages visible without hiding the view on HTTP errors or redirects', async () => {
  bridge.command.mockResolvedValueOnce([{ ...initial, url: 'https://www.google.com' }]);
  render(<BrowserPane id="web" onChanged={() => {}} />);
  await waitFor(() =>
    expect(bridge.layout).toHaveBeenLastCalledWith(
      expect.objectContaining({ op: 'layout', bounds: expect.objectContaining({ visible: true }) }),
    ),
  );
  bridge.layout.mockClear();
  act(() =>
    bridge.receive?.({ ...initial, url: 'https://www.google.com/sorry/index', error: 'HTTP 429' }),
  );
  expect(screen.getByRole('alert').textContent).toBe('HTTP 429');
  await waitFor(() =>
    expect(bridge.layout).toHaveBeenLastCalledWith(
      expect.objectContaining({ op: 'layout', bounds: expect.objectContaining({ visible: true }) }),
    ),
  );
  expect(bridge.layout).not.toHaveBeenCalledWith({ op: 'hideAll' });
  act(() => bridge.receive?.({ ...initial, url: 'https://www.google.com' }));
  expect(screen.queryByRole('alert')).toBeNull();
});
